import { describe, expect, it } from 'vitest';

import type { Position } from '../src/domain.js';
import { findNaturalTrees, type TreeBlockSnapshot, type TreeWorld } from '../src/treeHarvest.js';

function key(position: Position): string {
  return `${String(position.x)},${String(position.y)},${String(position.z)}`;
}

function testWorld(blocks: TreeBlockSnapshot[]): TreeWorld {
  const byPosition = new Map(blocks.map(block => [key(block.position), block]));
  return { blockAt: position => byPosition.get(key(position)) ?? null };
}

function block(name: string, x: number, y: number, z: number): TreeBlockSnapshot {
  return { name, position: { x, y, z } };
}

function oakTreeBlocks(): TreeBlockSnapshot[] {
  return [
    block('grass_block', 2, 0, 0),
    block('oak_log', 2, 1, 0),
    block('oak_log', 2, 2, 0),
    block('oak_log', 2, 3, 0),
    block('oak_log', 2, 4, 0),
    block('oak_log', 3, 4, 0),
    block('oak_leaves', 2, 5, 0),
    block('oak_leaves', 3, 5, 0),
  ];
}

describe('natural tree discovery', () => {
  it('returns the entire connected trunk and branch for a grounded tree with a matching canopy', () => {
    const world = testWorld(oakTreeBlocks());

    const trees = findNaturalTrees({
      world,
      candidates: [{ x: 2, y: 2, z: 0 }],
      logName: 'oak_log',
      origin: { x: 0, y: 1, z: 0 },
      maxDistance: 16,
      withinBounds: () => true,
    });

    expect(trees).toHaveLength(1);
    expect(trees[0]).toMatchObject({
      logName: 'oak_log',
      root: { x: 2, y: 1, z: 0 },
    });
    expect(trees[0]?.logs).toHaveLength(5);
    expect(trees[0]?.logs.map(position => position.y)).toEqual([1, 2, 3, 4, 4]);
  });

  it('rejects log structures that do not have a natural matching leaf canopy', () => {
    const world = testWorld([
      block('grass_block', 2, 0, 0),
      block('oak_log', 2, 1, 0),
      block('oak_log', 2, 2, 0),
      block('oak_log', 2, 3, 0),
      block('oak_planks', 3, 2, 0),
    ]);

    expect(
      findNaturalTrees({
        world,
        candidates: [{ x: 2, y: 1, z: 0 }],
        logName: 'oak_log',
        origin: { x: 0, y: 1, z: 0 },
        maxDistance: 16,
        withinBounds: () => true,
      }),
    ).toEqual([]);
  });

  it('rejects a tree when any connected log crosses the approved boundary', () => {
    const world = testWorld(oakTreeBlocks());

    expect(
      findNaturalTrees({
        world,
        candidates: [{ x: 2, y: 1, z: 0 }],
        logName: 'oak_log',
        origin: { x: 0, y: 1, z: 0 },
        maxDistance: 16,
        withinBounds: position => position.x <= 2,
      }),
    ).toEqual([]);
  });

  it('does not classify stripped logs or non-log blocks as natural trees', () => {
    const world = testWorld(oakTreeBlocks());

    expect(
      findNaturalTrees({
        world,
        candidates: [{ x: 2, y: 1, z: 0 }],
        logName: 'stripped_oak_log',
        origin: { x: 0, y: 1, z: 0 },
        maxDistance: 16,
        withinBounds: () => true,
      }),
    ).toEqual([]);
  });
});
