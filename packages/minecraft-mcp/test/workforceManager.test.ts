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

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async directory => await rm(directory, { recursive: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'minecraft-workforce-manager-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

function fakeBot(identity: BotIdentity): ManagedMinecraftBot {
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
    startViewer: vi.fn(),
    isConnected: () => true,
    position: () => observation.position,
    inspect: () => observation,
    locateNaturalTrees: () => [],
    moveTo: vi.fn(async () => undefined),
    gather: vi.fn(async ({ count }) => ({ requested: count, completed: count, details: [] })),
    harvestTrees: vi.fn(async ({ count }) => ({ requested: count, completed: count, details: [] })),
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
  it('serializes concurrent spawns into five unique role slots', async () => {
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
      ['ForgeBot1', 'lumberjack'],
      ['ForgeBot2', 'miner'],
      ['ForgeBot3', 'builder'],
      ['ForgeBot4', 'hunter'],
      ['ForgeBot5', 'scout'],
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
      expect.objectContaining({ username: 'ForgeBot1', role: 'lumberjack', sessionId: 'session-1' }),
    ]);
    await restored.close();
  });
});
