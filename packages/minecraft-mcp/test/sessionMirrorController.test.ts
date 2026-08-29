import { describe, expect, it, vi } from 'vitest';

import type { WorldObservation } from '../src/botPort.js';
import { SessionMirrorController } from '../src/sessionMirrorController.js';
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

function fakeBot() {
  return {
    start: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    isConnected: () => true,
    position: () => observation.position,
    inspect: () => observation,
    locateNaturalTrees: () => [],
    locateAnimals: () => [],
    moveTo: vi.fn(async () => undefined),
    gather: vi.fn(async ({ count }: { count: number }) => ({ requested: count, completed: count, details: [] })),
    harvestTrees: vi.fn(async ({ count }: { count: number }) => ({ requested: count, completed: count, details: [] })),
    huntAnimals: vi.fn(async ({ count }: { count: number }) => ({ requested: count, completed: count, details: [] })),
    craft: vi.fn(async ({ count }: { count: number }) => ({ requested: count, completed: count, details: [] })),
    executeBlueprint: vi.fn(async ({ blocks }: { blocks: unknown[] }) => ({
      requested: blocks.length,
      completed: blocks.length,
      details: [],
    })),
    drop: vi.fn(async ({ count }: { count: number }) => ({ requested: count, completed: count, details: [] })),
    stop: vi.fn(),
    say: vi.fn(async () => undefined),
    onChat: (_listener: (event: { username: string; message: string }) => void) => () => undefined,
  };
}

function fakeSession(latestTurn: () => Promise<TurnSnapshot | null>): TrueForgeSessionPort {
  return {
    latestTurn,
    createUserTurn: async () => {
      throw new Error('The output-only controller must not create turns.');
    },
    cancelActiveTurn: async () => undefined,
  };
}

describe('TrueForge session mirror', () => {
  it('mirrors a new completed response once without accepting Minecraft chat turns', async () => {
    const bot = fakeBot();
    let latest: TurnSnapshot | null = null;
    const controller = new SessionMirrorController(
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
    await controller.tick();

    expect(bot.say).toHaveBeenCalledTimes(1);
    expect(bot.say).toHaveBeenCalledWith('I finished harvesting the tree.');
    await controller.close();
  });

  it('serializes player chat into the Builder session while approval is not pending', async () => {
    const bot = fakeBot();
    let chatListener: ((event: { username: string; message: string }) => void) | undefined;
    bot.onChat = listener => {
      chatListener = listener;
      return () => undefined;
    };
    let latest: TurnSnapshot = {
      id: 'approved-idle-turn',
      status: 'done',
      hasRequiredActions: false,
      responseText: null,
    };
    const createUserTurn = vi.fn(async () => ({
      id: 'minecraft-turn',
      status: 'running' as const,
      hasRequiredActions: false,
      responseText: null,
    }));
    const session: TrueForgeSessionPort = {
      latestTurn: async () => latest,
      createUserTurn,
      cancelActiveTurn: async () => undefined,
    };
    const controller = new SessionMirrorController(bot, session, vi.fn(), 60_000, true);
    await controller.start();

    latest = { ...latest, id: 'approval', hasRequiredActions: true };
    chatListener?.({
      username: 'DemoPlayer',
      message: 'https://www.grabcraft.com/minecraft/small-modern-villa/modern-houses',
    });
    await controller.tick();
    expect(createUserTurn).not.toHaveBeenCalled();

    latest = { ...latest, id: 'idle-again', hasRequiredActions: false };
    await controller.tick();
    expect(createUserTurn).toHaveBeenCalledWith(
      'DemoPlayer says in Minecraft: https://www.grabcraft.com/minecraft/small-modern-villa/modern-houses',
    );
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
    const controller = new SessionMirrorController(
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
