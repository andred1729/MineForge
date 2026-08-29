import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { MinecraftActionQueue } from '../src/actionQueue.js';
import type { MinecraftBotPort, WorldObservation } from '../src/botPort.js';
import { BlueprintCatalog, ImportedBlueprintSchema } from '../src/grabcraftBlueprint.js';
import { createMinecraftMcpServer, startMinecraftMcpHttpServer } from '../src/mcpServer.js';
import { PlanStore } from '../src/planStore.js';

const TextResultSchema = z.object({
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })).min(1),
  isError: z.boolean().optional(),
});

function firstText(result: z.infer<typeof TextResultSchema>): string {
  const item = result.content[0];
  if (item === undefined) {
    throw new Error('Expected an MCP text result.');
  }
  return item.text;
}

function fakeBot(): MinecraftBotPort {
  const observation: WorldObservation = {
    connected: true,
    username: 'ForgeBot',
    position: { x: 0, y: 100, z: 0 },
    health: 20,
    food: 20,
    dimension: 'overworld',
    timeOfDay: 1_000,
    isRaining: false,
    inventory: [{ name: 'oak_planks', count: 64 }],
    nearbyBlocks: [],
    nearbyEntities: [],
  };
  return {
    start: async () => {},
    close: async () => {},
    isConnected: () => true,
    position: () => observation.position,
    inspect: () => observation,
    moveTo: async () => {},
    gather: async ({ count }) => ({ requested: count, completed: count, details: [] }),
    craft: async ({ count }) => ({ requested: count, completed: count, details: [] }),
    executeBlueprint: async ({ blocks }) => ({ requested: blocks.length, completed: blocks.length, details: [] }),
    drop: async ({ count }) => ({ requested: count, completed: count, details: [] }),
    stop: () => {},
    say: async () => {},
    onChat: () => () => {},
  };
}

