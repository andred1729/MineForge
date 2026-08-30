import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { MinecraftActionQueue } from './actionQueue.js';
import type { MinecraftBotPort } from './botPort.js';
import type { BotRole } from './botRoles.js';
import {
  BeginBlueprintPlanInputSchema,
  BeginPlanInputSchema,
  BlueprintSchema,
  PlanOutcomeSchema,
  PositionSchema,
  type Position,
} from './domain.js';
import { BlueprintCatalog, importGrabcraftBlueprint, type ImportedBlueprint } from './grabcraftBlueprint.js';
import { HuntSpeciesSchema } from './hunting.js';
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
const BlueprintIdSchema = z.string().regex(/^[a-z0-9-]+$/);
const BlueprintDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const BLUEPRINT_BATCH_SIZE = 128;

function jsonToolResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  };
}

function toolError(caught: unknown) {
  console.error('Minecraft MCP tool failed', caught);
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
  operation: (activeSignal: AbortSignal) => Promise<T>;
}) {
  const handleAbort = () => {
    planStore.invalidate();
    bot.stop();
  };
  try {
    return await actionQueue.run({
      signal,
      onAbort: handleAbort,
      operation: async activeSignal => await executeTool(async () => await operation(activeSignal)),
    });
  } catch (caught) {
    return toolError(caught);
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

function validateImportedBlueprintBounds({
  planStore,
  plan,
  blueprint,
}: {
  planStore: PlanStore;
  plan: ReturnType<PlanStore['require']>;
  blueprint: ImportedBlueprint;
}): void {
  const binding = plan.blueprint;
  if (binding === undefined) {
    throw new Error('The approved plan is not bound to an imported blueprint.');
  }
  if (binding.origin.y < -64 || binding.origin.y + blueprint.dimensions.y - 1 > 319) {
    throw new Error('Blueprint exceeds the Minecraft overworld build height.');
  }
  for (const dx of [0, blueprint.dimensions.x - 1]) {
    for (const dz of [0, blueprint.dimensions.z - 1]) {
      planStore.assertWithinBounds({
        plan,
        position: { x: binding.origin.x + dx, y: binding.origin.y, z: binding.origin.z + dz },
      });
    }
  }
}

export function createMinecraftMcpServer({
  bot,
  planStore,
  actionQueue,
  additionalPlanOrigins = [],
  blueprintCatalog = new BlueprintCatalog('.data'),
  recommendedBlueprintOrigin,
  enableCreativeMode,
  role,
}: {
  bot: MinecraftBotPort;
  planStore: PlanStore;
  actionQueue: MinecraftActionQueue;
  additionalPlanOrigins?: Position[];
  blueprintCatalog?: BlueprintCatalog;
  recommendedBlueprintOrigin?: Position;
  enableCreativeMode?: () => Promise<void>;
  role?: BotRole;
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
      await executeTool(() => ({
        observation: bot.inspect({ radius }),
        active_plan: planStore.current(),
        known_task_locations: additionalPlanOrigins,
      })),
  );

  server.registerTool(
    'locate_trees',
    {
      description:
        'Locate complete natural trees of one log type. Results exclude player log structures, partial trees, and trees crossing the search boundary.',
      inputSchema: z.object({
        block_name: z.string().min(1).max(64).default('oak_log'),
        max_distance: z.number().int().min(1).max(32).default(24),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ block_name: blockName, max_distance: maxDistance }) =>
      await executeTool(() => ({ trees: bot.locateNaturalTrees({ blockName, maxDistance }) })),
  );

  if (role === 'hunter' || role === 'generalist') {
    server.registerTool(
      'locate_animals',
      {
        description:
          'Locate nearby unnamed passive animals of one approved species. Players, villagers, pets, named animals, and hostile mobs are never returned.',
        inputSchema: z.object({
          species: HuntSpeciesSchema,
          max_distance: z.number().int().min(1).max(32).default(24),
        }),
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async ({ species, max_distance: maxDistance }) =>
        await executeTool(() => ({ animals: bot.locateAnimals({ species, maxDistance }) })),
    );
  }

  server.registerTool(
    'announce',
    {
      description: 'Say a concise status update in Minecraft chat so nearby players know what this bot is doing.',
      inputSchema: z.object({ message: z.string().min(1).max(300) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ message }) =>
      await executeTool(async () => {
        await bot.say(message);
        return { announced: true, message };
      }),
  );

  server.registerTool(
    'import_blueprint_url',
    {
      description:
        'Import and validate one GrabCraft blueprint URL into the local bridge catalog without evaluating remote JavaScript.',
      inputSchema: z.object({ url: z.url() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ url }) =>
      await executeTool(async () => {
        const blueprint = await importGrabcraftBlueprint(url);
        await blueprintCatalog.save(blueprint);
        return {
          blueprint_id: blueprint.id,
          title: blueprint.title,
          author: blueprint.author,
          digest: blueprint.digest,
          dimensions: blueprint.dimensions,
          supported_block_count: blueprint.supportedBlockCount,
          skipped_block_count: blueprint.skippedBlockCount,
        };
      }),
  );

  server.registerTool(
    'inspect_blueprint',
    {
      description:
        'Inspect an imported complex blueprint before approval, including its immutable digest, footprint, materials, batches, and intentionally skipped blocks.',
      inputSchema: z.object({ blueprint_id: BlueprintIdSchema.default('grabcraft-small-modern-villa') }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ blueprint_id: blueprintId }) =>
      await executeTool(async () => {
        const blueprint = await blueprintCatalog.load(blueprintId);
        const botPosition = bot.position();
        return {
          blueprint: {
            id: blueprint.id,
            title: blueprint.title,
            author: blueprint.author,
            source_url: blueprint.sourceUrl,
            digest: blueprint.digest,
            dimensions: blueprint.dimensions,
            source_block_count: blueprint.sourceBlockCount,
            supported_block_count: blueprint.supportedBlockCount,
            skipped_block_count: blueprint.skippedBlockCount,
            batch_size: BLUEPRINT_BATCH_SIZE,
            batch_count: Math.ceil(blueprint.blocks.length / BLUEPRINT_BATCH_SIZE),
            material_counts: blueprint.materialCounts,
            layer_counts: blueprint.layerCounts,
            skipped_materials: blueprint.skippedMaterials,
            recommended_origin: recommendedBlueprintOrigin ?? {
              x: botPosition.x - Math.floor(blueprint.dimensions.x / 2),
              y: botPosition.y,
              z: botPosition.z - Math.floor(blueprint.dimensions.z / 2),
            },
          },
        };
      }),
  );

  server.registerTool(
    'enable_creative_mode',
    {
      description:
        'Request visible creative mode for this Builder. TrueForge must obtain human approval before this tool executes.',
      inputSchema: z.object({ reason: z.string().min(1).max(300) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ reason }) =>
      await executeTool(async () => {
        if (enableCreativeMode === undefined) {
          throw new Error('Creative mode is unavailable for this Minecraft worker.');
        }
        await enableCreativeMode();
        await bot.say('Creative mode approved in TrueForge. I can now reach the full build safely.');
        return { creative_mode: true, reason };
      }),
  );

  server.registerTool(
    'begin_plan',
    {
      description:
        'Request human approval for a bounded movement, gathering, crafting, hunting, dropping, or small model-supplied build plan. This tool has no imported-blueprint fields.',
      inputSchema: BeginPlanInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async input =>
      await executeTool(async () => {
        const additionalOrigins = additionalPlanOrigins.map(({ x, y, z }) => ({ x, y, z }));
        const plan = planStore.begin({ input, origin: bot.position(), additionalOrigins });
        await bot.say(`Approved plan started: ${plan.summary}`);
        return { plan };
      }),
  );

  server.registerTool(
    'begin_blueprint_plan',
    {
      description:
        'Request human approval for an imported complex blueprint. Use only after import_blueprint_url and inspect_blueprint; the exact blueprint ID, digest, and origin are required.',
      inputSchema: BeginBlueprintPlanInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async input =>
      await executeTool(async () => {
        const additionalOrigins = additionalPlanOrigins.map(({ x, y, z }) => ({ x, y, z }));
        const blueprint = await blueprintCatalog.load(input.blueprint.blueprint_id);
        if (blueprint.digest !== input.blueprint.digest) {
          throw new Error('Blueprint digest does not match the imported artifact. Inspect it again before approval.');
        }
        const prospectivePlan = {
          id: 'prospective',
          summary: input.summary,
          steps: input.steps,
          permittedActions: input.permitted_actions,
          origin: bot.position(),
          additionalOrigins,
          radiusBlocks: input.radius_blocks,
          createdAt: 0,
          expiresAt: Number.MAX_SAFE_INTEGER,
          blueprint: input.blueprint,
        };
        validateImportedBlueprintBounds({ planStore, plan: prospectivePlan, blueprint });
        const plan = planStore.begin({ input, origin: bot.position(), additionalOrigins });
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
        operation: async activeSignal => {
          const plan = planStore.require({ planId, action: 'move' });
          planStore.assertWithinBounds({ plan, position: target });
          await bot.moveTo({
            target,
            range,
            plan,
            signal: activeSignal,
            assertAuthorized: () => planStore.require({ planId, action: 'move' }),
          });
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
        operation: async activeSignal => {
          const plan = planStore.require({ planId, action: 'gather' });
          const boundedDistance = Math.min(maxDistance, plan.radiusBlocks);
          return await bot.gather({
            blockName,
            count,
            maxDistance: boundedDistance,
            plan,
            signal: activeSignal,
            assertAuthorized: () => planStore.require({ planId, action: 'gather' }),
          });
        },
      }),
  );

  server.registerTool(
    'harvest_tree',
    {
      description:
        'Harvest complete natural trees until the requested log count is verified in inventory. The final tree is always finished, so completed may exceed requested.',
      inputSchema: z.object({
        plan_id: PlanIdSchema,
        block_name: z.string().min(1).max(64).default('oak_log'),
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
        operation: async activeSignal => {
          const plan = planStore.require({ planId, action: 'gather' });
          const boundedDistance = Math.min(maxDistance, plan.radiusBlocks);
          return await bot.harvestTrees({
            blockName,
            count,
            maxDistance: boundedDistance,
            plan,
            signal: activeSignal,
            assertAuthorized: () => planStore.require({ planId, action: 'gather' }),
          });
        },
      }),
  );

  if (role === 'hunter' || role === 'generalist') {
    server.registerTool(
      'hunt_animals',
      {
        description:
          'Pursue and kill a bounded number of unnamed passive animals, then collect and report verified drops. Only cows, pigs, sheep, and chickens are eligible.',
        inputSchema: z.object({
          plan_id: PlanIdSchema,
          species: HuntSpeciesSchema,
          count: z.number().int().min(1).max(8),
          max_distance: z.number().int().min(1).max(32).default(24),
        }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      },
      async ({ plan_id: planId, species, count, max_distance: maxDistance }, extra) =>
        await executeActionTool({
          signal: extra.signal,
          bot,
          planStore,
          actionQueue,
          operation: async activeSignal => {
            const plan = planStore.require({ planId, action: 'hunt' });
            const boundedDistance = Math.min(maxDistance, plan.radiusBlocks);
            return await bot.huntAnimals({
              species,
              count,
              maxDistance: boundedDistance,
              plan,
              signal: activeSignal,
              assertAuthorized: () => planStore.require({ planId, action: 'hunt' }),
            });
          },
        }),
    );
  }

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
        operation: async activeSignal => {
          planStore.require({ planId, action: 'craft' });
          return await bot.craft({
            itemName,
            count,
            signal: activeSignal,
            assertAuthorized: () => planStore.require({ planId, action: 'craft' }),
          });
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
        operation: async activeSignal => {
          const plan = validateBlueprint({ planStore, planId, origin, blocks });
          return await bot.executeBlueprint({
            origin,
            blocks,
            plan,
            signal: activeSignal,
            assertAuthorized: () => planStore.require({ planId, action: 'build' }),
          });
        },
      }),
  );

  server.registerTool(
    'execute_blueprint_batch',
    {
      description:
        'Build one deterministic batch from an approved imported blueprint. Repeating a batch is safe because already-correct blocks are verified and skipped.',
      inputSchema: z.object({
        plan_id: PlanIdSchema,
        blueprint_id: BlueprintIdSchema,
        digest: BlueprintDigestSchema,
        batch_index: z.number().int().min(0),
        worker_id: z.literal('lead').default('lead'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (
      { plan_id: planId, blueprint_id: blueprintId, digest, batch_index: batchIndex, worker_id: workerId },
      extra,
    ) => {
      const worker = { bot, actionQueue };
      return await executeActionTool({
        signal: extra.signal,
        bot: worker.bot,
        planStore,
        actionQueue: worker.actionQueue,
        operation: async activeSignal => {
          const plan = planStore.require({ planId, action: 'build' });
          const binding = plan.blueprint;
          if (binding?.blueprint_id !== blueprintId || binding.digest !== digest) {
            throw new Error('Blueprint request does not match the exact artifact approved in begin_blueprint_plan.');
          }
          const blueprint = await blueprintCatalog.load(blueprintId);
          if (blueprint.digest !== digest) {
            throw new Error('Imported blueprint changed after approval. Inspect it and begin a new plan.');
          }
          validateImportedBlueprintBounds({ planStore, plan, blueprint });
          const batchCount = Math.ceil(blueprint.blocks.length / BLUEPRINT_BATCH_SIZE);
          if (batchIndex >= batchCount) {
            throw new Error(`batch_index must be less than ${String(batchCount)}.`);
          }
          const batch = blueprint.blocks
            .slice(batchIndex * BLUEPRINT_BATCH_SIZE, (batchIndex + 1) * BLUEPRINT_BATCH_SIZE)
            .map(({ dx, dy, dz, block }) => ({ dx, dy, dz, block }));
          validateBlueprint({ planStore, planId, origin: binding.origin, blocks: batch });
          const batchStatus = planStore.blueprintBatchStatus({ planId, batchIndex });
          if (batchStatus === 'completed') {
            const nextBatchIndex = planStore.blueprintBatchCursor(planId);
            return {
              requested: batch.length,
              completed: batch.length,
              details: [`Blueprint batch ${String(batchIndex)} was already completed.`],
              blueprint_id: blueprintId,
              digest,
              batch_index: batchIndex,
              batch_count: batchCount,
              next_batch_index: nextBatchIndex < batchCount ? nextBatchIndex : null,
              worker_id: workerId,
              already_completed: true,
            };
          }
          const progress = await worker.bot.executeBlueprint({
            origin: binding.origin,
            blocks: batch,
            plan,
            signal: activeSignal,
            assertAuthorized: () => planStore.require({ planId, action: 'build' }),
          });
          if (progress.completed === batch.length) {
            planStore.completeBlueprintBatch({ planId, batchIndex });
          }
          return {
            ...progress,
            blueprint_id: blueprintId,
            digest,
            batch_index: batchIndex,
            batch_count: batchCount,
            next_batch_index:
              progress.completed === batch.length ? (batchIndex + 1 < batchCount ? batchIndex + 1 : null) : batchIndex,
            worker_id: workerId,
          };
        },
      });
    },
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
        operation: async activeSignal => {
          planStore.require({ planId, action: 'drop' });
          return await bot.drop({
            itemName,
            count,
            signal: activeSignal,
            assertAuthorized: () => planStore.require({ planId, action: 'drop' }),
          });
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
        actionQueue.cancelActive();
        bot.stop();
        planStore.invalidate();
        await bot.say(reason);
        return { stopped: true, reason };
      }),
  );

  return server;
}

const MAX_REQUEST_BYTES = 1_000_000;
const REQUEST_TIMEOUT_MS = 30_000;
const HEADERS_TIMEOUT_MS = 10_000;

class RequestBodyError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

async function readJsonBody(
  request: IncomingMessage,
  { maxBytes, timeoutMs }: { maxBytes: number; timeoutMs: number },
): Promise<unknown> {
  const body = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeout);
      request.removeListener('data', handleData);
      request.removeListener('end', handleEnd);
      request.removeListener('error', handleError);
      request.removeListener('aborted', handleAborted);
    };
    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      request.resume();
      reject(error);
    };
    const handleData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > maxBytes) {
        fail(new RequestBodyError('Request body is too large.', 413));
        return;
      }
      chunks.push(buffer);
    };
    const handleEnd = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, size));
    };
    const handleError = (error: Error) => {
      fail(error);
    };
    const handleAborted = () => {
      fail(new RequestBodyError('Request was aborted.', 400));
    };
    const timeout = setTimeout(() => {
      fail(new RequestBodyError('Request body timed out.', 408));
    }, timeoutMs);

    request.on('data', handleData);
    request.once('end', handleEnd);
    request.once('error', handleError);
    request.once('aborted', handleAborted);
  });
  if (body.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(body.toString('utf8'));
  } catch (caught) {
    throw new RequestBodyError('Request body is not valid JSON.', 400, { cause: caught });
  }
}

function writeMethodNotAllowed(response: ServerResponse): void {
  response.writeHead(405, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32_000, message: 'Method not allowed.' }, id: null }));
}

