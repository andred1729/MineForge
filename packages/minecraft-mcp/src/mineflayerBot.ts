import { once } from 'node:events';

import mineflayer, { type Bot } from 'mineflayer';
import pathfinderPlugin from 'mineflayer-pathfinder';
import prismarineViewer from 'prismarine-viewer';
import { Vec3 } from 'vec3';

import type { ActionProgress, MinecraftBotPort, NearbyBlock, NearbyEntity, WorldObservation } from './botPort.js';
import { splitChatMessage } from './chat.js';
import type { BlueprintBlock, Plan, Position } from './domain.js';
import { isPositionWithinPlanBounds } from './planStore.js';

interface MineflayerBotOptions {
  host: string;
  port: number;
  username: string;
  version: string;
}

const { goals, Movements, pathfinder } = pathfinderPlugin;
const { mineflayer: startMineflayerViewer } = prismarineViewer;

function integerPosition(position: Vec3): Position {
  return {
    x: Math.floor(position.x),
    y: Math.floor(position.y),
    z: Math.floor(position.z),
  };
}

function abortError(): Error {
  return new Error('Minecraft action was cancelled.');
}

async function runAbortable<T>({
  signal,
  operation,
  stop,
}: {
  signal: AbortSignal;
  operation: () => Promise<T>;
  stop: () => void;
}): Promise<T> {
  if (signal.aborted) {
    throw abortError();
  }

  return await new Promise<T>((resolve, reject) => {
    let aborted = false;
      const handleAbort = () => {
      stop();
      aborted = true;
        stop();
    };
    signal.addEventListener('abort', handleAbort, { once: true });
    void operation()
      .then(value => (aborted ? reject(abortError()) : resolve(value)))
      .catch(error => reject(aborted ? abortError() : error))
      .finally(() => {
        signal.removeEventListener('abort', handleAbort);
      });
  });
}

export class MineflayerBot implements MinecraftBotPort {
  private bot: Bot | null = null;
  private readonly chatListeners = new Set<(event: { username: string; message: string }) => void>();

  constructor(private readonly options: MineflayerBotOptions) {}

  async start(): Promise<void> {
    if (this.bot !== null) {
      return;
    }

    const bot = mineflayer.createBot({
      host: this.options.host,
      port: this.options.port,
      username: this.options.username,
      auth: 'offline',
      version: this.options.version,
    });
    bot.loadPlugin(pathfinder);
    bot.on('chat', (username, message) => {
      for (const listener of this.chatListeners) {
        listener({ username, message });
      }
    });
    this.bot = bot;

    try {
      await Promise.race([
        once(bot, 'spawn'),
        once(bot, 'error').then(([error]) => {
          if (error instanceof Error) {
            throw error;
          }
          throw new Error('Mineflayer failed before spawning.');
        }),
      ]);
      bot.pathfinder.setMovements(new Movements(bot));
    } catch (caught) {
      this.bot = null;
      bot.end('Connection failed');
      throw new Error('Could not connect ForgeBot to Minecraft.', { cause: caught });
    }
  }

  close(): Promise<void> {
    const bot = this.bot;
    this.bot = null;
    if (bot !== null) {
      bot.end('Minecraft bridge shutting down');
    }
    return Promise.resolve();
  }

  startViewer(port: number): void {
    startMineflayerViewer(this.requireBot(), { port, firstPerson: false, viewDistance: 8 });
  }

  isConnected(): boolean {
    return this.bot?.entity !== undefined;
  }

  position(): Position {
    return integerPosition(this.requireBot().entity.position);
  }

  inspect({ radius }: { radius: number }): WorldObservation {
    const bot = this.requireBot();
    const center = integerPosition(bot.entity.position);
    const boundedRadius = Math.min(Math.max(radius, 1), 12);
    const blocks: NearbyBlock[] = [];
    const seenBlockNames = new Set<string>();

    blockScan: for (let x = center.x - boundedRadius; x <= center.x + boundedRadius; x += 1) {
      for (let y = center.y - 3; y <= center.y + 4; y += 1) {
        for (let z = center.z - boundedRadius; z <= center.z + boundedRadius; z += 1) {
          const block = bot.blockAt(new Vec3(x, y, z));
          if (block === null || block.name === 'air' || seenBlockNames.has(block.name)) {
            continue;
          }
          blocks.push({ name: block.name, position: { x, y, z } });
          seenBlockNames.add(block.name);
          if (blocks.length >= 64) {
            break blockScan;
          }
        }
      }
    }

    const entities: NearbyEntity[] = Object.values(bot.entities)
      .filter(entity => entity.id !== bot.entity.id && entity.position.distanceTo(bot.entity.position) <= boundedRadius)
      .slice(0, 32)
      .map(entity => ({
        id: entity.id,
        name: entity.username ?? entity.name ?? entity.displayName ?? 'unknown',
        kind: entity.type,
        distance: Math.round(entity.position.distanceTo(bot.entity.position) * 10) / 10,
        position: integerPosition(entity.position),
      }));

    return {
      connected: true,
      username: bot.username,
      position: center,
      health: bot.health,
      food: bot.food,
      dimension: bot.game.dimension,
      timeOfDay: bot.time.timeOfDay,
      isRaining: bot.isRaining,
      inventory: bot.inventory.items().map(item => ({ name: item.name, count: item.count })),
      nearbyBlocks: blocks,
      nearbyEntities: entities,
    };
  }