describe('Minecraft MCP server', () => {
  it('publishes the bounded tool catalog and enforces plan ids', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMinecraftMcpServer({
      bot: fakeBot(),
      planStore: new PlanStore(),
      actionQueue: new MinecraftActionQueue(),
    });
    const client = new Client({ name: 'minecraft-test', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const catalog = await client.listTools();
    expect(catalog.tools.map(tool => tool.name)).toEqual([
      'inspect_world',
      'inspect_blueprint',
      'begin_plan',
      'move_to',
      'gather_blocks',
      'craft_item',
      'execute_blueprint',
      'execute_blueprint_batch',
      'drop_item',
      'finish_plan',
      'stop',
    ]);

    const denied = TextResultSchema.parse(
      await client.callTool({
        name: 'move_to',
        arguments: { plan_id: 'missing', target: { x: 1, y: 100, z: 1 }, range: 1 },
      }),
    );
    expect(denied.isError).toBe(true);
    expect(firstText(denied)).toContain('No active approved plan');

    const begun = TextResultSchema.parse(
      await client.callTool({
        name: 'begin_plan',
        arguments: {
          summary: 'Build a small shelter',
          steps: ['Place blocks'],
          permitted_actions: ['build'],
          duration_minutes: 5,
          radius_blocks: 8,
        },
      }),
    );
    const parsedPlan = z.object({ plan: z.object({ id: z.string() }) }).parse(JSON.parse(firstText(begun)));

    const forbidden = TextResultSchema.parse(
      await client.callTool({
        name: 'execute_blueprint',
        arguments: {
          plan_id: parsedPlan.plan.id,
          origin: { x: 0, y: 100, z: 0 },
          blocks: [{ dx: 0, dy: 0, dz: 0, block: 'tnt' }],
        },
      }),
    );
    expect(forbidden.isError).toBe(true);
    expect(firstText(forbidden)).toContain('forbidden');

    await client.close();
    await server.close();
  });

  it('revalidates plan authorization at mutation boundaries during an action', async () => {
    let now = 0;
    const planStore = new PlanStore(() => now);
    const bot = fakeBot();
    bot.executeBlueprint = async ({ blocks, assertAuthorized }) => {
      assertAuthorized();
      now = 60_001;
      assertAuthorized();
      return { requested: blocks.length, completed: blocks.length, details: [] };
    };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMinecraftMcpServer({
      bot,
      planStore,
      actionQueue: new MinecraftActionQueue(),
    });
    const client = new Client({ name: 'minecraft-expiry-test', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const begun = TextResultSchema.parse(
      await client.callTool({
        name: 'begin_plan',
        arguments: {
          summary: 'Build within one minute',
          steps: ['Place one block'],
          permitted_actions: ['build'],
          duration_minutes: 1,
          radius_blocks: 8,
        },
      }),
    );
    const parsedPlan = z.object({ plan: z.object({ id: z.string() }) }).parse(JSON.parse(firstText(begun)));
    const result = TextResultSchema.parse(
      await client.callTool({
        name: 'execute_blueprint',
        arguments: {
          plan_id: parsedPlan.plan.id,
          origin: { x: 0, y: 100, z: 0 },
          blocks: [{ dx: 0, dy: 0, dz: 0, block: 'oak_planks' }],
        },
      }),
    );

    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain('No active approved plan');
    await client.close();
    await server.close();
  });

  it('cancels the action currently controlling the bot when stop is called', async () => {
    const actionQueue = new MinecraftActionQueue();
    const cancelActive = vi.spyOn(actionQueue, 'cancelActive');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMinecraftMcpServer({
      bot: fakeBot(),
      planStore: new PlanStore(),
      actionQueue,
    });
    const client = new Client({ name: 'minecraft-stop-test', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = TextResultSchema.parse(
      await client.callTool({ name: 'stop', arguments: { reason: 'Manual test stop' } }),
    );

    expect(result.isError).not.toBe(true);
    expect(cancelActive).toHaveBeenCalledOnce();
    await client.close();
    await server.close();
  });

  it('binds an imported blueprint digest at approval and executes deterministic batches', async () => {
    const stateDirectory = await mkdtemp(`${tmpdir()}/minecraft-mcp-catalog-`);
    const catalog = new BlueprintCatalog(stateDirectory);
    const blueprint = ImportedBlueprintSchema.parse({
      schemaVersion: 1,
      id: 'test-villa',
      title: 'Test Villa',
      author: 'Builder',
      sourceUrl: 'https://www.grabcraft.com/minecraft/test-villa/modern-houses',
      renderUrl: 'https://www.grabcraft.com/js/RenderObject/myRenderObject_1.js',
      fetchedAt: new Date(0).toISOString(),
      digest: 'a'.repeat(64),
      dimensions: { x: 2, y: 1, z: 1 },
      sourceBlockCount: 2,
      supportedBlockCount: 2,
      skippedBlockCount: 0,
      materialCounts: { quartz_block: 2 },
      layerCounts: { '1': 2 },
      skippedMaterials: [],
      blocks: [
        { dx: 0, dy: 0, dz: 0, block: 'quartz_block', legacyName: 'Quartz Block', phase: 'structure' },
        { dx: 1, dy: 0, dz: 0, block: 'quartz_block', legacyName: 'Quartz Block', phase: 'structure' },
      ],
    });
    await catalog.save(blueprint);
    const bot = fakeBot();
    const executeBlueprint = vi.spyOn(bot, 'executeBlueprint');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMinecraftMcpServer({
      bot,
      planStore: new PlanStore(),
      actionQueue: new MinecraftActionQueue(),
      blueprintCatalog: catalog,
    });
    const client = new Client({ name: 'minecraft-blueprint-test', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const inspection = TextResultSchema.parse(
        await client.callTool({ name: 'inspect_blueprint', arguments: { blueprint_id: blueprint.id } }),
      );
      expect(JSON.parse(firstText(inspection))).toMatchObject({
        blueprint: {
          digest: blueprint.digest,
          supported_block_count: 2,
          batch_count: 1,
          recommended_origin: { x: -1, y: 100, z: 0 },
        },
      });
      const begun = TextResultSchema.parse(
        await client.callTool({
          name: 'begin_plan',
          arguments: {
            summary: 'Build the approved villa',
            steps: ['Execute its deterministic batch'],
            permitted_actions: ['build'],
            duration_minutes: 30,
            radius_blocks: 8,
            blueprint: {
              blueprint_id: blueprint.id,
              digest: blueprint.digest,
              origin: { x: -1, y: 100, z: 0 },
            },
          },
        }),
      );
      const plan = z.object({ plan: z.object({ id: z.string() }) }).parse(JSON.parse(firstText(begun))).plan;
      const execution = TextResultSchema.parse(
        await client.callTool({
          name: 'execute_blueprint_batch',
          arguments: {
            plan_id: plan.id,
            blueprint_id: blueprint.id,
            digest: blueprint.digest,
            batch_index: 0,
          },
        }),
      );

      expect(execution.isError).not.toBe(true);
      expect(JSON.parse(firstText(execution))).toMatchObject({
        batch_index: 0,
        batch_count: 1,
        next_batch_index: null,
      });
      expect(executeBlueprint).toHaveBeenCalledWith(
        expect.objectContaining({
          origin: { x: -1, y: 100, z: 0 },
          blocks: [
            { dx: 0, dy: 0, dz: 0, block: 'quartz_block' },
            { dx: 1, dy: 0, dz: 0, block: 'quartz_block' },
          ],
        }),
      );
    } finally {
      await client.close();
      await server.close();
      await rm(stateDirectory, { recursive: true });
    }
  });

  it('rejects oversized request bodies with HTTP 413 before creating an MCP server', async () => {
    let createdServers = 0;
    const httpServer = startMinecraftMcpHttpServer({
      host: '127.0.0.1',
      port: 0,
      maxRequestBytes: 64,
      createServerForRequest: () => {
        createdServers += 1;
        return createMinecraftMcpServer({
          bot: fakeBot(),
          planStore: new PlanStore(),
          actionQueue: new MinecraftActionQueue(),
        });
      },
    });
    await httpServer.listen();

    try {
      const response = await fetch(`http://127.0.0.1:${String(httpServer.port())}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: 'x'.repeat(128) }),
      });
      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toMatchObject({
        error: { message: 'Request body is too large.' },
      });
      expect(createdServers).toBe(0);
    } finally {
      await httpServer.close();
    }
  });

  it('times out incomplete request bodies without invoking the MCP transport', async () => {
    let createdServers = 0;
    const httpServer = startMinecraftMcpHttpServer({
      host: '127.0.0.1',
      port: 0,
      requestTimeoutMs: 50,
      createServerForRequest: () => {
        createdServers += 1;
        return createMinecraftMcpServer({
          bot: fakeBot(),
          planStore: new PlanStore(),
          actionQueue: new MinecraftActionQueue(),
        });
      },
    });
    await httpServer.listen();

    try {
      const response = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
        const request = httpRequest(
          {
            host: '127.0.0.1',
            port: httpServer.port(),
            path: '/mcp',
            method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': '100' },
          },
          incoming => {
            let body = '';
            incoming.setEncoding('utf8');
            incoming.on('data', chunk => {
              body += chunk;
            });
            incoming.on('end', () => {
              resolve({ status: incoming.statusCode, body });
              request.destroy();
            });
          },
        );
        request.on('error', reject);
        request.write('{"jsonrpc":');
      });

      expect(response.status).toBe(408);
      expect(JSON.parse(response.body)).toMatchObject({ error: { message: 'Request body timed out.' } });
      expect(createdServers).toBe(0);
    } finally {
      await httpServer.close();
    }
  });
});
