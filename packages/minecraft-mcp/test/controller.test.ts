import { describe, expect, it, vi } from 'vitest';

import type { MinecraftBotPort, WorldObservation } from '../src/botPort.js';
import { MinecraftEventController } from '../src/controller.js';
import type { TrueForgeSessionPort, TurnSnapshot } from '../src/trueforgePort.js';

function observation(): WorldObservation {
  return {
    connected: true,
    username: 'ForgeBot',
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
}

function fakeBot() {
  let chatListener: ((event: { username: string; message: string }) => void) | null = null;
  const say = vi.fn(async () => {});
  const bot: MinecraftBotPort = {
    start: async () => {},
    close: async () => {},
    isConnected: () => true,
    position: () => ({ x: 0, y: 64, z: 0 }),
    inspect: () => observation(),
    moveTo: async () => {},
    gather: async () => ({ requested: 1, completed: 1, details: [] }),
    craft: async () => ({ requested: 1, completed: 1, details: [] }),
    executeBlueprint: async () => ({ requested: 1, completed: 1, details: [] }),
    drop: async () => ({ requested: 1, completed: 1, details: [] }),
    stop: () => {},
    say,
    onChat: listener => {
      chatListener = listener;
      return () => {
        chatListener = null;
      };
    },
  };
  return {
    bot,
    say,
    emitChat(event: { username: string; message: string }) {
      chatListener?.(event);
    },
  };
}

describe('MinecraftEventController', () => {
  it('queues chat while a turn is running and ignores bot chat', async () => {
    const running: TurnSnapshot = {
      id: 'turn-1',
      status: 'running',
      hasRequiredActions: false,
      responseText: null,
    };
    let latest: TurnSnapshot | null = running;
    const created: string[] = [];
    const trueforge: TrueForgeSessionPort = {
      latestTurn: async () => latest,
      cancelActiveTurn: async () => {},
      createUserTurn: async message => {
        created.push(message);
        return { id: 'turn-2', status: 'running', hasRequiredActions: false, responseText: null };
      },
    };
    const fixture = fakeBot();
    const controller = new MinecraftEventController(fixture.bot, trueforge, 60_000);
    await controller.start();

    fixture.emitChat({ username: 'ForgeBot', message: 'self' });
    fixture.emitChat({ username: 'Alex', message: 'build a shelter' });
    await Promise.resolve();
    await Promise.resolve();
    await controller.tick();
    expect(created).toEqual([]);

    latest = { id: 'turn-1', status: 'done', hasRequiredActions: false, responseText: 'Ready.' };
    await controller.tick();
    expect(created).toEqual(['[Minecraft chat from Alex] build a shelter']);
    expect(fixture.say).toHaveBeenCalledWith('Ready.');
    await controller.close();
  });

  it('holds events while approval is pending', async () => {
    const createUserTurn = vi.fn<TrueForgeSessionPort['createUserTurn']>(async () => ({
      id: 'turn-2',
      status: 'running',
      hasRequiredActions: false,
      responseText: null,
    }));
    const trueforge: TrueForgeSessionPort = {
      latestTurn: async () => ({
        id: 'turn-1',
        status: 'done',
        hasRequiredActions: true,
        responseText: null,
      }),
      cancelActiveTurn: async () => {},
      createUserTurn,
    };
    const fixture = fakeBot();
    const controller = new MinecraftEventController(fixture.bot, trueforge, 60_000);
    await controller.start();
    controller.enqueueChat({ username: 'Alex', message: 'second message' });
    await controller.tick();
    expect(createUserTurn).not.toHaveBeenCalled();
    await controller.close();
  });

  it('immediately cancels a running turn when Minecraft chat says stop', async () => {
    const cancelActiveTurn = vi.fn(async () => {});
    const trueforge: TrueForgeSessionPort = {
      latestTurn: async () => ({
        id: 'turn-1',
        status: 'running',
        hasRequiredActions: false,
        responseText: null,
      }),
      cancelActiveTurn,
      createUserTurn: async () => ({
        id: 'turn-2',
        status: 'running',
        hasRequiredActions: false,
        responseText: null,
      }),
    };
    const fixture = fakeBot();
    const onTurnCancelled = vi.fn();
    const controller = new MinecraftEventController(fixture.bot, trueforge, 60_000, onTurnCancelled);
    await controller.start();
    fixture.emitChat({ username: 'Alex', message: 'stop now' });
    await vi.waitFor(() => {
      expect(cancelActiveTurn).toHaveBeenCalledOnce();
    });
    expect(onTurnCancelled).toHaveBeenCalledOnce();
    expect(fixture.say).toHaveBeenCalledWith('Stopped. The active Minecraft plan is no longer authorized.');
    await controller.close();
  });
});
