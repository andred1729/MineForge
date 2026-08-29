import { describe, expect, it, vi } from 'vitest';

import type { Plan, Position } from '../src/domain.js';
import { MineflayerBot, runAbortable } from '../src/mineflayerBot.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: () => void = () => {};
  const promise = new Promise<void>(resolve => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

describe('Mineflayer cancellation', () => {
  it('does not release a cancelled craft or placement wrapper before the operation settles', async () => {
    const controller = new AbortController();
    const operationSettled = deferred();
    const stop = vi.fn();
    let wrapperSettled = false;

    const result = runAbortable({
      signal: controller.signal,
      operation: async () => {
        await operationSettled.promise;
      },
      stop,
    }).finally(() => {
      wrapperSettled = true;
    });

    controller.abort();
    await Promise.resolve();
    expect(stop).toHaveBeenCalledOnce();
    expect(wrapperSettled).toBe(false);

    operationSettled.resolve();
    await expect(result).rejects.toThrow('cancelled');
    expect(wrapperSettled).toBe(true);
  });
});

describe('Mineflayer tree-drop collection', () => {
  it('collects at every mined log against the tree inventory baseline', async () => {
    const subject = new MineflayerBot({
      host: '127.0.0.1',
      port: 25565,
      username: 'ForgeBot1',
      version: '1.21.4',
    });
    let inventoryCount = 0;
    const fakeMineflayer = {
      registry: { itemsByName: { oak_log: { id: 17 } } },
      inventory: { count: () => inventoryCount },
      blockAt: (position: Position) => ({ name: 'oak_log', position }),
      canDigBlock: () => true,
      pathfinder: { bestHarvestTool: () => null },
      dig: vi.fn(async () => undefined),
    };
    (subject as unknown as { bot: unknown }).bot = fakeMineflayer;
    vi.spyOn(subject, 'locateNaturalTrees').mockReturnValue([
      {
        logName: 'oak_log',
        root: { x: 1, y: 64, z: 1 },
        logs: [
          { x: 1, y: 64, z: 1 },
          { x: 2, y: 65, z: 1 },
        ],
      },
    ]);
    const collectionCalls: Array<{ target: Position; previousCount: number; expectedIncrease?: number }> = [];
    const internals = subject as unknown as {
      collectDrops(input: { target: Position; previousCount: number; expectedIncrease?: number }): Promise<void>;
    };
    vi.spyOn(internals, 'collectDrops').mockImplementation(async input => {
      collectionCalls.push(input);
      inventoryCount = input.previousCount + (input.expectedIncrease ?? 1);
    });
    const plan: Plan = {
      id: 'plan',
      summary: 'Harvest a tree',
      steps: ['Harvest'],
      permittedActions: ['gather'],
      origin: { x: 0, y: 64, z: 0 },
      additionalOrigins: [],
      radiusBlocks: 32,
      createdAt: 0,
      expiresAt: Number.MAX_SAFE_INTEGER,
    };

    await subject.harvestTrees({
      blockName: 'oak_log',
      count: 2,
      maxDistance: 32,
      plan,
      signal: new AbortController().signal,
      assertAuthorized: () => undefined,
    });

    expect(collectionCalls).toMatchObject([
      { target: { x: 1, y: 64, z: 1 }, previousCount: 0, expectedIncrease: 1 },
      { target: { x: 2, y: 64, z: 1 }, previousCount: 0, expectedIncrease: 2 },
      { target: { x: 1, y: 64, z: 1 }, previousCount: 0, expectedIncrease: 2 },
    ]);
  });
});
