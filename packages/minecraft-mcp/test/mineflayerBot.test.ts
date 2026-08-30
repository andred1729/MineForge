import { EventEmitter } from 'node:events';

import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { describe, expect, it, vi } from 'vitest';

import type { Plan, Position } from '../src/domain.js';
import { MineflayerBot, runAbortable, runCreativeFlight, waitForBotSpawn } from '../src/mineflayerBot.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: () => void = () => {};
  const promise = new Promise<void>(resolve => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

describe('Mineflayer startup', () => {
  it('rejects when Minecraft disconnects before spawn', async () => {
    const events = new EventEmitter();
    const spawned = waitForBotSpawn(events as unknown as Bot, 'sub_agent2', 1_000);
    events.emit('end', 'socketClosed');

    await expect(spawned).rejects.toThrow('sub_agent2 disconnected before spawning');
  });

  it('times out instead of leaving an MCP helper request pending forever', async () => {
    vi.useFakeTimers();
    const events = new EventEmitter();
    const spawned = waitForBotSpawn(events as unknown as Bot, 'sub_agent2', 1_000);
    const assertion = expect(spawned).rejects.toThrow('did not spawn within 1 seconds');
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    vi.useRealTimers();
  });
});

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

  it('halts creative movement promptly and restores gravity after abort', async () => {
    vi.useFakeTimers();
    const originalGravity = 0.08;
    const startFlying = vi.fn();
    const stopFlying = vi.fn();
    const fakeBot = {
      creative: { startFlying, stopFlying },
      entity: { position: new Vec3(0, 100, 0), velocity: new Vec3(0, 0, 0) },
      physics: { gravity: originalGravity },
    } as unknown as Bot;
    startFlying.mockImplementation(() => {
      fakeBot.physics.gravity = 0;
    });
    stopFlying.mockImplementation(() => {
      fakeBot.physics.gravity = originalGravity;
    });
    const controller = new AbortController();
    const flight = runCreativeFlight({
      bot: fakeBot,
      destination: new Vec3(10, 100, 0),
      signal: controller.signal,
      assertAuthorized: () => {},
    });

    await vi.advanceTimersByTimeAsync(50);
    controller.abort();
    const stoppedAt = fakeBot.entity.position.x;
    await expect(flight).rejects.toThrow('cancelled');
    await vi.advanceTimersByTimeAsync(500);

    expect(fakeBot.entity.position.x).toBe(stoppedAt);
    expect(stopFlying).toHaveBeenCalledOnce();
    expect(fakeBot.physics.gravity).toBe(originalGravity);
    vi.useRealTimers();
  });

  it('does not touch creative gravity when stopping a survival action', () => {
    const stopFlying = vi.fn();
    const fakeBot = {
      creative: { stopFlying },
      pathfinder: { stop: vi.fn() },
      stopDigging: vi.fn(),
      clearControlStates: vi.fn(),
    } as unknown as Bot;
    const adapter = new MineflayerBot({ host: '127.0.0.1', port: 25_565, username: 'Bot', version: '1.21.4' });
    (adapter as unknown as { bot: Bot }).bot = fakeBot;

    adapter.stop();

    expect(stopFlying).not.toHaveBeenCalled();
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
