import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { MinecraftActionQueue } from '../src/actionQueue.js';
import type { MinecraftBotPort, WorldObservation } from '../src/botPort.js';
import { createMinecraftMcpServer } from '../src/mcpServer.js';
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
      onPlanTerminal: () => {},
    });
    const client = new Client({ name: 'minecraft-test', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const catalog = await client.listTools();
    expect(catalog.tools.map(tool => tool.name)).toEqual([
      'inspect_world',
      'begin_plan',
      'move_to',
      'gather_blocks',
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
});
