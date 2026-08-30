import { EventEmitter } from 'node:events';

import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { describe, expect, it, vi } from 'vitest';

import type { Plan, Position } from '../src/domain.js';
import { MineflayerBot, navigateNear, runAbortable, runCreativeFlight, waitForBotSpawn } from '../src/mineflayerBot.js';

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

  it('keeps the bot hovering after an authorized build flight', async () => {
    vi.useFakeTimers();
    const stopFlying = vi.fn();
    const fakeBot = {
      creative: { startFlying: vi.fn(), stopFlying },
      entity: { position: new Vec3(0, 100, 0), velocity: new Vec3(0, 0, 0) },
      physics: { gravity: 0 },
    } as unknown as Bot;
    const flight = runCreativeFlight({
      bot: fakeBot,
      destination: new Vec3(0, 100, 0),
      signal: new AbortController().signal,
      assertAuthorized: () => {},
      keepFlying: true,
    });

    await vi.advanceTimersByTimeAsync(50);
    await expect(flight).resolves.toBeUndefined();
    expect(stopFlying).not.toHaveBeenCalled();
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

describe('Mineflayer navigation completion', () => {
  it('settles movement when the live position enters the requested range', async () => {
    const events = new EventEmitter();
    let rejectNavigation: (reason: Error) => void = () => {};
    const navigation = new Promise<void>((_resolve, reject) => {
      rejectNavigation = reject;
    });
    const stop = vi.fn(() => {
      rejectNavigation(new Error('Path was stopped'));
    });
    const fakeBot = Object.assign(events, {
      entity: { position: new Vec3(-60, 66, -6) },
      pathfinder: { goto: vi.fn(() => navigation), stop },
    }) as unknown as Bot;

    const movement = navigateNear({ bot: fakeBot, target: { x: -46, y: 66, z: -6 }, range: 2 });
    fakeBot.entity.position = new Vec3(-47.5, 66, -6.5);
    events.emit('physicsTick');

    await expect(movement).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('does not start pathfinding when already within range', async () => {
    const events = new EventEmitter();
    const goto = vi.fn(async () => undefined);
    const fakeBot = Object.assign(events, {
      entity: { position: new Vec3(-47.5, 66, -6.5) },
      pathfinder: { goto, stop: vi.fn() },
    }) as unknown as Bot;

    await navigateNear({ bot: fakeBot, target: { x: -46, y: 66, z: -6 }, range: 2 });

    expect(goto).not.toHaveBeenCalled();
  });
});

describe('Mineflayer temporary scaffolding', () => {
  const buildPlan: Plan = {
    id: 'build-plan',
    summary: 'Build safely',
    steps: ['Build'],
    permittedActions: ['build'],
    origin: { x: 0, y: 64, z: 0 },
    additionalOrigins: [],
    radiusBlocks: 32,
    createdAt: 0,
    expiresAt: Number.MAX_SAFE_INTEGER,
  };

  it('records each confirmed scaffold before a later column placement fails', async () => {
    const subject = new MineflayerBot({
      host: '127.0.0.1',
      port: 25565,
      username: 'ForgeBot1',
      version: '1.21.4',
    });
    const scaffoldBlocks = new Set<string>();
    const fakeBot = {
      blockAt: (position: Vec3) => ({
        name: scaffoldBlocks.has(position.toString()) ? 'scaffolding' : 'air',
        position,
      }),
      equip: vi.fn(async () => undefined),
      placeBlock: vi.fn(async (reference: { position: Vec3 }, face: Vec3) => {
        const position = reference.position.plus(face);
        if (position.y === 65) {
          throw new Error('second scaffold failed');
        }
        scaffoldBlocks.add(position.toString());
      }),
      clearControlStates: vi.fn(),
    } as unknown as Bot;
    (subject as unknown as { bot: Bot }).bot = fakeBot;
    const internals = subject as unknown as {
      findPlacementReference(target: Vec3): { reference: { position: Vec3 }; face: Vec3 } | null;
      moveForBlueprintTarget(): Promise<void>;
      ensureBlueprintItem(): Promise<unknown>;
      placeTemporaryScaffoldColumn(input: {
        target: Vec3;
        plan: Plan;
        signal: AbortSignal;
        assertAuthorized: () => void;
        placedPositions: Vec3[];
      }): Promise<void>;
    };
    vi.spyOn(internals, 'findPlacementReference').mockImplementation(target => {
      if (target.y === 64 || (target.y === 65 && scaffoldBlocks.has(new Vec3(0, 64, 0).toString()))) {
        return { reference: { position: target.offset(0, -1, 0) }, face: new Vec3(0, 1, 0) };
      }
      return null;
    });
    vi.spyOn(internals, 'moveForBlueprintTarget').mockResolvedValue(undefined);
    vi.spyOn(internals, 'ensureBlueprintItem').mockResolvedValue({});
    const placedPositions: Vec3[] = [];

    await expect(
      internals.placeTemporaryScaffoldColumn({
        target: new Vec3(0, 66, 0),
        plan: buildPlan,
        signal: new AbortController().signal,
        assertAuthorized: () => undefined,
        placedPositions,
      }),
    ).rejects.toThrow('second scaffold failed');

    expect(placedPositions.map(position => position.toString())).toEqual([new Vec3(0, 64, 0).toString()]);
  });

  it('rolls back partial scaffolds after cancellation without replacing the original failure', async () => {
    const subject = new MineflayerBot({
      host: '127.0.0.1',
      port: 25565,
      username: 'ForgeBot1',
      version: '1.21.4',
    });
    const fakeBot = {
      blockAt: () => ({ name: 'air' }),
      creative: { stopFlying: vi.fn() },
    } as unknown as Bot;
    (subject as unknown as { bot: Bot }).bot = fakeBot;
    const controller = new AbortController();
    const scaffold = new Vec3(0, 64, 0);
    const internals = subject as unknown as {
      findPlacementReference(): null;
      moveForBlueprintTarget(): Promise<void>;
      placeTemporaryScaffoldColumn(input: { placedPositions: Vec3[] }): Promise<void>;
      removeTemporaryScaffolds(input: {
        positions: Vec3[];
        signal: AbortSignal;
        assertAuthorized: () => void;
      }): Promise<void>;
    };
    vi.spyOn(internals, 'findPlacementReference').mockReturnValue(null);
    vi.spyOn(internals, 'moveForBlueprintTarget').mockResolvedValue(undefined);
    vi.spyOn(internals, 'placeTemporaryScaffoldColumn').mockImplementation(async input => {
      input.placedPositions.push(scaffold);
      controller.abort();
      throw new Error('original scaffold cancellation');
    });
    const remove = vi.spyOn(internals, 'removeTemporaryScaffolds').mockImplementation(async input => {
      expect(input.positions).toEqual([scaffold]);
      expect(input.signal.aborted).toBe(false);
      expect(() => input.assertAuthorized()).not.toThrow();
      throw new Error('cleanup also failed');
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(
      subject.executeBlueprint({
        origin: { x: 0, y: 64, z: 0 },
        blocks: [{ dx: 0, dy: 2, dz: 0, block: 'stone' }],
        plan: buildPlan,
        signal: controller.signal,
        assertAuthorized: () => undefined,
      }),
    ).rejects.toThrow('original scaffold cancellation');

    expect(remove).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(
      'Could not completely roll back temporary Minecraft scaffolding.',
      expect.objectContaining({
        message: 'Could not remove 1 temporary scaffold block(s); cleanup will retry before the next blueprint batch.',
        cause: expect.objectContaining({ message: 'cleanup also failed' }),
      }),
    );
    warning.mockRestore();
  });

  it('bounds cleanup per scaffold and retries only positions that remain', async () => {
    const subject = new MineflayerBot({
      host: '127.0.0.1',
      port: 25565,
      username: 'ForgeBot1',
      version: '1.21.4',
    });
    const first = new Vec3(0, 64, 0);
    const second = new Vec3(0, 65, 0);
    const internals = subject as unknown as {
      rollbackTemporaryScaffolds(input: { positions: Vec3[]; plan: Plan }): Promise<void>;
      removeTemporaryScaffolds(input: { positions: Vec3[]; signal: AbortSignal }): Promise<void>;
    };
    const attempts: string[] = [];
    let failSecondOnce = true;
    const remove = vi.spyOn(internals, 'removeTemporaryScaffolds').mockImplementation(async input => {
      expect(input.signal.aborted).toBe(false);
      const key = input.positions[0]?.toString() ?? 'missing';
      attempts.push(key);
      if (key === second.toString() && failSecondOnce) {
        failSecondOnce = false;
        throw new Error('temporary cleanup failure');
      }
    });

    await expect(internals.rollbackTemporaryScaffolds({ positions: [first, second], plan: buildPlan })).rejects.toThrow(
      'cleanup will retry before the next blueprint batch',
    );

    expect(attempts).toEqual([second.toString(), first.toString()]);
    expect(remove.mock.calls[0]?.[0].signal).not.toBe(remove.mock.calls[1]?.[0].signal);

    attempts.length = 0;
    await internals.rollbackTemporaryScaffolds({ positions: [], plan: buildPlan });
    expect(attempts).toEqual([second.toString()]);
  });

  it('retains an unloaded scaffold position until its chunk can be checked', async () => {
    const subject = new MineflayerBot({
      host: '127.0.0.1',
      port: 25565,
      username: 'ForgeBot1',
      version: '1.21.4',
    });
    let chunkLoaded = false;
    const blockAt = vi.fn(() => (chunkLoaded ? ({ name: 'air' } as ReturnType<Bot['blockAt']>) : null));
    (subject as unknown as { bot: Bot }).bot = { blockAt } as unknown as Bot;
    const internals = subject as unknown as {
      rollbackTemporaryScaffolds(input: { positions: Vec3[]; plan: Plan }): Promise<void>;
    };
    const scaffold = new Vec3(0, 64, 0);

    await expect(
      internals.rollbackTemporaryScaffolds({ positions: [scaffold], plan: buildPlan }),
    ).rejects.toMatchObject({
      message: 'Could not remove 1 temporary scaffold block(s); cleanup will retry before the next blueprint batch.',
      cause: expect.objectContaining({ message: expect.stringContaining('Scaffold chunk is not loaded') }),
    });

    chunkLoaded = true;
    await internals.rollbackTemporaryScaffolds({ positions: [], plan: buildPlan });
    expect(blockAt).toHaveBeenCalledTimes(2);
  });
});

describe('Mineflayer tree-drop collection', () => {
  it('approaches a spawned item instead of requiring the mined block coordinate', async () => {
    const subject = new MineflayerBot({
      host: '127.0.0.1',
      port: 25565,
      username: 'ForgeBot1',
      version: '1.21.4',
    });
    let inventoryCount = 0;
    const droppedItem = { name: 'item', position: new Vec3(-41, 63, -8) };
    const fakeMineflayer = {
      inventory: { count: () => inventoryCount },
      nearestEntity: (predicate: (entity: typeof droppedItem) => boolean) =>
        predicate(droppedItem) ? droppedItem : null,
    };
    (subject as unknown as { bot: unknown }).bot = fakeMineflayer;
    const moveTo = vi.spyOn(subject, 'moveTo').mockImplementation(async () => {
      inventoryCount = 1;
    });
    const plan: Plan = {
      id: 'plan',
      summary: 'Collect a log',
      steps: ['Collect'],
      permittedActions: ['gather'],
      origin: { x: -46, y: 66, z: -6 },
      additionalOrigins: [],
      radiusBlocks: 32,
      createdAt: 0,
      expiresAt: Number.MAX_SAFE_INTEGER,
    };
    const internals = subject as unknown as {
      collectDrops(input: {
        target: Position;
        itemTypeId: number;
        previousCount: number;
        plan: Plan;
        signal: AbortSignal;
        assertAuthorized: () => void;
      }): Promise<void>;
    };

    await internals.collectDrops({
      target: { x: -42, y: 64, z: -8 },
      itemTypeId: 17,
      previousCount: 0,
      plan,
      signal: new AbortController().signal,
      assertAuthorized: () => undefined,
    });

    expect(moveTo).toHaveBeenCalledWith(expect.objectContaining({ target: { x: -41, y: 63, z: -8 }, range: 1.5 }));
  });

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
