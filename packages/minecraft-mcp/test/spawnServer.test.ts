import { describe, expect, it } from 'vitest';

import { startSpawnServer } from '../src/spawnServer.js';
import { WorkforceCapacityError } from '../src/workforceManager.js';

const FORM = new URLSearchParams({
  requester_name: 'DemoPlayer',
  requester_uuid: '123e4567-e89b-12d3-a456-426614174000',
  world_name: 'world',
  world_uuid: '123e4567-e89b-12d3-a456-426614174001',
  x: '10.5',
  y: '64',
  z: '-2.5',
  yaw: '90',
  pitch: '0',
});

describe('Minecraft spawn ingress', () => {
  it('requires the shared token and accepts the Paper plugin form contract', async () => {
    const requests: string[] = [];
    const server = startSpawnServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token-at-least-16-characters',
      spawn: async request => {
        requests.push(request.requester_name);
        return {
          username: 'ForgeBot1',
          role: 'lumberjack',
          agentName: 'forgebot1-lumberjack',
          sessionId: 'session-1',
          consoleUrl: 'http://127.0.0.1:8790/sessions/session-1',
        };
      },
    });
    await server.listen();
    try {
      const endpoint = `http://127.0.0.1:${String(server.port())}/spawn`;
      const denied = await fetch(endpoint, { method: 'POST', body: FORM });
      expect(denied.status).toBe(401);

      const accepted = await fetch(endpoint, {
        method: 'POST',
        headers: { 'x-minecraft-agent-token': 'test-token-at-least-16-characters' },
        body: FORM,
      });
      expect(accepted.status).toBe(201);
      expect(await accepted.text()).toBe('ForgeBot1');
      expect(requests).toEqual(['DemoPlayer']);
    } finally {
      await server.close();
    }
  });

  it('reports the workforce capacity conflict to the command plugin', async () => {
    const server = startSpawnServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token-at-least-16-characters',
      spawn: async () => {
        throw new WorkforceCapacityError('Five bots are already active.');
      },
    });
    await server.listen();
    try {
      const response = await fetch(`http://127.0.0.1:${String(server.port())}/spawn`, {
        method: 'POST',
        headers: { 'x-minecraft-agent-token': 'test-token-at-least-16-characters' },
        body: FORM,
      });
      expect(response.status).toBe(409);
      expect(await response.text()).toContain('Five bots');
    } finally {
      await server.close();
    }
  });
});
