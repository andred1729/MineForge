import type { Position } from './domain.js';

const NATURAL_TREE_GROUND = new Set(['coarse_dirt', 'dirt', 'grass_block', 'mud', 'mycelium', 'podzol', 'rooted_dirt']);

const TREE_NEIGHBOR_OFFSETS: Position[] = [];
for (let x = -1; x <= 1; x += 1) {
  for (let y = -1; y <= 1; y += 1) {
    for (let z = -1; z <= 1; z += 1) {
      if (x !== 0 || y !== 0 || z !== 0) {
        TREE_NEIGHBOR_OFFSETS.push({ x, y, z });
      }
    }
  }
}

export interface TreeBlockSnapshot {
  name: string;
  position: Position;
}

export interface NaturalTree {
  logName: string;
  root: Position;
  logs: Position[];
}

export interface TreeWorld {
  blockAt(position: Position): TreeBlockSnapshot | null;
}

function positionKey(position: Position): string {
  return `${String(position.x)},${String(position.y)},${String(position.z)}`;
}

function offsetPosition({ position, offset }: { position: Position; offset: Position }): Position {
  return {
    x: position.x + offset.x,
    y: position.y + offset.y,
    z: position.z + offset.z,
  };
}

function distanceSquared({ left, right }: { left: Position; right: Position }): number {
  const dx = left.x - right.x;
  const dy = left.y - right.y;
  const dz = left.z - right.z;
  return dx * dx + dy * dy + dz * dz;
}

function expectedLeaves(logName: string): string | null {
  if (!logName.endsWith('_log') || logName.startsWith('stripped_')) {
    return null;
  }
  return `${logName.slice(0, -'_log'.length)}_leaves`;
}

function hasExpectedLeaves({
  world,
  logs,
  leavesName,
}: {
  world: TreeWorld;
  logs: Position[];
  leavesName: string;
}): boolean {
  const highestY = Math.max(...logs.map(log => log.y));
  const canopyLogs = logs.filter(log => log.y >= highestY - 2);
  for (const log of canopyLogs) {
    for (let x = -2; x <= 2; x += 1) {
      for (let y = -2; y <= 2; y += 1) {
        for (let z = -2; z <= 2; z += 1) {
          const block = world.blockAt({ x: log.x + x, y: log.y + y, z: log.z + z });
          if (block?.name === leavesName) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

function discoverConnectedLogs({
  world,
  start,
  logName,
  origin,
  maxDistance,
  withinBounds,
  maxLogs,
}: {
  world: TreeWorld;
  start: Position;
  logName: string;
  origin: Position;
  maxDistance: number;
  withinBounds: (position: Position) => boolean;
  maxLogs: number;
}): { logs: Position[]; clipped: boolean } {
  const queue = [start];
  const visited = new Set<string>();
  const logs: Position[] = [];
  let clipped = false;

  while (queue.length > 0 && logs.length <= maxLogs) {
    const current = queue.shift();
    if (current === undefined || visited.has(positionKey(current))) {
      continue;
    }
    visited.add(positionKey(current));
    const block = world.blockAt(current);
    if (block?.name !== logName) {
      continue;
    }
    if (!withinBounds(current) || distanceSquared({ left: origin, right: current }) > maxDistance * maxDistance) {
      clipped = true;
      continue;
    }
    logs.push(current);
    for (const offset of TREE_NEIGHBOR_OFFSETS) {
      const neighbor = offsetPosition({ position: current, offset });
      if (!visited.has(positionKey(neighbor))) {
        queue.push(neighbor);
      }
    }
  }

  if (logs.length > maxLogs || queue.length > 0) {
    clipped = true;
  }
  return { logs: logs.slice(0, maxLogs), clipped };
}

/**
 * Finds complete, naturally generated-looking trees instead of treating arbitrary
 * log blocks in player structures as lumber. A component touching the approved
 * boundary is rejected so harvesting never leaves half a tree behind.
 */
export function findNaturalTrees({
  world,
  candidates,
  logName,
  origin,
  maxDistance,
  withinBounds,
  maxLogsPerTree = 96,
}: {
  world: TreeWorld;
  candidates: Position[];
  logName: string;
  origin: Position;
  maxDistance: number;
  withinBounds: (position: Position) => boolean;
  maxLogsPerTree?: number;
}): NaturalTree[] {
  const leavesName = expectedLeaves(logName);
  if (leavesName === null) {
    return [];
  }

  const trees: NaturalTree[] = [];
  const processed = new Set<string>();
  const orderedCandidates = [...candidates].sort(
    (left, right) => distanceSquared({ left: origin, right: left }) - distanceSquared({ left: origin, right }),
  );
  for (const candidate of orderedCandidates) {
    if (processed.has(positionKey(candidate))) {
      continue;
    }
    const component = discoverConnectedLogs({
      world,
      start: candidate,
      logName,
      origin,
      maxDistance,
      withinBounds,
      maxLogs: maxLogsPerTree,
    });
    for (const log of component.logs) {
      processed.add(positionKey(log));
    }
    if (component.clipped || component.logs.length < 3) {
      continue;
    }

    const groundedLogs = component.logs.filter(log => {
      const below = world.blockAt({ x: log.x, y: log.y - 1, z: log.z });
      return below !== null && NATURAL_TREE_GROUND.has(below.name);
    });
    const root = groundedLogs.sort((left, right) => left.y - right.y)[0];
    if (root === undefined || !hasExpectedLeaves({ world, logs: component.logs, leavesName })) {
      continue;
    }

    trees.push({
      logName,
      root,
      logs: [...component.logs].sort((left, right) => left.y - right.y),
    });
  }
  return trees;
}
