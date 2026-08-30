import { createServer } from 'node:net';

import mineflayer, { type Bot } from 'mineflayer';
import pathfinderPlugin from 'mineflayer-pathfinder';
import prismarineItem from 'prismarine-item';
import prismarineViewer from 'prismarine-viewer';
import { Vec3 } from 'vec3';

import type { ActionProgress, MinecraftBotPort, NearbyBlock, NearbyEntity, WorldObservation } from './botPort.js';
import { splitChatMessage } from './chat.js';
import type { BlueprintBlock, Plan, Position } from './domain.js';
import {
  isVerifiedAnimalDrop,
  selectHuntableAnimals,
  type HuntableAnimal,
  type HuntCandidate,
  type HuntSpecies,
} from './hunting.js';
import { calculateNewItemCount, waitForItemCountAtLeast } from './inventory.js';
import { isPositionWithinPlanBounds } from './planStore.js';
import { findNaturalTrees, type NaturalTree, type TreeWorld } from './treeHarvest.js';

interface MineflayerBotOptions {
  host: string;
  port: number;
  username: string;
  version: string;
}

const { goals, Movements, pathfinder } = pathfinderPlugin;
const { mineflayer: startMineflayerViewer } = prismarineViewer;
const BOT_SPAWN_TIMEOUT_MS = 15_000;
const CONNECTION_THROTTLE_BACKOFF_MS = 5_000;

function integerPosition(position: Vec3): Position {
  return {
    x: Math.floor(position.x),
    y: Math.floor(position.y),
    z: Math.floor(position.z),
  };
}

function abortError(): Error {
  return new Error('Minecraft action was cancelled.');
}

export async function waitForBotSpawn(bot: Bot, username: string, timeoutMs = BOT_SPAWN_TIMEOUT_MS): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      bot.removeListener('spawn', handleSpawn);
      bot.removeListener('error', handleError);
      bot.removeListener('kicked', handleKicked);
      bot.removeListener('end', handleEnd);
    };
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    };
    const handleSpawn = () => {
      finish();
    };
    const handleError = (error: Error) => {
      finish(error);
    };
    const handleKicked = (reason: unknown) => {
      finish(new Error(`${username} was kicked before spawning: ${String(reason)}`));
    };
    const handleEnd = (reason: string) => {
      finish(new Error(`${username} disconnected before spawning: ${reason}`));
    };
    const timeout = setTimeout(() => {
      finish(new Error(`${username} did not spawn within ${String(timeoutMs / 1_000)} seconds.`));
    }, timeoutMs);
    bot.once('spawn', handleSpawn);
    bot.once('error', handleError);
    bot.once('kicked', handleKicked);
    bot.once('end', handleEnd);
  });
}

function isConnectionThrottled(caught: unknown): boolean {
  return caught instanceof Error && caught.message.toLowerCase().includes('connection throttled');
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw abortError();
  }
}

function hasAttachedVehicle(entity: { vehicle?: unknown }): boolean {
  return entity.vehicle !== null && entity.vehicle !== undefined;
}

export async function isTcpPortAvailable(port: number): Promise<boolean> {
  return await new Promise<boolean>(resolve => {
    const probe = createServer();
    probe.unref();
    probe.once('error', () => {
      resolve(false);
    });
    probe.listen(port, () => {
      probe.close(error => {
        resolve(error === undefined);
      });
    });
  });
}

async function wait({ milliseconds, signal }: { milliseconds: number; signal: AbortSignal }): Promise<void> {
  await abortablePause(signal, milliseconds);
}

function vectorMagnitude(vector: Vec3): number {
  return Math.sqrt(vector.x * vector.x + vector.y * vector.y + vector.z * vector.z);
}

async function abortablePause(signal: AbortSignal, milliseconds: number): Promise<void> {
  if (signal.aborted) {
    throw abortError();
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', handleAbort);
      resolve();
    }, milliseconds);
    const handleAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', handleAbort);
      reject(abortError());
    };
    signal.addEventListener('abort', handleAbort, { once: true });
    if (signal.aborted) {
      handleAbort();
    }
  });
}

export async function runCreativeFlight({
  bot,
  destination,
  signal,
  assertAuthorized,
  keepFlying = false,
}: {
  bot: Bot;
  destination: Vec3;
  signal: AbortSignal;
  assertAuthorized: () => void;
  keepFlying?: boolean;
}): Promise<void> {
  bot.creative.startFlying();
  let arrived = false;
  try {
    let vector = destination.minus(bot.entity.position);
    let magnitude = vectorMagnitude(vector);
    while (magnitude > 0.5) {
      if (signal.aborted) {
        throw abortError();
      }
      assertAuthorized();
      bot.physics.gravity = 0;
      bot.entity.velocity = new Vec3(0, 0, 0);
      bot.entity.position.add(vector.scaled(0.5 / magnitude));
      await abortablePause(signal, 50);
      vector = destination.minus(bot.entity.position);
      magnitude = vectorMagnitude(vector);
    }
    assertAuthorized();
    bot.entity.position = destination;
    await abortablePause(signal, 50);
    arrived = true;
  } finally {
    if (!arrived || !keepFlying) {
      bot.creative.stopFlying();
    }
  }
}

