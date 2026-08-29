import { describe, expect, it } from 'vitest';

import { startSpawnServer } from '../src/spawnServer.js';
import { WorkforceCapacityError } from '../src/workforceManager.js';

const FORM = new URLSearchParams({
  role: 'lumberjack',
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
    const requests: Array<[string, string | undefined]> = [];
    const server = startSpawnServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token-at-least-16-characters',
      rollback: async () => false,
      ready: async () => false,
      spawn: async request => {
        requests.push([request.requester_name, request.role]);
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
      expect(await accepted.text()).toBe('ForgeBot1:lumberjack');
      expect(requests).toEqual([['DemoPlayer', 'lumberjack']]);
    } finally {
      await server.close();
    }
  });

  it('reports the workforce capacity conflict to the command plugin', async () => {
    const server = startSpawnServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token-at-least-16-characters',
      rollback: async () => false,
      ready: async () => false,
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

  it('authenticates and forwards a failed placement rollback', async () => {
    const rolledBack: string[] = [];
    const server = startSpawnServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token-at-least-16-characters',
      spawn: async () => {
        throw new Error('Unexpected spawn.');
      },
      rollback: async username => {
        rolledBack.push(username);
        return true;
      },
      ready: async () => false,
    });
    await server.listen();
    try {
      const endpoint = `http://127.0.0.1:${String(server.port())}/spawn/rollback`;
      const denied = await fetch(endpoint, {
        method: 'POST',
        body: new URLSearchParams({ username: 'ForgeBot1' }),
      });
      expect(denied.status).toBe(401);

      const accepted = await fetch(endpoint, {
        method: 'POST',
        headers: { 'x-minecraft-agent-token': 'test-token-at-least-16-characters' },
        body: new URLSearchParams({ username: 'ForgeBot1' }),
      });
      expect(accepted.status).toBe(204);
      expect(rolledBack).toEqual(['ForgeBot1']);
    } finally {
      await server.close();
    }
  });

  it('authenticates and forwards the post-kit ready signal', async () => {
    const initialized: string[] = [];
    const server = startSpawnServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token-at-least-16-characters',
      spawn: async () => {
        throw new Error('Unexpected spawn.');
      },
      rollback: async () => false,
      ready: async username => {
        initialized.push(username);
        return true;
      },
    });
    await server.listen();
    try {
      const response = await fetch(`http://127.0.0.1:${String(server.port())}/spawn/ready`, {
        method: 'POST',
        headers: { 'x-minecraft-agent-token': 'test-token-at-least-16-characters' },
        body: new URLSearchParams({ username: 'ForgeBot4' }),
      });
      expect(response.status).toBe(204);
      expect(initialized).toEqual(['ForgeBot4']);
    } finally {
      await server.close();
    }
  });
});
