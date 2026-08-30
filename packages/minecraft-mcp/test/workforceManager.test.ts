import { mkdtemp, rm } from 'node:fs/promises';
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
        provisionBot: async ({ identity }) => ({ agentId: `agent-${identity.slug}`, sessionId: 'builder-session' }),
      },
      identities,
    });
    options.createHelperBot = username => fakeBot({ username });
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
    expect(manager.resolveBuildWorker('forgebot1', 'sub_agent2')).toMatchObject({ username: 'sub_agent2' });
    await manager.close();
  });

  it('serializes concurrent spawns into five neutral workers', async () => {
    const identities: BotIdentity[] = [];
    const provisioner: TrueForgeProvisionerPort = {
      ensureProvider: async () => undefined,
      provisionBot: async ({ identity }) => ({
        agentId: `agent-${String(identity.ordinal)}`,
        sessionId: `session-${String(identity.ordinal)}`,
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
      provisionBot: async () => ({ agentId: 'agent-1', sessionId: 'session-1' }),
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
      provisionBot: async ({ existingRecord }) => {
        if (existingRecord === undefined) {
          throw new Error('Expected a persisted bot record.');
        }
        restoredRecords.push(existingRecord.sessionId);
        return { agentId: existingRecord.agentId, sessionId: existingRecord.sessionId };
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
          provisionBot: async () => ({ agentId: 'old-agent', sessionId: 'old-session' }),
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
          provisionBot: async () => ({ agentId: 'new-agent', sessionId: 'new-session' }),
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
    const manager = new WorkforceManager(
      managerOptions({
        stateDirectory,
        provisioner: {
          ensureProvider: async () => undefined,
          provisionBot: async ({ identity }) => ({
            agentId: `agent-${String(identity.ordinal)}`,
            sessionId: `session-${String(identity.ordinal)}`,
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
    expect(manager.list().map(bot => bot.username)).toEqual(['ForgeBot1']);
    expect(await loadWorkforceState(stateDirectory)).toMatchObject({ nextOrdinal: 2 });
    await expect(manager.spawn()).resolves.toMatchObject({ username: 'ForgeBot2' });
    await manager.close();
  });
});