async function waitForBlockName({
  bot,
  target,
  expected,
  signal,
}: {
  bot: Bot;
  target: Vec3;
  expected: string;
  signal: AbortSignal;
}): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (signal.aborted) {
      throw abortError();
    }
    if (bot.blockAt(target)?.name === expected) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Minecraft did not confirm ${expected} at ${target.toString()}.`);
}

export async function runAbortable<T>({
  signal,
  operation,
  stop,
}: {
  signal: AbortSignal;
  operation: () => Promise<T>;
  stop: () => void;
}): Promise<T> {
  if (signal.aborted) {
    throw abortError();
  }

  return await new Promise<T>((resolve, reject) => {
    let aborted = false;
    const handleAbort = () => {
      if (aborted) {
        return;
      }
      aborted = true;
      stop();
    };
    signal.addEventListener('abort', handleAbort, { once: true });
    if (signal.aborted) {
      handleAbort();
    }
    void operation()
      .then(value => {
        if (aborted) {
          reject(abortError());
        } else {
          resolve(value);
        }
      })
      .catch((caught: unknown) => {
        reject(aborted ? abortError() : caught instanceof Error ? caught : new Error('Minecraft action failed.'));
      })
      .finally(() => {
        signal.removeEventListener('abort', handleAbort);
      });
  });
}

function withinMoveRange(position: Vec3, target: Position, range: number): boolean {
  const dx = position.x - target.x;
  const dy = position.y - target.y;
  const dz = position.z - target.z;
  return dx * dx + dy * dy + dz * dz <= range * range;
}

export async function navigateNear({
  bot,
  target,
  range,
}: {
  bot: Bot;
  target: Position;
  range: number;
}): Promise<void> {
  if (withinMoveRange(bot.entity.position, target, range)) {
    return;
  }

  let resolveProximity: (() => void) | undefined;
  const proximity = new Promise<void>(resolve => {
    resolveProximity = resolve;
  });
  const checkProximity = () => {
    if (withinMoveRange(bot.entity.position, target, range)) {
      resolveProximity?.();
    }
  };
  bot.on('physicsTick', checkProximity);
  const navigation = bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, range));
  try {
    const outcome = await Promise.race([
      navigation.then(() => 'goal' as const),
      proximity.then(() => 'proximity' as const),
    ]);
    if (outcome === 'proximity') {
      bot.pathfinder.stop();
      try {
        await navigation;
      } catch (caught) {
        if (!withinMoveRange(bot.entity.position, target, range)) {
          throw caught;
        }
      }
    }
  } finally {
    bot.removeListener('physicsTick', checkProximity);
  }
}

export class MineflayerBot implements MinecraftBotPort {
  private bot: Bot | null = null;
  private creativeFlightActive = false;
  private readonly chatListeners = new Set<(event: { username: string; message: string }) => void>();

  constructor(private readonly options: MineflayerBotOptions) {}

  async start(): Promise<void> {
    if (this.bot !== null) {
      return;
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const bot = mineflayer.createBot({
        host: this.options.host,
        port: this.options.port,
        username: this.options.username,
        auth: 'offline',
        version: this.options.version,
      });
      bot.loadPlugin(pathfinder);
      bot.on('chat', (username, message) => {
        for (const listener of this.chatListeners) {
          listener({ username, message });
        }
      });
      bot.on('error', error => {
        console.warn(`${this.options.username} Minecraft connection error`, error);
      });
      this.bot = bot;

      try {
        await waitForBotSpawn(bot, this.options.username);
        const movements = new Movements(bot);
        // Pathfinding is navigation only. World mutation must happen through the
        // explicitly authorized gather/build loops so it can be counted and stopped.
        movements.canDig = false;
        movements.allow1by1towers = false;
        movements.scafoldingBlocks = [];
        bot.pathfinder.setMovements(movements);
        return;
      } catch (caught) {
        lastError = caught;
        this.bot = null;
        bot.end('Connection failed');
        if (attempt < 2 && isConnectionThrottled(caught)) {
          console.warn(`${this.options.username} was connection-throttled; retrying in 5 seconds.`);
          await new Promise<void>(resolve => {
            setTimeout(resolve, CONNECTION_THROTTLE_BACKOFF_MS);
          });
          continue;
        }
        break;
      }
    }
    throw new Error('Could not connect ForgeBot to Minecraft.', { cause: lastError });
  }

  close(): Promise<void> {
    const bot = this.bot;
    this.bot = null;
    if (bot !== null) {
      bot.end('Minecraft bridge shutting down');
    }
    return Promise.resolve();
  }

  async startViewer(port: number): Promise<void> {
    if (!(await isTcpPortAvailable(port))) {
      console.warn(`Prismarine viewer port ${String(port)} is already in use; continuing without this viewer.`);
      return;
    }
    startMineflayerViewer(this.requireBot(), { port, firstPerson: false, viewDistance: 8 });
  }

  isConnected(): boolean {
    return this.bot?.entity !== undefined;
  }

  position(): Position {
    return integerPosition(this.requireBot().entity.position);
  }

  inspect({ radius }: { radius: number }): WorldObservation {
    const bot = this.requireBot();
    const center = integerPosition(bot.entity.position);
    const boundedRadius = Math.min(Math.max(radius, 1), 12);
    const blocks: NearbyBlock[] = [];
    const seenBlockNames = new Set<string>();

    blockScan: for (let x = center.x - boundedRadius; x <= center.x + boundedRadius; x += 1) {
      for (let y = center.y - 3; y <= center.y + 4; y += 1) {
        for (let z = center.z - boundedRadius; z <= center.z + boundedRadius; z += 1) {
          const block = bot.blockAt(new Vec3(x, y, z));
          if (block === null || block.name === 'air' || seenBlockNames.has(block.name)) {
            continue;
          }
          blocks.push({ name: block.name, position: { x, y, z } });
          seenBlockNames.add(block.name);
          if (blocks.length >= 64) {
            break blockScan;
          }
        }
      }
    }

    const entities: NearbyEntity[] = Object.values(bot.entities)
      .filter(entity => entity.id !== bot.entity.id && entity.position.distanceTo(bot.entity.position) <= boundedRadius)
      .slice(0, 32)
      .map(entity => ({
        id: entity.id,
        name: entity.username ?? entity.name ?? entity.displayName ?? 'unknown',
        kind: entity.type,
        distance: Math.round(entity.position.distanceTo(bot.entity.position) * 10) / 10,
        position: integerPosition(entity.position),
      }));

    return {
      connected: true,
      username: bot.username,
      position: center,
      health: bot.health,
      food: bot.food,
      dimension: bot.game.dimension,
      timeOfDay: bot.time.timeOfDay,
      isRaining: bot.isRaining,
      inventory: bot.inventory.items().map(item => ({ name: item.name, count: item.count })),
      nearbyBlocks: blocks,
      nearbyEntities: entities,
    };
  }

  locateNaturalTrees({
    blockName,
    maxDistance,
    plan,
  }: {
    blockName: string;
    maxDistance: number;
    plan?: Plan;
  }): NaturalTree[] {
    const bot = this.requireBot();
    const blockType = bot.registry.blocksByName[blockName];
    if (blockType === undefined) {
      throw new Error(`Unknown Minecraft block: ${blockName}`);
    }
    const origin = integerPosition(bot.entity.position);
    const positions = bot
      .findBlocks({ matching: blockType.id, maxDistance, count: 256 })
      .map(position => integerPosition(position));
    const world: TreeWorld = {
      blockAt: position => {
        const block = bot.blockAt(new Vec3(position.x, position.y, position.z));
        return block === null ? null : { name: block.name, position: integerPosition(block.position) };
      },
    };
    return findNaturalTrees({
      world,
      candidates: positions,
      logName: blockName,
      origin,
      maxDistance,
      withinBounds: position => plan === undefined || isPositionWithinPlanBounds({ plan, position }),
    });
  }

  locateAnimals({
    species,
    maxDistance,
    plan,
  }: {
    species: HuntSpecies;
    maxDistance: number;
    plan?: Plan;
  }): HuntableAnimal[] {
    const bot = this.requireBot();
    const origin = integerPosition(bot.entity.position);
    const candidates: HuntCandidate[] = Object.values(bot.entities).map(entity => {
      const registryEntity = entity.name === undefined ? undefined : bot.registry.entitiesByName[entity.name];
      const metadataKeys = registryEntity?.metadataKeys ?? [];
      const metadata = (key: string): unknown => {
        const index = metadataKeys.indexOf(key);
        return index === -1 ? undefined : entity.metadata[index];
      };
      return {
        id: entity.id,
        type: entity.type,
        ...(entity.name === undefined ? {} : { name: entity.name }),
        position: integerPosition(entity.position),
        registryIdentityMatches: registryEntity !== undefined && entity.entityType === registryEntity.id,
        customNamed: entity.getCustomName() !== null,
        baby: metadata('baby') === true,
        saddled: metadata('saddle') === true,
        attached: hasAttachedVehicle(entity),
        hasPassengers: entity.passengers.length > 0,
      };
    });
    return selectHuntableAnimals({
      candidates,
      species,
      origin,
      maxDistance,
      withinBounds: position => plan === undefined || isPositionWithinPlanBounds({ plan, position }),
    });
  }

  async moveTo({
    target,
    range,
    plan,
    signal,
    assertAuthorized,
  }: {
    target: Position;
    range: number;
    plan: Plan;
    signal: AbortSignal;
    assertAuthorized: () => void;
  }): Promise<void> {
    const bot = this.requireBot();
    await this.runBoundedPathfinder({
      plan,
      signal,
      assertAuthorized,
      navigate: async () => {
        await navigateNear({ bot, target, range });
      },
    });
  }

  async gather({
    blockName,
    count,
    maxDistance,
    plan,
    signal,
    assertAuthorized,
  }: {
    blockName: string;
    count: number;
    maxDistance: number;
    plan: Plan;
    signal: AbortSignal;
    assertAuthorized: () => void;
  }): Promise<ActionProgress> {
    const bot = this.requireBot();
    if (blockName.endsWith('_log') && !blockName.startsWith('stripped_')) {
      return await this.harvestTrees({ blockName, count, maxDistance, plan, signal, assertAuthorized });
    }
    const blockType = bot.registry.blocksByName[blockName];
    if (blockType === undefined) {
      throw new Error(`Unknown Minecraft block: ${blockName}`);
    }
    const itemType = bot.registry.itemsByName[blockName];
    if (itemType === undefined) {
      throw new Error(`${blockName} does not drop a same-named inventory item supported by gather_blocks.`);
    }

    const startingItemCount = bot.inventory.count(itemType.id, null);
    let completed = 0;
    const details: string[] = [];
    while (completed < count) {
      if (signal.aborted) {
        throw abortError();
      }
      assertAuthorized();
      const block = bot.findBlock({
        matching: blockType.id,
        useExtraInfo: candidate => {
          try {
            return isPositionWithinPlanBounds({ plan, position: integerPosition(candidate.position) });
          } catch {
            // Treat an unloaded runtime block as outside the approved plan.
            return false;
          }
        },
        maxDistance,
      });
      if (block === null) {
        break;
      }
      const itemCountBeforeDig = bot.inventory.count(itemType.id, null);
      await this.moveTo({ target: integerPosition(block.position), range: 2, plan, signal, assertAuthorized });
      const tool = bot.pathfinder.bestHarvestTool(block);
      if (tool !== null) {
        assertAuthorized();
        await runAbortable({
          signal,
          operation: async () => {
            await bot.equip(tool, 'hand');
          },
          stop: () => {
            // Mineflayer exposes no equip cancellation; serialization waits for it to settle.
          },
        });
      }
      assertAuthorized();
      await runAbortable({
        signal,
        operation: async () => {
          await bot.dig(block);
        },
        stop: () => {
          bot.stopDigging();
        },
      });
      await new Promise(resolve => setTimeout(resolve, 150));
      if (bot.inventory.count(itemType.id, null) <= itemCountBeforeDig) {
        const droppedItem = bot.nearestEntity(
          entity =>
            entity.name === 'item' &&
            entity.position.distanceTo(block.position) <= 4 &&
            isPositionWithinPlanBounds({ plan, position: integerPosition(entity.position) }),
        );
        if (droppedItem !== null) {
          try {
            await this.runBoundedPathfinder({
              plan,
              signal,
              assertAuthorized,
              navigate: async () => {
                await bot.pathfinder.goto(new goals.GoalFollow(droppedItem, 0));
              },
            });
          } catch (caught) {
            if (bot.inventory.count(itemType.id, null) <= itemCountBeforeDig) {
              throw caught;
            }
          }
        } else {
          await this.moveTo({
            target: integerPosition(block.position),
            range: 1,
            plan,
            signal,
            assertAuthorized,
          });
        }
      }
      const currentItemCount = await waitForItemCountAtLeast({
        readItemCount: () => bot.inventory.count(itemType.id, null),
        expectedItemCount: itemCountBeforeDig + 1,
        signal,
      });
      const nextCompleted = calculateNewItemCount({
        currentItemCount,
        expectedCount: count,
        startingItemCount,
      });
      details.push(
        `Mined ${blockName} at ${block.position.toString()}; collected ${String(nextCompleted)} of ${String(count)}`,
      );
      if (nextCompleted <= completed) {
        details.push('No matching inventory pickup was observed; stopping to avoid mining extra blocks.');
        break;
      }
      completed = nextCompleted;
    }
    return { requested: count, completed, details };
  }

  async harvestTrees({
    blockName,
    count,
    maxDistance,
    plan,
    signal,
    assertAuthorized,
  }: {
    blockName: string;
    count: number;
    maxDistance: number;
    plan: Plan;
    signal: AbortSignal;
    assertAuthorized: () => void;
  }): Promise<ActionProgress> {
    const bot = this.requireBot();
    const itemType = bot.registry.itemsByName[blockName];
    if (itemType === undefined) {
      throw new Error(`${blockName} cannot be collected as an inventory item.`);
    }
    const startingCount = bot.inventory.count(itemType.id, null);
    const details: string[] = [];

    while (bot.inventory.count(itemType.id, null) - startingCount < count) {
      if (signal.aborted) {
        throw abortError();
      }
      assertAuthorized();
      const tree = this.locateNaturalTrees({ blockName, maxDistance, plan })[0];
      if (tree === undefined) {
        break;
      }
      const treeStartingCount = bot.inventory.count(itemType.id, null);
      let mined = 0;
      for (const position of tree.logs) {
        assertAuthorized();
        const block = bot.blockAt(new Vec3(position.x, position.y, position.z));
        if (block?.name !== blockName) {
          continue;
        }
        if (!bot.canDigBlock(block)) {
          await this.moveTo({ target: position, range: 3, plan, signal, assertAuthorized });
        }
        const tool = bot.pathfinder.bestHarvestTool(block);
        if (tool !== null) {
          assertAuthorized();
          await runAbortable({
            signal,
            operation: async () => {
              await bot.equip(tool, 'hand');
            },
            stop: () => {
              // Mineflayer exposes no equip cancellation; serialization waits for it to settle.
            },
          });
        }
        assertAuthorized();
        await runAbortable({
          signal,
          operation: async () => {
            await bot.dig(block);
          },
          stop: () => {
            bot.stopDigging();
          },
        });
        mined += 1;
        await this.collectDrops({
          target: { x: position.x, y: tree.root.y, z: position.z },
          itemTypeId: itemType.id,
          previousCount: treeStartingCount,
          expectedIncrease: mined,
          plan,
          signal,
          assertAuthorized,
        });
      }

      await this.collectDrops({
        target: tree.root,
        itemTypeId: itemType.id,
        previousCount: treeStartingCount,
        expectedIncrease: mined,
        plan,
        signal,
        assertAuthorized,
      });
      const collected = bot.inventory.count(itemType.id, null) - treeStartingCount;
      details.push(
        `Harvested complete ${blockName} tree at ${String(tree.root.x)}, ${String(tree.root.y)}, ${String(tree.root.z)}: mined ${String(mined)}, verified ${String(collected)} collected.`,
      );
    }

    const completed = bot.inventory.count(itemType.id, null) - startingCount;
    details.push(`Verified ${String(completed)} total ${blockName} collected in inventory.`);
    return { requested: count, completed, details };
  }

  async huntAnimals({
    species,
    count,
    maxDistance,
    plan,
    signal,
    assertAuthorized,
  }: {
    species: HuntSpecies;
    count: number;
    maxDistance: number;
    plan: Plan;
    signal: AbortSignal;
    assertAuthorized: () => void;
  }): Promise<ActionProgress> {
    const bot = this.requireBot();
    const weapon = ['netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'wooden_axe', 'golden_axe']
      .map(itemName => bot.inventory.items().find(item => item.name === itemName))
      .find(item => item !== undefined);
    if (weapon === undefined) {
      throw new Error('The hunter requires an axe before hunting animals.');
    }
    assertAuthorized();
    await runAbortable({
      signal,
      operation: async () => {
        await bot.equip(weapon, 'hand');
      },
      stop: () => {
        bot.clearControlStates();
      },
    });

    const previousMovements = bot.pathfinder.movements;
    const huntingMovements = new Movements(bot);
    huntingMovements.canDig = false;
    huntingMovements.allow1by1towers = false;
    huntingMovements.allowParkour = false;
    huntingMovements.maxDropDown = 2;
    bot.pathfinder.setMovements(huntingMovements);

    let completed = 0;
    const details: string[] = [];
    try {
      while (completed < count) {
        if (signal.aborted) {
          throw abortError();
        }
        assertAuthorized();
        const animal = this.locateAnimals({ species, maxDistance, plan })[0];
        if (animal === undefined) {
          break;
        }
        const target = bot.entities[animal.id];
        if (!target?.isValid) {
          continue;
        }

        const inventoryBefore = this.animalDropInventory(species);
        let killed = false;
        let lastPosition = integerPosition(target.position);
        for (let attackNumber = 0; attackNumber < 16; attackNumber += 1) {
          assertAuthorized();
          if (!this.isEligibleAnimalTarget({ id: target.id, species, maxDistance, plan })) {
            break;
          }
          lastPosition = integerPosition(target.position);
          if (target.position.distanceTo(bot.entity.position) > 3) {
            await this.moveTo({
              target: lastPosition,
              range: 2,
              plan,
              signal,
              assertAuthorized,
            });
          }
          assertAuthorized();
          assertNotAborted(signal);
          if (!this.isEligibleAnimalTarget({ id: target.id, species, maxDistance, plan })) {
            break;
          }
          if (target.position.distanceTo(bot.entity.position) > 3.5) {
            continue;
          }

          await runAbortable({
            signal,
            operation: async () => {
              await bot.lookAt(target.position.offset(0, Math.max(target.height / 2, 0.5), 0), true);
            },
            stop: () => {
              bot.clearControlStates();
            },
          });
          assertAuthorized();
          assertNotAborted(signal);
          if (!this.isEligibleAnimalTarget({ id: target.id, species, maxDistance, plan })) {
            break;
          }
          killed = await this.attackAndWaitForDeath({ target, signal });
          if (killed) {
            break;
          }
        }
        if (!killed) {
          details.push(`Stopped pursuing ${species} ${String(target.id)} because a safe kill was not verified.`);
          break;
        }

        completed += 1;
        const drops = await this.collectAnimalDrops({
          species,
          target: lastPosition,
          before: inventoryBefore,
          plan,
          signal,
          assertAuthorized,
        });
        const evidence = drops.length === 0 ? 'no eligible drops reached inventory' : `collected ${drops.join(', ')}`;
        details.push(
          `Killed unnamed adult ${species} at ${String(lastPosition.x)}, ${String(lastPosition.y)}, ${String(lastPosition.z)}; ${evidence}.`,
        );
      }
    } finally {
      bot.pathfinder.setMovements(previousMovements);
    }

    return { requested: count, completed, details };
  }

  async craft({
    itemName,
    count,
    signal,
    assertAuthorized,
  }: {
    itemName: string;
    count: number;
    signal: AbortSignal;
    assertAuthorized: () => void;
  }): Promise<ActionProgress> {
    const bot = this.requireBot();
    const itemType = bot.registry.itemsByName[itemName];
    if (itemType === undefined) {
      throw new Error(`Unknown Minecraft item: ${itemName}`);
    }
    const craftingTableType = bot.registry.blocksByName['crafting_table'];
    const craftingTable =
      craftingTableType === undefined ? null : bot.findBlock({ matching: craftingTableType.id, maxDistance: 16 });
    const recipes = bot.recipesFor(itemType.id, null, 1, craftingTable);
    const recipe = recipes[0];
    if (recipe === undefined) {
      throw new Error(`No currently craftable recipe found for ${String(count)} ${itemName}.`);
    }
    const recipeCount = Math.ceil(count / recipe.result.count);
    const expectedOutputCount = recipeCount * recipe.result.count;

    if (bot.recipesFor(itemType.id, null, recipeCount, craftingTable).length === 0) {
      throw new Error(`Not enough ingredients to craft ${String(count)} ${itemName}.`);
    }

    const startingItemCount = bot.inventory.count(itemType.id, null);
    assertAuthorized();
    await runAbortable({
      signal,
      operation: async () => {
        await bot.craft(recipe, recipeCount, craftingTable ?? undefined);
      },
      stop: () => {
        bot.clearControlStates();
      },
    });
    const expectedItemCount = startingItemCount + expectedOutputCount;
    const currentItemCount = await waitForItemCountAtLeast({
      readItemCount: () => bot.inventory.count(itemType.id, null),
      expectedItemCount,
      signal,
    });
    if (currentItemCount < expectedItemCount) {
      throw new Error(
        `Craft completed but inventory did not report the expected ${String(expectedOutputCount)} ${itemName} within 5 seconds.`,
      );
    }
    return {
      requested: count,
      completed: expectedOutputCount,
      details: [`Crafted ${String(expectedOutputCount)} ${itemName}`],
    };
  }

  async executeBlueprint({
    origin,
    blocks,
    plan,
    signal,
    assertAuthorized,
  }: {
    origin: Position;
    blocks: BlueprintBlock[];
    plan: Plan;
    signal: AbortSignal;
    assertAuthorized: () => void;
  }): Promise<ActionProgress> {
    const bot = this.requireBot();
    const ordered = [...blocks].sort((left, right) => {
      if (left.block === 'air' && right.block !== 'air') {
        return -1;
      }
      if (left.block !== 'air' && right.block === 'air') {
        return 1;
      }
      return left.dy - right.dy;
    });
    let completed = 0;
    const details: string[] = [];

    try {
      for (const operation of ordered) {
        if (signal.aborted) {
          throw abortError();
        }
        assertAuthorized();
        const target = new Vec3(origin.x + operation.dx, origin.y + operation.dy, origin.z + operation.dz);
        let existing = bot.blockAt(target);
        if (existing?.name === operation.block || (operation.block === 'air' && existing?.name === 'air')) {
          completed += 1;
          continue;
        }

        await this.moveForBlueprintTarget({ target, plan, signal, assertAuthorized });
        existing = bot.blockAt(target);
        if (existing === null) {
          throw new Error(`Target chunk is not loaded at ${target.toString()}.`);
        }
        if (existing.name === operation.block || (operation.block === 'air' && existing.name === 'air')) {
          completed += 1;
          continue;
        }
        if (operation.block === 'air') {
          if (existing.name === 'air') {
            completed += 1;
            continue;
          }
          assertAuthorized();
          await runAbortable({
            signal,
            operation: async () => {
              await bot.dig(existing);
            },
            stop: () => {
              bot.stopDigging();
            },
          });
        } else {
          const item = await this.ensureBlueprintItem({ blockName: operation.block, signal, assertAuthorized });
          assertAuthorized();
          await runAbortable({
            signal,
            operation: async () => {
              await bot.equip(item, 'hand');
            },
            stop: () => {
              // Mineflayer exposes no equip cancellation; serialization waits for it to settle.
            },
          });
          const placement = this.findPlacementReference(target);
          if (placement === null) {
            throw new Error(`No supporting face is available to place ${operation.block} at ${target.toString()}.`);
          }
          assertAuthorized();
          await runAbortable({
            signal,
            operation: async () => {
              await bot.placeBlock(placement.reference, placement.face);
            },
            stop: () => {
              bot.clearControlStates();
            },
          });
          await waitForBlockName({ bot, target, expected: operation.block, signal });
        }
        completed += 1;
        details.push(`${operation.block} at ${target.toString()}`);
      }
    } finally {
      if (this.creativeFlightActive) {
        bot.creative.stopFlying();
        this.creativeFlightActive = false;
      }
    }

    return { requested: blocks.length, completed, details };
  }

  async drop({
    itemName,
    count,
    signal,
    assertAuthorized,
  }: {
    itemName: string;
    count: number;
    signal: AbortSignal;
    assertAuthorized: () => void;
  }): Promise<ActionProgress> {
    const bot = this.requireBot();
    const item = bot.inventory.items().find(candidate => candidate.name === itemName);
    if (item === undefined) {
      throw new Error(`${itemName} is not in the bot inventory.`);
    }
    const dropCount = Math.min(count, item.count);
    assertAuthorized();
    await runAbortable({
      signal,
      operation: async () => {
        await bot.toss(item.type, item.metadata, dropCount);
      },
      stop: () => {
        bot.clearControlStates();
      },
    });
    return { requested: count, completed: dropCount, details: [`Dropped ${String(dropCount)} ${itemName}`] };
  }

  stop(): void {
    const bot = this.bot;
    if (bot === null) {
      return;
    }
    bot.pathfinder.stop();
    if (this.creativeFlightActive) {
      bot.creative.stopFlying();
      this.creativeFlightActive = false;
    }
    bot.stopDigging();
    bot.clearControlStates();
  }

  private async moveForBlueprintTarget({
    target,
    plan,
    signal,
    assertAuthorized,
  }: {
    target: Vec3;
    plan: Plan;
    signal: AbortSignal;
    assertAuthorized: () => void;
  }): Promise<void> {
    const bot = this.requireBot();
    if (bot.game.gameMode !== 'creative') {
      await this.moveTo({ target: integerPosition(target), range: 3, plan, signal, assertAuthorized });
      return;
    }

    const destination = new Vec3(target.x + 0.5, target.y + 2.5, target.z + 0.5);
    const cruisingY = Math.max(bot.entity.position.y, destination.y);
    const waypoints = [
      new Vec3(bot.entity.position.x, cruisingY, bot.entity.position.z),
      new Vec3(destination.x, cruisingY, destination.z),
      destination,
    ];
    for (const waypoint of waypoints) {
      assertAuthorized();
      if (!isPositionWithinPlanBounds({ plan, position: integerPosition(waypoint) })) {
        throw new Error('Creative build flight would leave the approved plan radius.');
      }
      try {
        this.creativeFlightActive = true;
        await runCreativeFlight({ bot, destination: waypoint, signal, assertAuthorized, keepFlying: true });
      } catch (caught) {
        bot.creative.stopFlying();
        this.creativeFlightActive = false;
        throw caught;
      }
    }
  }

  private async ensureBlueprintItem({
    blockName,
    signal,
    assertAuthorized,
  }: {
    blockName: string;
    signal: AbortSignal;
    assertAuthorized: () => void;
  }) {
    const bot = this.requireBot();
    const existing = bot.inventory.items().find(candidate => candidate.name === blockName);
    if (existing !== undefined) {
      return existing;
    }
    if (bot.game.gameMode !== 'creative') {
      throw new Error(`Missing ${blockName} in inventory.`);
    }
    const itemType = bot.registry.itemsByName[blockName];
    if (itemType === undefined) {
      throw new Error(`Minecraft 1.21.4 has no placeable item named ${blockName}.`);
    }
    const Item = prismarineItem(bot.registry);
    assertAuthorized();
    await runAbortable({
      signal,
      operation: async () => {
        await bot.creative.setInventorySlot(36, new Item(itemType.id, itemType.stackSize));
      },
      stop: () => {
        bot.clearControlStates();
      },
    });
    bot.setQuickBarSlot(0);
    const created = bot.inventory.slots[36];
    if (created?.name !== blockName) {
      throw new Error(`Minecraft rejected the creative ${blockName} material stack.`);
    }
    return created;
  }

  async say(message: string): Promise<void> {
    const bot = this.requireBot();
    for (const part of splitChatMessage(message)) {
      bot.chat(part);
      await new Promise(resolve => setTimeout(resolve, 350));
    }
  }

  onChat(listener: (event: { username: string; message: string }) => void): () => void {
    this.chatListeners.add(listener);
    return () => this.chatListeners.delete(listener);
  }

  private async collectDrops({
    target,
    itemTypeId,
    previousCount,
    expectedIncrease = 1,
    plan,
    signal,
    assertAuthorized,
  }: {
    target: Position;
    itemTypeId: number;
    previousCount: number;
    expectedIncrease?: number;
    plan: Plan;
    signal: AbortSignal;
    assertAuthorized: () => void;
  }): Promise<void> {
    const bot = this.requireBot();
    await wait({ milliseconds: 200, signal });
    assertAuthorized();
    await this.moveTo({ target, range: 1, plan, signal, assertAuthorized });
    const deadline = Date.now() + 3_500;
    while (bot.inventory.count(itemTypeId, null) - previousCount < expectedIncrease && Date.now() < deadline) {
      assertAuthorized();
      await wait({ milliseconds: 150, signal });
    }
    const collected = bot.inventory.count(itemTypeId, null) - previousCount;
    if (collected < expectedIncrease) {
      throw new Error(
        `Mined ${String(expectedIncrease)} blocks, but only ${String(collected)} drops were verified in inventory.`,
      );
    }
  }

  private animalDropInventory(species: HuntSpecies): Map<string, number> {
    const bot = this.requireBot();
    const counts = new Map<string, number>();
    for (const item of bot.inventory.items()) {
      if (isVerifiedAnimalDrop({ species, itemName: item.name })) {
        counts.set(item.name, (counts.get(item.name) ?? 0) + item.count);
      }
    }
    return counts;
  }

  private isEligibleAnimalTarget({
    id,
    species,
    maxDistance,
    plan,
  }: {
    id: number;
    species: HuntSpecies;
    maxDistance: number;
    plan: Plan;
  }): boolean {
    const bot = this.requireBot();
    const target = bot.entities[id];
    return (
      target?.isValid === true &&
      this.locateAnimals({ species, maxDistance, plan }).some(candidate => candidate.id === id)
    );
  }

  private async attackAndWaitForDeath({
    target,
    signal,
  }: {
    target: Bot['entity'];
    signal: AbortSignal;
  }): Promise<boolean> {
    const bot = this.requireBot();
    let hurtByBot = false;
    let killedByBot = false;
    const handleHurt = (hurtEntity: Bot['entity'], source: { id?: number } | undefined) => {
      if (hurtEntity.id === target.id) {
        hurtByBot = source?.id === bot.entity.id;
      }
    };
    const handleDeath = (deadEntity: Bot['entity']) => {
      if (deadEntity.id === target.id && hurtByBot) {
        killedByBot = true;
      }
    };
    bot.on('entityHurt', handleHurt);
    bot.on('entityDead', handleDeath);
    try {
      bot.attack(target);
      await wait({ milliseconds: 1_250, signal });
      return killedByBot;
    } finally {
      bot.removeListener('entityHurt', handleHurt);
      bot.removeListener('entityDead', handleDeath);
    }
  }

  private async collectAnimalDrops({
    species,
    target,
    before,
    plan,
    signal,
    assertAuthorized,
  }: {
    species: HuntSpecies;
    target: Position;
    before: Map<string, number>;
    plan: Plan;
    signal: AbortSignal;
    assertAuthorized: () => void;
  }): Promise<string[]> {
    await wait({ milliseconds: 200, signal });
    assertAuthorized();
    await this.moveTo({ target, range: 1, plan, signal, assertAuthorized });
    const deadline = Date.now() + 3_500;
    let changes: string[] = [];
    while (Date.now() < deadline) {
      assertAuthorized();
      const after = this.animalDropInventory(species);
      changes = [...after.entries()]
        .map(([itemName, itemCount]) => ({ itemName, count: itemCount - (before.get(itemName) ?? 0) }))
        .filter(change => change.count > 0)
        .map(change => `${String(change.count)} ${change.itemName}`);
      if (changes.length > 0) {
        return changes;
      }
      await wait({ milliseconds: 150, signal });
    }
    return changes;
  }

  private findPlacementReference(target: Vec3) {
    const bot = this.requireBot();
    const faces = [
      new Vec3(0, 1, 0),
      new Vec3(0, -1, 0),
      new Vec3(1, 0, 0),
      new Vec3(-1, 0, 0),
      new Vec3(0, 0, 1),
      new Vec3(0, 0, -1),
    ];
    for (const face of faces) {
      const reference = bot.blockAt(target.minus(face));
      if (reference !== null && reference.boundingBox !== 'empty') {
        return { reference, face };
      }
    }
    return null;
  }

  private async runBoundedPathfinder({
    plan,
    signal,
    navigate,
    assertAuthorized,
  }: {
    plan: Plan;
    signal: AbortSignal;
    navigate: () => Promise<void>;
    assertAuthorized: () => void;
  }): Promise<void> {
    const bot = this.requireBot();
    await runAbortable({
      signal,
      operation: async () => {
        assertAuthorized();
        let rejectBoundary: ((reason: Error) => void) | undefined;
        const boundaryViolation = new Promise<never>((_resolve, reject) => {
          rejectBoundary = reject;
        });
        const checkBounds = () => {
          try {
            assertAuthorized();
            if (isPositionWithinPlanBounds({ plan, position: integerPosition(bot.entity.position) })) {
              return;
            }
            bot.pathfinder.stop();
            rejectBoundary?.(new Error(`Path left the approved ${String(plan.radiusBlocks)}-block plan radius.`));
          } catch (caught) {
            bot.pathfinder.stop();
            rejectBoundary?.(caught instanceof Error ? caught : new Error('Minecraft plan authorization failed.'));
          }
        };
        bot.on('physicsTick', checkBounds);
        try {
          await Promise.race([navigate(), boundaryViolation]);
        } finally {
          bot.removeListener('physicsTick', checkBounds);
        }
      },
      stop: () => {
        bot.pathfinder.stop();
      },
    });
  }

  private requireBot(): Bot {
    if (this.bot === null) {
      throw new Error('ForgeBot is not connected to Minecraft.');
    }
    return this.bot;
  }
}
