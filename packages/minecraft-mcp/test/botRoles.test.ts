import { describe, expect, it } from 'vitest';

import { createBotIdentity } from '../src/botRoles.js';

describe('bot identities', () => {
  it('assigns the same neutral capabilities to every unprompted worker', () => {
    expect(Array.from({ length: 5 }, (_, index) => createBotIdentity(index + 1))).toEqual([
      {
        ordinal: 1,
        username: 'ForgeBot1',
        slug: 'forgebot1',
        role: 'generalist',
        connectorName: 'minecraft-forgebot1',
        agentName: 'forgebot1-generalist',
      },
      expect.objectContaining({ ordinal: 2, username: 'ForgeBot2', role: 'generalist' }),
      expect.objectContaining({ ordinal: 3, username: 'ForgeBot3', role: 'generalist' }),
      expect.objectContaining({ ordinal: 4, username: 'ForgeBot4', role: 'generalist' }),
      expect.objectContaining({ ordinal: 5, username: 'ForgeBot5', role: 'generalist' }),
    ]);
    expect(() => createBotIdentity(6)).toThrow('limited to five');
  });
});