  async moveTo({
    target,
    range,
    plan,
    signal,
  }: {
    target: Position;
    range: number;
    plan: Plan;
    signal: AbortSignal;
  }): Promise<void> {
    const bot = this.requireBot();
    await runAbortable({
      signal,
      operation: async () => {
        let rejectBoundary: ((reason: Error) => void) | undefined;
        const boundaryViolation = new Promise<never>((_resolve, reject) => {
          rejectBoundary = reject;
        });
        const checkBounds = () => {
          if (!isPositionWithinPlanBounds({ plan, position: integerPosition(bot.entity.position) })) {
            bot.pathfinder.stop();
            rejectBoundary?.(new Error(`Path left the approved ${String(plan.radiusBlocks)}-block plan radius.`));
          }
        };
        bot.on('physicsTick', checkBounds);
        try {
          await Promise.race([
            bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, range)),
            boundaryViolation,
          ]);
        } finally {
          bot.removeListener('physicsTick', checkBounds);
        }
      },
      stop: () => {
        bot.pathfinder.stop();
      },
    });
  }

  async gather({
    blockName,
    count,
    maxDistance,
    plan,
    signal,
  }: {
    blockName: string;
    count: number;
    maxDistance: number;
    plan: Plan;
    signal: AbortSignal;
  }): Promise<ActionProgress> {
    const bot = this.requireBot();
    const blockType = bot.registry.blocksByName[blockName];
    if (blockType === undefined) {
      throw new Error(`Unknown Minecraft block: ${blockName}`);
    }

    let completed = 0;
    const details: string[] = [];
    while (completed < count) {
      if (signal.aborted) {
        throw abortError();
      }
      if (plan.expiresAt <= Date.now()) {
          throw new Error('The approved plan has expired.');
        }
        const block = bot.findBlock({
        matching: candidate =>
          candidate.type === blockType.id &&
          isPositionWithinPlanBounds({ plan, position: integerPosition(candidate.position) }),
        maxDistance,
      });
      if (block === null) {
        break;
      }
      await this.moveTo({ target: integerPosition(block.position), range: 2, plan, signal });
      const tool = bot.pathfinder.bestHarvestTool(block);
      if (tool !== null) {
        await bot.equip(tool, 'hand');
      }
      await runAbortable({
        signal,
        operation: async () => {
          await bot.dig(block);
        },
        stop: () => {
          bot.stopDigging();
        },
      });
      completed += 1;
      details.push(`Mined ${blockName} at ${block.position.toString()}`);
    }
    return { requested: count, completed, details };
  }

  async craft({
    itemName,
    count,
    signal,
  }: {
    itemName: string;
    count: number;
    signal: AbortSignal;
  }): Promise<ActionProgress> {
    const bot = this.requireBot();
    const itemType = bot.registry.itemsByName[itemName];
    if (itemType === undefined) {
      throw new Error(`Unknown Minecraft item: ${itemName}`);
    }
    const craftingTableType = bot.registry.blocksByName['crafting_table'];
    const craftingTable =
      craftingTableType === undefined ? null : bot.findBlock({ matching: craftingTableType.id, maxDistance: 16 });
    const recipes = bot.recipesFor(itemType.id, null, 1, craftingTable);
    const recipe = recipes[0];
    if (recipe === undefined) {
      throw new Error(`No currently craftable recipe found for ${String(count)} ${itemName}.`);
    }
    const recipeCount = Math.ceil(count / recipe.result.count);

    if (bot.recipesFor(itemType.id, null, recipeCount, craftingTable).length === 0) {
      throw new Error(`Not enough ingredients to craft ${String(count)} ${itemName}.`);
    }

    await runAbortable({
      signal,
      operation: async () => {
        await bot.craft(recipe, recipeCount, craftingTable ?? undefined);
      },
      stop: () => {
        bot.clearControlStates();
      },
    });
    const completed = recipeCount * recipe.result.count;
    return { requested: count, completed, details: [`Crafted ${String(completed)} ${itemName}`] };
  }

  async executeBlueprint({
    origin,
    blocks,
    plan,
    signal,
  }: {
    origin: Position;
    blocks: BlueprintBlock[];
    plan: Plan;
    signal: AbortSignal;
  }): Promise<ActionProgress> {
    const bot = this.requireBot();
    const ordered = [...blocks].sort((left, right) => {
      if (left.block === 'air' && right.block !== 'air') {
        return -1;
      }
      if (left.block !== 'air' && right.block === 'air') {
        return 1;
      }
      return left.dy - right.dy;
    });
    let completed = 0;
    const details: string[] = [];

    for (const operation of ordered) {
      if (signal.aborted) {
        throw abortError();
      }
      if (plan.expiresAt <= Date.now()) {
          throw new Error('The approved plan has expired.');
        }
        const target = new Vec3(origin.x + operation.dx, origin.y + operation.dy, origin.z + operation.dz);
      const existing = bot.blockAt(target);
      if (existing?.name === operation.block || (operation.block === 'air' && existing?.name === 'air')) {
        completed += 1;
        continue;
      }

      await this.moveTo({ target: integerPosition(target), range: 3, plan, signal });
      if (operation.block === 'air') {
        if (existing === null || existing.name === 'air') {
          completed += 1;
          continue;
        }
        await runAbortable({
          signal,
          operation: async () => {
            await bot.dig(existing);
          },
          stop: () => {
            bot.stopDigging();
          },
        });
      } else {
        const item = bot.inventory.items().find(candidate => candidate.name === operation.block);
        if (item === undefined) {
          throw new Error(`Missing ${operation.block} in inventory after ${String(completed)} blueprint operations.`);
        }
        await bot.equip(item, 'hand');
        const placement = this.findPlacementReference(target);
        if (placement === null) {
          throw new Error(`No supporting face is available to place ${operation.block} at ${target.toString()}.`);
        }
        await runAbortable({
          signal,
          operation: async () => {
            await bot.placeBlock(placement.reference, placement.face);
          },
          stop: () => {
            bot.clearControlStates();
          },
        });
      }
      completed += 1;
      details.push(`${operation.block} at ${target.toString()}`);
    }

    return { requested: blocks.length, completed, details };
  }

  async drop({
    itemName,
    count,
    signal,
  }: {
    itemName: string;
    count: number;
    signal: AbortSignal;
  }): Promise<ActionProgress> {
    const bot = this.requireBot();
    const item = bot.inventory.items().find(candidate => candidate.name === itemName);
    if (item === undefined) {
      throw new Error(`${itemName} is not in the bot inventory.`);
    }
    const dropCount = Math.min(count, item.count);
    await runAbortable({
      signal,
      operation: async () => {
        await bot.toss(item.type, item.metadata, dropCount);
      },
      stop: () => {
        bot.clearControlStates();
      },
    });
    return { requested: count, completed: dropCount, details: [`Dropped ${String(dropCount)} ${itemName}`] };
  }

  stop(): void {
    const bot = this.bot;
    if (bot === null) {
      return;
    }
    bot.pathfinder.stop();
    bot.stopDigging();
    bot.clearControlStates();
  }

  async say(message: string): Promise<void> {
    const bot = this.requireBot();
    for (const part of splitChatMessage(message)) {
      bot.chat(part);
      await new Promise(resolve => setTimeout(resolve, 350));
    }
  }

  onChat(listener: (event: { username: string; message: string }) => void): () => void {
    this.chatListeners.add(listener);
    return () => this.chatListeners.delete(listener);
  }

  private findPlacementReference(target: Vec3) {
    const bot = this.requireBot();
    const faces = [
      new Vec3(0, 1, 0),
      new Vec3(0, -1, 0),
      new Vec3(1, 0, 0),
      new Vec3(-1, 0, 0),
      new Vec3(0, 0, 1),
      new Vec3(0, 0, -1),
    ];
    for (const face of faces) {
      const reference = bot.blockAt(target.minus(face));
      if (reference !== null && reference.boundingBox !== 'empty') {
        return { reference, face };
      }
    }
    return null;
  }

  private requireBot(): Bot {
    if (this.bot === null) {
      throw new Error('ForgeBot is not connected to Minecraft.');
    }
    return this.bot;
  }
}
