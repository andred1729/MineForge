import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { MinecraftActionQueue } from './actionQueue.js';
import type { MinecraftBotPort } from './botPort.js';
import {
  BeginPlanInputSchema,
  BlueprintSchema,
  PlanOutcomeSchema,
  PositionSchema,
  type PlanTerminalEvent,
} from './domain.js';
import { PlanStore } from './planStore.js';

const FORBIDDEN_BLUEPRINT_BLOCKS = new Set([
  'bedrock',
  'command_block',
  'chain_command_block',
  'fire',
  'lava',
  'repeating_command_block',
  'structure_block',
  'tnt',
]);

const PlanIdSchema = z.string().min(1);

function jsonToolResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  };
}

function toolError(caught: unknown) {
  const message = caught instanceof Error ? caught.message : 'Unknown Minecraft tool error.';
  return {
    isError: true,
    content: [{ type: 'text' as const, text: message }],
  };
}

async function executeTool<T>(operation: () => Promise<T> | T) {
  try {
    return jsonToolResult(await operation());
  } catch (caught) {
    return toolError(caught);
  }
}

async function executeActionTool<T>({
  signal,
  bot,
  planStore,
  actionQueue,
  operation,
}: {
  signal: AbortSignal;
  bot: MinecraftBotPort;
  planStore: PlanStore;
  actionQueue: MinecraftActionQueue;
  operation: () => Promise<T>;
}) {
  let active = false;
  const handleAbort = () => {
    planStore.invalidate();
    if (active) {
      bot.stop();
    }
  };
  signal.addEventListener('abort', handleAbort, { once: true });
  try {
    return await actionQueue.run({
      signal,
      operation: async () => {
        active = true;
        try {
          return await executeTool(operation);
        } finally {
          active = false;
        }
      },
    });
  } catch (caught) {
    return toolError(caught);
  } finally {
    signal.removeEventListener('abort', handleAbort);
  }
}

function validateBlueprint({
  planStore,
  planId,
  origin,
  blocks,
}: {
  planStore: PlanStore;
  planId: string;
  origin: z.infer<typeof PositionSchema>;
  blocks: z.infer<typeof BlueprintSchema>['blocks'];
}) {
  const plan = planStore.require({ planId, action: 'build' });
  planStore.assertWithinBounds({ plan, position: origin });
  const coordinates = new Set<string>();
  for (const block of blocks) {
    if (FORBIDDEN_BLUEPRINT_BLOCKS.has(block.block)) {
      throw new Error(`${block.block} is forbidden in a v1 blueprint.`);
    }
    const target = {
      x: origin.x + block.dx,
      y: origin.y + block.dy,
      z: origin.z + block.dz,
    };
    planStore.assertWithinBounds({ plan, position: target });
    const coordinate = [target.x, target.y, target.z].join(',');
    if (coordinates.has(coordinate)) {
      throw new Error(`Blueprint contains duplicate target ${coordinate}.`);
    }
    coordinates.add(coordinate);
  }
  return plan;
}

