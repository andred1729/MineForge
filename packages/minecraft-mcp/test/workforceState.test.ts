import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createBotIdentity } from '../src/botRoles.js';
import { emptyWorkforceState, loadWorkforceState, saveWorkforceState } from '../src/workforceState.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async directory => await rm(directory, { recursive: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'minecraft-workforce-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

describe('workforce state', () => {
  it('defaults to an empty versioned workforce', async () => {
    expect(await loadWorkforceState(await temporaryDirectory())).toEqual(emptyWorkforceState());
  });

  it('persists validated bot resources atomically', async () => {
    const directory = await temporaryDirectory();
    const identity = createBotIdentity(1);
    const state = {
      version: 1 as const,
      nextOrdinal: 2,
      bots: [{ ...identity, agentId: 'agent-1', sessionId: 'session-1' }],
      pendingSessionDeletes: ['session-pending'],
    };
    await saveWorkforceState({ directory, state });
    expect(await loadWorkforceState(directory)).toEqual(state);
    expect(JSON.parse(await readFile(join(directory, 'minecraft-workforce.json'), 'utf8'))).toEqual(state);
  });
});
