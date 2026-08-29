import { describe, expect, it } from 'vitest';

import { createBotIdentity, createBotIdentityForRole, roleActivationMessage } from '../src/botRoles.js';

describe('bot role slots', () => {
  it('assigns deterministic identities and roles to the five demo bots', () => {
    expect(Array.from({ length: 5 }, (_, index) => createBotIdentity(index + 1))).toEqual([
      {
        ordinal: 1,
        username: 'ForgeBot1',
        slug: 'forgebot1',
        role: 'lumberjack',
        connectorName: 'minecraft-forgebot1',
        agentName: 'forgebot1-lumberjack',
      },
      expect.objectContaining({ ordinal: 2, username: 'ForgeBot2', role: 'miner' }),
      expect.objectContaining({ ordinal: 3, username: 'ForgeBot3', role: 'builder' }),
      expect.objectContaining({ ordinal: 4, username: 'ForgeBot4', role: 'hunter' }),
      expect.objectContaining({ ordinal: 5, username: 'ForgeBot5', role: 'scout' }),
    ]);
    expect(() => createBotIdentity(6)).toThrow('limited to five');
  });

  it('maps an explicitly selected role to its stable bot and session activation label', () => {
    const hunter = createBotIdentityForRole('hunter');

    expect(hunter).toMatchObject({ ordinal: 4, username: 'ForgeBot4', role: 'hunter' });
    expect(roleActivationMessage(hunter)).toBe('Hunter — ForgeBot4 · given an iron sword');
  });
});