export function createMinecraftMcpServer({
  bot,
  planStore,
  actionQueue,
  onPlanTerminal,
}: {
  bot: MinecraftBotPort;
  planStore: PlanStore;
  actionQueue: MinecraftActionQueue;
  onPlanTerminal: (event: PlanTerminalEvent) => void;
}): McpServer {
  const server = new McpServer({ name: 'minecraft-agent', version: '0.1.0' });

  server.registerTool(
    'inspect_world',
    {
      description:
        'Inspect ForgeBot position, health, inventory, nearby blocks/entities, and the active approved plan.',
      inputSchema: z.object({ radius: z.number().int().min(1).max(12).default(8) }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ radius }) =>
      await executeTool(() => ({ observation: bot.inspect({ radius }), active_plan: planStore.current() })),
  );

  server.registerTool(
    'begin_plan',
    {
      description:
        'Request human approval for one bounded Minecraft plan. Call this before every state-changing action and wait for the returned plan_id.',
      inputSchema: BeginPlanInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async input =>
      await executeTool(async () => {
        const plan = planStore.begin({ input, origin: bot.position() });
        await bot.say(`Approved plan started: ${plan.summary}`);
        return { plan };
      }),
  );

  server.registerTool(
    'move_to',
    {
      description: 'Move ForgeBot to a target inside the active approved plan bounds.',
      inputSchema: z.object({
        plan_id: PlanIdSchema,
        target: PositionSchema,
        range: z.number().int().min(1).max(4).default(1),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ plan_id: planId, target, range }, extra) =>
      await executeActionTool({
        signal: extra.signal,
        bot,
        planStore,
        actionQueue,
        operation: async () => {
          const plan = planStore.require({ planId, action: 'move' });
          planStore.assertWithinBounds({ plan, position: target });
          await bot.moveTo({ target, range, plan, signal: extra.signal });
          return { position: bot.position() };
        },
      }),
  );

  server.registerTool(
    'gather_blocks',
    {
      description: 'Find, navigate to, and mine a bounded number of one block type.',
      inputSchema: z.object({
        plan_id: PlanIdSchema,
        block_name: z.string().min(1).max(64),
        count: z.number().int().min(1).max(32),
        max_distance: z.number().int().min(1).max(32).default(24),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ plan_id: planId, block_name: blockName, count, max_distance: maxDistance }, extra) =>
      await executeActionTool({
        signal: extra.signal,
        bot,
        planStore,
        actionQueue,
        operation: async () => {
          const plan = planStore.require({ planId, action: 'gather' });
          const boundedDistance = Math.min(maxDistance, plan.radiusBlocks);
          return await bot.gather({
            blockName,
            count,
            maxDistance: boundedDistance,
            plan,
            signal: extra.signal,
          });
        },
      }),
  );

  server.registerTool(
    'craft_item',
    {
      description: 'Craft an item from the bot inventory, using a nearby crafting table when required.',
      inputSchema: z.object({
        plan_id: PlanIdSchema,
        item_name: z.string().min(1).max(64),
        count: z.number().int().min(1).max(64),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ plan_id: planId, item_name: itemName, count }, extra) =>
      await executeActionTool({
        signal: extra.signal,
        bot,
        planStore,
        actionQueue,
        operation: async () => {
          planStore.require({ planId, action: 'craft' });
          return await bot.craft({ itemName, count, signal: extra.signal });
        },
      }),
  );

  server.registerTool(
    'execute_blueprint',
    {
      description:
        'Execute up to 128 exact relative block placements/removals. Use block "air" for removal. Operations are resumable and skip already-correct blocks.',
      inputSchema: BlueprintSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ plan_id: planId, origin, blocks }, extra) =>
      await executeActionTool({
        signal: extra.signal,
        bot,
        planStore,
        actionQueue,
        operation: async () => {
          const plan = validateBlueprint({ planStore, planId, origin, blocks });
          return await bot.executeBlueprint({ origin, blocks, plan, signal: extra.signal });
        },
      }),
  );

  server.registerTool(
    'drop_item',
    {
      description: 'Drop a bounded quantity of an inventory item.',
      inputSchema: z.object({
        plan_id: PlanIdSchema,
        item_name: z.string().min(1).max(64),
        count: z.number().int().min(1).max(64),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ plan_id: planId, item_name: itemName, count }, extra) =>
      await executeActionTool({
        signal: extra.signal,
        bot,
        planStore,
        actionQueue,
        operation: async () => {
          planStore.require({ planId, action: 'drop' });
          return await bot.drop({ itemName, count, signal: extra.signal });
        },
      }),
  );

  server.registerTool(
    'finish_plan',
    {
      description: 'Close the active plan with a concise completed or failed outcome and evidence.',
      inputSchema: z.object({
        plan_id: PlanIdSchema,
        outcome: PlanOutcomeSchema,
        summary: z.string().min(1).max(500),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ plan_id: planId, outcome, summary }, extra) =>
      await executeActionTool({
        signal: extra.signal,
        bot,
        planStore,
        actionQueue,
        operation: async () => {
          planStore.finish(planId);
          const event: PlanTerminalEvent = { type: 'plan_terminal', planId, outcome, summary };
          onPlanTerminal(event);
          await bot.say(`Plan ${outcome}: ${summary}`);
          return { outcome, summary };
        },
      }),
  );

  server.registerTool(
    'stop',
    {
      description: 'Immediately stop ForgeBot and invalidate the active plan. This tool never needs a plan_id.',
      inputSchema: z.object({ reason: z.string().min(1).max(300).default('Stopped by request') }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ reason }) =>
      await executeTool(async () => {
        bot.stop();
        planStore.invalidate();
        await bot.say(reason);
        return { stopped: true, reason };
      }),
  );

  return server;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  request.setEncoding('utf8');
  const body = await new Promise<string>((resolve, reject) => {
    let value = '';
    request.on('data', (chunk: string) => {
      value += chunk;
    });
    request.on('end', () => {
      resolve(value);
    });
    request.on('error', reject);
  });
  return body.length === 0 ? undefined : JSON.parse(body);
}

function writeMethodNotAllowed(response: ServerResponse): void {
  response.writeHead(405, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32_000, message: 'Method not allowed.' }, id: null }));
}

/** Normalizes the SDK transport accessors for projects using exactOptionalPropertyTypes. */
class CompatibleStreamableTransport implements Transport {
  onclose: NonNullable<Transport['onclose']> = () => undefined;
  onerror: NonNullable<Transport['onerror']> = () => undefined;
  onmessage: NonNullable<Transport['onmessage']> = () => undefined;

  private readonly delegate = new StreamableHTTPServerTransport();

  constructor() {
    this.delegate.onclose = () => {
      this.onclose();
    };
    this.delegate.onerror = error => {
      this.onerror(error);
    };
    this.delegate.onmessage = (message, extra) => {
      this.onmessage(message, extra);
    };
  }

  async start(): Promise<void> {
    await this.delegate.start();
  }

  async close(): Promise<void> {
    await this.delegate.close();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    const relatedRequestId = options?.relatedRequestId;
    await this.delegate.send(message, relatedRequestId === undefined ? undefined : { relatedRequestId });
  }

  async handleRequest(request: IncomingMessage, response: ServerResponse, body: unknown): Promise<void> {
    await this.delegate.handleRequest(request, response, body);
  }
}

export function startMinecraftMcpHttpServer({
  host,
  port,
  createServerForRequest,
}: {
  host: string;
  port: number;
  createServerForRequest: () => McpServer;
}) {
  const httpServer = createServer((request, response) => {
    if (request.url === '/healthz' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (request.url !== '/mcp' || request.method !== 'POST') {
      writeMethodNotAllowed(response);
      return;
    }

    void (async () => {
      const mcpServer = createServerForRequest();
      const transport = new CompatibleStreamableTransport();
      try {
        const body = await readJsonBody(request);
        await mcpServer.connect(transport);
        await transport.handleRequest(request, response, body);
      } catch (caught) {
        console.error('Minecraft MCP request failed', caught);
        if (!response.headersSent) {
          response.writeHead(500, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({ jsonrpc: '2.0', error: { code: -32_603, message: 'Internal server error' }, id: null }),
          );
        }
      } finally {
        await transport.close();
        await mcpServer.close();
      }
    })();
  });

  return {
    async listen(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, host, () => {
          httpServer.off('error', reject);
          resolve();
        });
      });
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        httpServer.close(error => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      });
    },
  };
}
