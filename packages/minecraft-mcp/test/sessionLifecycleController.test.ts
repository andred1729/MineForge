import { describe, expect, it, vi } from 'vitest';

import type { MinecraftBotPort, WorldObservation } from '../src/botPort.js';
import { SessionLifecycleController } from '../src/sessionLifecycleController.js';
import type { TrueForgeSessionPort, TurnSnapshot } from '../src/trueforgePort.js';

const observation: WorldObservation = {
  connected: true,
  username: 'ForgeBot1',
  position: { x: 0, y: 64, z: 0 },
  health: 20,
  food: 20,
  dimension: 'overworld',
  timeOfDay: 1_000,
  isRaining: false,
  inventory: [],
  nearbyBlocks: [],
  nearbyEntities: [],
};

function fakeBot(): MinecraftBotPort {
  return {
    start: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    isConnected: () => true,
    position: () => observation.position,
    inspect: () => observation,
    locateNaturalTrees: () => [],
    locateAnimals: () => [],
    moveTo: vi.fn(async () => undefined),
    gather: vi.fn(async ({ count }) => ({ requested: count, completed: count, details: [] })),
    harvestTrees: vi.fn(async ({ count }) => ({ requested: count, completed: count, details: [] })),
    huntAnimals: vi.fn(async ({ count }) => ({ requested: count, completed: count, details: [] })),
    craft: vi.fn(async ({ count }) => ({ requested: count, completed: count, details: [] })),
    executeBlueprint: vi.fn(async ({ blocks }) => ({
      requested: blocks.length,
      completed: blocks.length,
      details: [],
    })),
    drop: vi.fn(async ({ count }) => ({ requested: count, completed: count, details: [] })),
    stop: vi.fn(),
  };
}

function fakeSession(latestTurn: () => Promise<TurnSnapshot | null>): TrueForgeSessionPort {
  return {
    latestTurn,
    createUserTurn: async () => {
      throw new Error('The lifecycle controller must not create turns.');
    },
    cancelActiveTurn: async () => undefined,
  };
}

describe('TrueForge session lifecycle', () => {
  it('keeps completed console output out of Minecraft chat', async () => {
    const bot = fakeBot();
    let latest: TurnSnapshot | null = null;
    const controller = new SessionLifecycleController(
      bot,
      fakeSession(async () => latest),
      vi.fn(),
      60_000,
    );
    await controller.start();
    latest = {
      id: 'turn-1',
      status: 'done',
      hasRequiredActions: false,
      responseText: 'I finished harvesting the tree.',
    };

    await controller.tick();

    expect(bot.stop).not.toHaveBeenCalled();
    await controller.close();
  });

  it('stops the bot and invalidates authorization once when a console turn is cancelled', async () => {
    const bot = fakeBot();
    const cancelled: TurnSnapshot = {
      id: 'turn-cancelled',
      status: 'cancelled',
      hasRequiredActions: false,
      responseText: null,
    };
    const onTurnCancelled = vi.fn();
    const controller = new SessionLifecycleController(
      bot,
      fakeSession(async () => cancelled),
      onTurnCancelled,
      60_000,
    );
    await controller.start();

    await controller.tick();
    await controller.tick();

    expect(bot.stop).toHaveBeenCalledTimes(1);
    expect(onTurnCancelled).toHaveBeenCalledTimes(1);
    await controller.close();
  });
});
