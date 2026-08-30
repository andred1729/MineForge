import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorldObservation } from '../src/botPort.js';
import type { BotIdentity } from '../src/botRoles.js';
import type { TrueForgeSessionPort } from '../src/trueforgePort.js';
import type { TrueForgeProvisionerPort } from '../src/trueforgeProvisioner.js';
import {
  WorkforceCapacityError,
  WorkforceManager,
  type ManagedMinecraftBot,
  type WorkforceManagerOptions,
} from '../src/workforceManager.js';
import { loadWorkforceState } from '../src/workforceState.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async directory => await rm(directory, { recursive: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'minecraft-workforce-manager-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

function fakeBot(identity: Pick<BotIdentity, 'username'>): ManagedMinecraftBot {
  const observation: WorldObservation = {
    connected: true,
    username: identity.username,
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
  return {
    start: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    startViewer: vi.fn(async () => undefined),
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
    say: vi.fn(async () => undefined),
    onChat: () => () => undefined,
  };
}

function fakeSession(): TrueForgeSessionPort {
  return {
    latestTurn: async () => null,
    createUserTurn: async () => ({ id: 'turn', status: 'done', hasRequiredActions: false, responseText: null }),
    cancelActiveTurn: async () => undefined,
  };
}

function managerOptions({
  stateDirectory,
  provisioner,
  identities,
}: {
  stateDirectory: string;
  provisioner: TrueForgeProvisionerPort;
  identities: BotIdentity[];
}): WorkforceManagerOptions {
  return {
    stateDirectory,
    consoleBaseUrl: 'http://127.0.0.1:8790',
    maxBots: 5,
    provisioner,
    createBot: identity => {
      identities.push(identity);
      return fakeBot(identity);
    },
    createSessionClient: () => fakeSession(),
    createController: () => ({ start: async () => undefined, close: async () => undefined }),
  };
}

describe('Minecraft workforce manager', () => {
  it('spawns a blank generalist session and attaches helpers only after a build assignment', async () => {
    const identities: BotIdentity[] = [];
    const prepared: string[] = [];
    const options = managerOptions({
      stateDirectory: await temporaryDirectory(),
      provisioner: {
        ensureProvider: async () => undefined,
        deleteSession: async () => undefined,
        provisionBot: async ({ identity }) => ({
          agentId: `agent-${identity.slug}`,
          sessionId: 'builder-session',
          createdSession: true,
        }),
      },
      identities,
    });
    let secondHelperAttempts = 0;
    options.createHelperBot = username => {
      const bot = fakeBot({ username });
      if (username === 'sub_agent2') {
        secondHelperAttempts += 1;
        if (secondHelperAttempts === 1) {
          bot.start = vi.fn(async () => {
            throw new Error('Connection ended before spawn.');
          });
        }
      }
      return bot;
    };
    options.prepareHelper = async ({ username }) => {
      prepared.push(username);
    };
    const manager = new WorkforceManager(options);
    await manager.start();

    const createUserTurn = vi.fn(async () => ({
      id: 'turn',
      status: 'done' as const,
      hasRequiredActions: false,
      responseText: null,
    }));
    options.createSessionClient = () => ({
      latestTurn: async () => null,
      createUserTurn,
      cancelActiveTurn: async () => undefined,
    });
    await expect(manager.spawn()).resolves.toMatchObject({ username: 'ForgeBot1', role: 'generalist' });
    await expect(manager.ready('ForgeBot1')).resolves.toBe(true);
    expect(createUserTurn).not.toHaveBeenCalled();
    await expect(manager.spawnBuildHelpers('forgebot1', 2)).resolves.toEqual([
      { id: 'sub_agent1', username: 'sub_agent1' },
      { id: 'sub_agent2', username: 'sub_agent2' },
    ]);
    expect(prepared).toEqual(['sub_agent1', 'sub_agent2']);
    expect(secondHelperAttempts).toBe(2);
    expect(manager.resolveBuildWorker('forgebot1', 'sub_agent2')).toMatchObject({ username: 'sub_agent2' });
    await manager.close();
  });

  it('serializes concurrent spawns into five neutral workers', async () => {
    const identities: BotIdentity[] = [];
    const provisioner: TrueForgeProvisionerPort = {
      ensureProvider: async () => undefined,
      deleteSession: async () => undefined,
      provisionBot: async ({ identity }) => ({
        agentId: `agent-${String(identity.ordinal)}`,
        sessionId: `session-${String(identity.ordinal)}`,
        createdSession: true,
      }),
    };
    const manager = new WorkforceManager(
      managerOptions({ stateDirectory: await temporaryDirectory(), provisioner, identities }),
    );
    await manager.start();
    const spawned = await Promise.all(Array.from({ length: 5 }, async () => await manager.spawn()));

    expect(spawned.map(bot => [bot.username, bot.role])).toEqual([
      ['ForgeBot1', 'generalist'],
      ['ForgeBot2', 'generalist'],
      ['ForgeBot3', 'generalist'],
      ['ForgeBot4', 'generalist'],
      ['ForgeBot5', 'generalist'],
    ]);
    expect(new Set(identities.map(identity => identity.slug)).size).toBe(5);
    await expect(manager.spawn()).rejects.toBeInstanceOf(WorkforceCapacityError);
    await manager.close();
  });

  it('restores the saved bot with the same TrueForge session', async () => {
    const stateDirectory = await temporaryDirectory();
    const firstProvisioner: TrueForgeProvisionerPort = {
      ensureProvider: async () => undefined,
      deleteSession: async () => undefined,
      provisionBot: async () => ({ agentId: 'agent-1', sessionId: 'session-1', createdSession: true }),
    };
    const first = new WorkforceManager(
      managerOptions({ stateDirectory, provisioner: firstProvisioner, identities: [] }),
    );
    await first.start();
    await first.spawn();
    await first.close();

    const restoredRecords: string[] = [];
    const secondProvisioner: TrueForgeProvisionerPort = {
      ensureProvider: async () => undefined,
      deleteSession: async () => undefined,
      provisionBot: async ({ existingRecord }) => {
        if (existingRecord === undefined) {
          throw new Error('Expected a persisted bot record.');
        }
        restoredRecords.push(existingRecord.sessionId);
        return { agentId: existingRecord.agentId, sessionId: existingRecord.sessionId, createdSession: false };
      },
    };
    const restored = new WorkforceManager(
      managerOptions({ stateDirectory, provisioner: secondProvisioner, identities: [] }),
    );
    await restored.start();

    expect(restoredRecords).toEqual(['session-1']);
    expect(restored.list()).toEqual([
      expect.objectContaining({ username: 'ForgeBot1', role: 'generalist', sessionId: 'session-1' }),
    ]);
    await restored.close();
  });

  it('persists replacement TrueForge resources discovered during restoration', async () => {
    const stateDirectory = await temporaryDirectory();
    const initial = new WorkforceManager(
      managerOptions({
        stateDirectory,
        provisioner: {
          ensureProvider: async () => undefined,
          deleteSession: async () => undefined,
          provisionBot: async () => ({
            agentId: 'old-agent',
            sessionId: 'old-session',
            createdSession: true,
          }),
        },
        identities: [],
      }),
    );
    await initial.start();
    await initial.spawn();
    await initial.close();

    const restored = new WorkforceManager(
      managerOptions({
        stateDirectory,
        provisioner: {
          ensureProvider: async () => undefined,
          deleteSession: async () => undefined,
          provisionBot: async () => ({
            agentId: 'new-agent',
            sessionId: 'new-session',
            createdSession: true,
          }),
        },
        identities: [],
      }),
    );
    await restored.start();
    expect(await loadWorkforceState(stateDirectory)).toMatchObject({
      bots: [{ agentId: 'new-agent', sessionId: 'new-session' }],
    });
    await restored.close();
  });

  it('rolls back only the latest unplaced bot and reuses its slot', async () => {
    const stateDirectory = await temporaryDirectory();
    const deleteSession = vi.fn(async () => undefined);
    const manager = new WorkforceManager(
      managerOptions({
        stateDirectory,
        provisioner: {
          ensureProvider: async () => undefined,
          deleteSession,
          provisionBot: async ({ identity }) => ({
            agentId: `agent-${String(identity.ordinal)}`,
            sessionId: `session-${String(identity.ordinal)}`,
            createdSession: true,
          }),
        },
        identities: [],
      }),
    );
    await manager.start();
    await manager.spawn();
    await manager.spawn();

    await expect(manager.rollback('ForgeBot1')).resolves.toBe(false);
    await expect(manager.rollback('ForgeBot2')).resolves.toBe(true);
    expect(deleteSession).toHaveBeenCalledWith('session-2');
    expect(manager.list().map(bot => bot.username)).toEqual(['ForgeBot1']);
    expect(await loadWorkforceState(stateDirectory)).toMatchObject({ nextOrdinal: 2 });
    await expect(manager.spawn()).resolves.toMatchObject({ username: 'ForgeBot2' });
    await manager.close();
  });

  it('does not delete a session when the durable rollback commit fails', async () => {
    const stateDirectory = await temporaryDirectory();
    const deleteSession = vi.fn(async () => undefined);
    const manager = new WorkforceManager(
      managerOptions({
        stateDirectory,
        provisioner: {
          ensureProvider: async () => undefined,
          deleteSession,
          provisionBot: async () => ({ agentId: 'agent-1', sessionId: 'session-1', createdSession: true }),
        },
        identities: [],
      }),
    );
    await manager.start();
    await manager.spawn();
    await rm(stateDirectory, { recursive: true });
    await writeFile(stateDirectory, 'blocks-directory-creation');

    await expect(manager.rollback('ForgeBot1')).rejects.toThrow();
    expect(deleteSession).not.toHaveBeenCalled();
    expect(manager.list()).toEqual([expect.objectContaining({ username: 'ForgeBot1', sessionId: 'session-1' })]);
    await manager.close();
  });

  it('durably retries a session deletion interrupted during rollback', async () => {
    const stateDirectory = await temporaryDirectory();
    const firstDelete = vi.fn(async () => {
      throw new Error('TrueForge unavailable');
    });
    const first = new WorkforceManager(
      managerOptions({
        stateDirectory,
        provisioner: {
          ensureProvider: async () => undefined,
          deleteSession: firstDelete,
          provisionBot: async () => ({ agentId: 'agent-1', sessionId: 'session-1', createdSession: true }),
        },
        identities: [],
      }),
    );
    await first.start();
    await first.spawn();

    await expect(first.rollback('ForgeBot1')).rejects.toThrow('TrueForge unavailable');
    expect(first.list()).toEqual([]);
    expect(await loadWorkforceState(stateDirectory)).toMatchObject({
      bots: [],
      pendingSessionDeletes: ['session-1'],
    });
    await first.close();

    const retryDelete = vi.fn(async () => undefined);
    const restarted = new WorkforceManager(
      managerOptions({
        stateDirectory,
        provisioner: {
          ensureProvider: async () => undefined,
          deleteSession: retryDelete,
          provisionBot: async () => {
            throw new Error('No bot should be restored.');
          },
        },
        identities: [],
      }),
    );
    await restarted.start();

    expect(retryDelete).toHaveBeenCalledWith('session-1');
    expect(await loadWorkforceState(stateDirectory)).toMatchObject({ pendingSessionDeletes: [] });
    await restarted.close();
  });

  it('cancels the active action queue when TrueForge reports a terminal turn', async () => {
    let onTurnCancelled: (() => void) | undefined;
    const options = managerOptions({
      stateDirectory: await temporaryDirectory(),
      provisioner: {
        ensureProvider: async () => undefined,
        deleteSession: async () => undefined,
        provisionBot: async () => ({
          agentId: 'agent-1',
          sessionId: 'session-1',
          createdSession: true,
        }),
      },
      identities: [],
    });
    options.createController = controllerOptions => {
      onTurnCancelled = controllerOptions.onTurnCancelled;
      return { start: async () => undefined, close: async () => undefined };
    };
    const manager = new WorkforceManager(options);
    await manager.start();
    await manager.spawn();
    const context = manager.resolveBySlug('forgebot1');
    if (context === null) {
      throw new Error('Expected ForgeBot1 to be active.');
    }
    const cancelActive = vi.spyOn(context.actionQueue, 'cancelActive');

    if (onTurnCancelled === undefined) {
      throw new Error('Expected the controller cancellation callback.');
    }
    onTurnCancelled();

    expect(cancelActive).toHaveBeenCalledOnce();
    await manager.close();
  });

  it('deletes a newly created TrueForge session when activation fails', async () => {
    const deleteSession = vi.fn(async () => undefined);
    const options = managerOptions({
      stateDirectory: await temporaryDirectory(),
      provisioner: {
        ensureProvider: async () => undefined,
        deleteSession,
        provisionBot: async () => ({
          agentId: 'agent-1',
          sessionId: 'new-session',
          createdSession: true,
        }),
      },
      identities: [],
    });
    options.createController = () => ({
      start: async () => {
        throw new Error('Controller startup failed.');
      },
      close: async () => undefined,
    });
    const manager = new WorkforceManager(options);
    await manager.start();

    await expect(manager.spawn()).rejects.toThrow('Could not activate ForgeBot1');
    expect(deleteSession).toHaveBeenCalledWith('new-session');
    await manager.close();
  });

  it('deletes replacement sessions when a later restoration fails', async () => {
    const stateDirectory = await temporaryDirectory();
    const initial = new WorkforceManager(
      managerOptions({
        stateDirectory,
        provisioner: {
          ensureProvider: async () => undefined,
          deleteSession: async () => undefined,
          provisionBot: async ({ identity }) => ({
            agentId: `old-agent-${String(identity.ordinal)}`,
            sessionId: `old-session-${String(identity.ordinal)}`,
            createdSession: true,
          }),
        },
        identities: [],
      }),
    );
    await initial.start();
    await initial.spawn();
    await initial.spawn();
    await initial.close();

    const deleteSession = vi.fn(async () => undefined);
    const options = managerOptions({
      stateDirectory,
      provisioner: {
        ensureProvider: async () => undefined,
        deleteSession,
        provisionBot: async ({ identity }) => ({
          agentId: `new-agent-${String(identity.ordinal)}`,
          sessionId: `new-session-${String(identity.ordinal)}`,
          createdSession: true,
        }),
      },
      identities: [],
    });
    const createBot = options.createBot;
    options.createBot = identity => {
      const bot = createBot(identity);
      if (identity.ordinal === 2) {
        bot.start = async () => {
          throw new Error('Second bot failed to connect.');
        };
      }
      return bot;
    };
    const restored = new WorkforceManager(options);

    await expect(restored.start()).rejects.toThrow('Could not restore the Minecraft workforce');
    expect(deleteSession).toHaveBeenCalledWith('new-session-1');
    await restored.close();
  });
});
