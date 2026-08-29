import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { request as httpRequest } from 'node:http';
import { MinecraftActionQueue } from '../src/actionQueue.js';
import type { MinecraftBotPort, WorldObservation } from '../src/botPort.js';
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
    locateNaturalTrees: () => [],
    moveTo: async () => {},
    gather: async ({ count }) => ({ requested: count, completed: count, details: [] }),
    harvestTrees: async ({ count }) => ({ requested: count, completed: count, details: [] }),
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
      'locate_trees',
      'announce',
      'begin_plan',
      'move_to',
      'gather_blocks',
      'harvest_tree',
      'craft_item',
      'execute_blueprint',
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

  it('locates natural trees, announces status, and harvests only under an approved gather plan', async () => {
    const bot = fakeBot();
    const say = vi.fn(async () => {});
    const harvestTrees = vi.fn<MinecraftBotPort['harvestTrees']>(async ({ count }) => ({
      requested: count,
      completed: 5,
      details: ['Harvested one complete tree and verified five logs.'],
    }));
    bot.say = say;
    bot.locateNaturalTrees = () => [
      {
        logName: 'oak_log',
        root: { x: 4, y: 64, z: 2 },
        logs: [
          { x: 4, y: 64, z: 2 },
          { x: 4, y: 65, z: 2 },
          { x: 4, y: 66, z: 2 },
        ],
      },
    ];
    bot.harvestTrees = harvestTrees;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMinecraftMcpServer({
      bot,
      planStore: new PlanStore(),
      actionQueue: new MinecraftActionQueue(),
      additionalPlanOrigins: [{ x: -46, y: 66, z: -6 }],
    });
    const client = new Client({ name: 'minecraft-lumberjack-test', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const located = TextResultSchema.parse(
      await client.callTool({ name: 'locate_trees', arguments: { block_name: 'oak_log', max_distance: 16 } }),
    );
    expect(JSON.parse(firstText(located))).toMatchObject({
      trees: [{ logName: 'oak_log', root: { x: 4, y: 64, z: 2 } }],
    });

    const announced = TextResultSchema.parse(
      await client.callTool({ name: 'announce', arguments: { message: 'I am looking for an oak tree.' } }),
    );
    expect(announced.isError).not.toBe(true);
    expect(say).toHaveBeenCalledWith('I am looking for an oak tree.');

    const denied = TextResultSchema.parse(
      await client.callTool({
        name: 'harvest_tree',
        arguments: { plan_id: 'missing', block_name: 'oak_log', count: 4, max_distance: 16 },
      }),
    );
    expect(denied.isError).toBe(true);

    const begun = TextResultSchema.parse(
      await client.callTool({
        name: 'begin_plan',
        arguments: {
          summary: 'Gather oak logs',
          steps: ['Find a natural tree', 'Harvest the whole tree'],
          permitted_actions: ['gather'],
          duration_minutes: 5,
          radius_blocks: 16,
        },
      }),
    );
    const parsedPlan = z
      .object({
        plan: z.object({
          id: z.string(),
          additionalOrigins: z.array(z.object({ x: z.number(), y: z.number(), z: z.number() })),
        }),
      })
      .parse(JSON.parse(firstText(begun)));
    expect(parsedPlan.plan.additionalOrigins).toEqual([{ x: -46, y: 66, z: -6 }]);
    const harvested = TextResultSchema.parse(
      await client.callTool({
        name: 'harvest_tree',
        arguments: { plan_id: parsedPlan.plan.id, block_name: 'oak_log', count: 4, max_distance: 16 },
      }),
    );
    expect(JSON.parse(firstText(harvested))).toMatchObject({ requested: 4, completed: 5 });
    expect(harvestTrees).toHaveBeenCalledOnce();

    await client.close();
    await server.close();
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

  it('resolves bot-scoped MCP paths and rejects unknown bots before reading a body', async () => {
    const paths: string[] = [];
    const httpServer = startMinecraftMcpHttpServer({
      host: '127.0.0.1',
      port: 0,
      resolveServerForRequest: path => {
        paths.push(path);
        return path === '/bots/forgebot1/mcp'
          ? () =>
              createMinecraftMcpServer({
                bot: fakeBot(),
                planStore: new PlanStore(),
                actionQueue: new MinecraftActionQueue(),
              })
          : null;
      },
    });
    await httpServer.listen();

    try {
      const response = await fetch(`http://127.0.0.1:${String(httpServer.port())}/bots/forgebot2/mcp`, {
        method: 'POST',
        body: '{',
      });
      expect(response.status).toBe(404);
      expect(paths).toEqual(['/bots/forgebot2/mcp']);
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