function writeNotFound(response: ServerResponse): void {
  response.writeHead(404, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32_001, message: 'MCP bot not found.' }, id: null }));
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
  resolveServerForRequest,
  maxRequestBytes = MAX_REQUEST_BYTES,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
}: {
  host: string;
  port: number;
  createServerForRequest?: () => McpServer;
  resolveServerForRequest?: (path: string) => (() => McpServer) | null;
  maxRequestBytes?: number;
  requestTimeoutMs?: number;
}) {
  const httpServer = createServer((request, response) => {
    if (request.url === '/healthz' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (request.method !== 'POST') {
      writeMethodNotAllowed(response);
      return;
    }

    const path = new URL(request.url ?? '/', 'http://minecraft-mcp.local').pathname;
    if (path !== '/mcp' && !/^\/bots\/forgebot[1-5]\/mcp$/.test(path)) {
      writeNotFound(response);
      return;
    }

    const serverFactory =
      resolveServerForRequest?.(path) ??
      (path === '/mcp' && createServerForRequest !== undefined ? createServerForRequest : null);
    if (serverFactory === null) {
      writeNotFound(response);
      return;
    }

    void (async () => {
      let mcpServer: McpServer | null = null;
      let transport: CompatibleStreamableTransport | null = null;
      try {
        const body = await readJsonBody(request, { maxBytes: maxRequestBytes, timeoutMs: requestTimeoutMs });
        mcpServer = serverFactory();
        transport = new CompatibleStreamableTransport();
        await mcpServer.connect(transport);
        await transport.handleRequest(request, response, body);
      } catch (caught) {
        const statusCode = caught instanceof RequestBodyError ? caught.statusCode : 500;
        if (!(caught instanceof RequestBodyError)) {
          console.error('Minecraft MCP request failed', caught);
        }
        if (!response.headersSent && !response.destroyed) {
          response.writeHead(statusCode, { connection: 'close', 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: {
                code: statusCode === 500 ? -32_603 : -32_600,
                message: caught instanceof RequestBodyError ? caught.message : 'Internal server error',
              },
              id: null,
            }),
          );
        }
      } finally {
        await transport?.close();
        await mcpServer?.close();
      }
    })();
  });
  httpServer.requestTimeout = requestTimeoutMs;
  httpServer.headersTimeout = Math.min(HEADERS_TIMEOUT_MS, requestTimeoutMs);

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
    port(): number {
      const address = httpServer.address();
      if (address === null || typeof address === 'string') {
        throw new Error('Minecraft MCP server is not listening on a TCP port.');
      }
      return address.port;
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
