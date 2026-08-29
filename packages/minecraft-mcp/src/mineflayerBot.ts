import { once } from 'node:events';
import { createServer } from 'node:net';

import mineflayer, { type Bot } from 'mineflayer';
import pathfinderPlugin from 'mineflayer-pathfinder';
import prismarineViewer from 'prismarine-viewer';
import { Vec3 } from 'vec3';

import type { ActionProgress, MinecraftBotPort, NearbyBlock, NearbyEntity, WorldObservation } from './botPort.js';
import type { BlueprintBlock, Plan, Position } from './domain.js';
import {
  hasSafeSwordClearance,
  isVerifiedAnimalDrop,
  selectHuntableAnimals,
  type HuntableAnimal,
  type HuntCandidate,
  type HuntSpecies,
} from './hunting.js';
import { isPositionWithinPlanBounds } from './planStore.js';
import { findNaturalTrees, type NaturalTree, type TreeWorld } from './treeHarvest.js';

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

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw abortError();
  }
}

function hasAttachedVehicle(entity: { vehicle?: unknown }): boolean {
  return entity.vehicle !== null && entity.vehicle !== undefined;
}

export async function isTcpPortAvailable(port: number): Promise<boolean> {
  return await new Promise<boolean>(resolve => {
    const probe = createServer();
    probe.unref();
    probe.once('error', () => {
      resolve(false);
    });
    probe.listen(port, () => {
      probe.close(error => {
        resolve(error === undefined);
      });
    });
  });
}

async function wait({ milliseconds, signal }: { milliseconds: number; signal: AbortSignal }): Promise<void> {
  if (signal.aborted) {
    throw abortError();
  }
  await new Promise<void>((resolve, reject) => {
    const handleAbort = () => {
      clearTimeout(timeout);
      reject(abortError());
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', handleAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', handleAbort, { once: true });
    if (signal.aborted) {
      handleAbort();
    }
  });
}

export async function runAbortable<T>({
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
      if (aborted) {
        return;
      }
      aborted = true;
      stop();
    };
    signal.addEventListener('abort', handleAbort, { once: true });
    if (signal.aborted) {
      handleAbort();
    }
    void operation()
      .then(value => {
        if (aborted) {
          reject(abortError());
        } else {
          resolve(value);
        }
      })
      .catch((caught: unknown) => {
        reject(aborted ? abortError() : caught instanceof Error ? caught : new Error('Minecraft action failed.'));
      })
      .finally(() => {
        signal.removeEventListener('abort', handleAbort);
      });
  });
}

export class MineflayerBot implements MinecraftBotPort {
  private bot: Bot | null = null;

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
      const movements = new Movements(bot);
      movements.canDig = false;
      movements.allow1by1towers = false;
      movements.scafoldingBlocks = [];
      bot.pathfinder.setMovements(movements);
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

  async startViewer(port: number): Promise<void> {
    if (!(await isTcpPortAvailable(port))) {
      console.warn(`Prismarine viewer port ${String(port)} is already in use; continuing without this viewer.`);
      return;
    }
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

  locateNaturalTrees({
    blockName,
    maxDistance,
    plan,
  }: {
    blockName: string;
    maxDistance: number;
    plan?: Plan;
  }): NaturalTree[] {
    const bot = this.requireBot();
    const blockType = bot.registry.blocksByName[blockName];
    if (blockType === undefined) {
      throw new Error(`Unknown Minecraft block: ${blockName}`);
    }
    const origin = integerPosition(bot.entity.position);
    const positions = bot
      .findBlocks({ matching: blockType.id, maxDistance, count: 256 })
      .map(position => integerPosition(position));
    const world: TreeWorld = {
      blockAt: position => {
        const block = bot.blockAt(new Vec3(position.x, position.y, position.z));
        return block === null ? null : { name: block.name, position: integerPosition(block.position) };
      },
    };
    return findNaturalTrees({
      world,
      candidates: positions,
      logName: blockName,
      origin,
      maxDistance,
      withinBounds: position => plan === undefined || isPositionWithinPlanBounds({ plan, position }),
    });
  }

  locateAnimals({
    species,
    maxDistance,
    plan,
  }: {
    species: HuntSpecies;
    maxDistance: number;
    plan?: Plan;
  }): HuntableAnimal[] {
    const bot = this.requireBot();
    const origin = integerPosition(bot.entity.position);
    const candidates: HuntCandidate[] = Object.values(bot.entities).map(entity => {
      const registryEntity = entity.name === undefined ? undefined : bot.registry.entitiesByName[entity.name];
      const metadataKeys = registryEntity?.metadataKeys ?? [];
      const metadata = (key: string): unknown => {
        const index = metadataKeys.indexOf(key);
        return index === -1 ? undefined : entity.metadata[index];
      };
      return {
        id: entity.id,
        type: entity.type,
        ...(entity.name === undefined ? {} : { name: entity.name }),
        position: integerPosition(entity.position),
        registryIdentityMatches: registryEntity !== undefined && entity.entityType === registryEntity.id,
        customNamed: entity.getCustomName() !== null,
        baby: metadata('baby') === true,
        saddled: metadata('saddle') === true,
        attached: hasAttachedVehicle(entity),
        hasPassengers: entity.passengers.length > 0,
      };
    });
    return selectHuntableAnimals({
      candidates,
      species,
      origin,
      maxDistance,
      withinBounds: position => plan === undefined || isPositionWithinPlanBounds({ plan, position }),
    });
  }

  async moveTo({
    target,
    range,
    plan,
    signal,
    assertAuthorized,
  }: {
    target: Position;
    range: number;
    plan: Plan;
    signal: AbortSignal;
    assertAuthorized: () => void;
  }): Promise<void> {
    const bot = this.requireBot();
    await runAbortable({
      signal,
      operation: async () => {
        assertAuthorized();
        let rejectBoundary: ((reason: Error) => void) | undefined;
        const boundaryViolation = new Promise<never>((_resolve, reject) => {
          rejectBoundary = reject;
        });
        const checkBounds = () => {
          try {
            assertAuthorized();
            if (isPositionWithinPlanBounds({ plan, position: integerPosition(bot.entity.position) })) {
              return;
            }
            bot.pathfinder.stop();
            rejectBoundary?.(new Error(`Path left the approved ${String(plan.radiusBlocks)}-block plan radius.`));
          } catch (caught) {
            bot.pathfinder.stop();
            rejectBoundary?.(caught instanceof Error ? caught : new Error('Minecraft plan authorization failed.'));
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
    assertAuthorized,
  }: {
    blockName: string;
    count: number;
    maxDistance: number;
    plan: Plan;
    signal: AbortSignal;
    assertAuthorized: () => void;
  }): Promise<ActionProgress> {
    const bot = this.requireBot();
    if (blockName.endsWith('_log') && !blockName.startsWith('stripped_')) {
      return await this.harvestTrees({ blockName, count, maxDistance, plan, signal, assertAuthorized });
    }
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
      assertAuthorized();
      const block = bot.findBlock({
        matching: blockType.id,
        useExtraInfo: candidate => isPositionWithinPlanBounds({ plan, position: integerPosition(candidate.position) }),
        maxDistance,
      });
      if (block === null) {
        break;
      }
      await this.moveTo({ target: integerPosition(block.position), range: 2, plan, signal, assertAuthorized });
      const tool = bot.pathfinder.bestHarvestTool(block);
      if (tool !== null) {
        assertAuthorized();
        await runAbortable({
          signal,
          operation: async () => {
            await bot.equip(tool, 'hand');
          },
          stop: () => {
            // Mineflayer exposes no equip cancellation; serialization waits for it to settle.
          },
        });
      }
      assertAuthorized();
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

  async harvestTrees({
    blockName,
    count,
    maxDistance,
    plan,
    signal,
    assertAuthorized,
  }: {
    blockName: string;
    count: number;
    maxDistance: number;
    plan: Plan;
    signal: AbortSignal;
    assertAuthorized: () => void;
  }): Promise<ActionProgress> {
    const bot = this.requireBot();
    const itemType = bot.registry.itemsByName[blockName];
    if (itemType === undefined) {
      throw new Error(`${blockName} cannot be collected as an inventory item.`);
    }
    const startingCount = bot.inventory.count(itemType.id, null);
    const details: string[] = [];

    while (bot.inventory.count(itemType.id, null) - startingCount < count) {
      if (signal.aborted) {
        throw abortError();
      }
      assertAuthorized();
      const tree = this.locateNaturalTrees({ blockName, maxDistance, plan })[0];
      if (tree === undefined) {
        break;
      }
      const treeStartingCount = bot.inventory.count(itemType.id, null);
      let mined = 0;
      for (const position of tree.logs) {
        assertAuthorized();
        const block = bot.blockAt(new Vec3(position.x, position.y, position.z));
        if (block?.name !== blockName) {
          continue;
        }
        if (!bot.canDigBlock(block)) {
          await this.moveTo({ target: position, range: 3, plan, signal, assertAuthorized });
        }
        const tool = bot.pathfinder.bestHarvestTool(block);
        if (tool !== null) {
          assertAuthorized();
          await runAbortable({
            signal,
            operation: async () => {
              await bot.equip(tool, 'hand');
            },
            stop: () => {
              // Mineflayer exposes no equip cancellation; serialization waits for it to settle.
            },
          });
        }
        assertAuthorized();
        await runAbortable({
          signal,
          operation: async () => {
            await bot.dig(block);
          },
          stop: () => {
            bot.stopDigging();
          },
        });
        mined += 1;
        await this.collectDrops({
          target: { x: position.x, y: tree.root.y, z: position.z },
          itemTypeId: itemType.id,
          previousCount: treeStartingCount,
          expectedIncrease: mined,
          plan,
          signal,
          assertAuthorized,
        });
      }

      await this.collectDrops({
        target: tree.root,
        itemTypeId: itemType.id,
        previousCount: treeStartingCount,
        expectedIncrease: mined,
        plan,
        signal,
        assertAuthorized,
      });
      const collected = bot.inventory.count(itemType.id, null) - treeStartingCount;
      details.push(
        `Harvested complete ${blockName} tree at ${String(tree.root.x)}, ${String(tree.root.y)}, ${String(tree.root.z)}: mined ${String(mined)}, verified ${String(collected)} collected.`,
      );
    }

    const completed = bot.inventory.count(itemType.id, null) - startingCount;
    details.push(`Verified ${String(completed)} total ${blockName} collected in inventory.`);
    return { requested: count, completed, details };
  }

  async huntAnimals({
    species,
    count,
    maxDistance,
    plan,
    signal,
    assertAuthorized,
  }: {
    species: HuntSpecies;
    count: number;
    maxDistance: number;
    plan: Plan;
    signal: AbortSignal;
    assertAuthorized: () => void;
  }): Promise<ActionProgress> {
    const bot = this.requireBot();
    await this.equipHunterSword({ signal, assertAuthorized });

    const previousMovements = bot.pathfinder.movements;
    const huntingMovements = new Movements(bot);
    huntingMovements.canDig = false;
    huntingMovements.allow1by1towers = false;
    huntingMovements.allowParkour = false;
    huntingMovements.maxDropDown = 2;
    bot.pathfinder.setMovements(huntingMovements);

    let completed = 0;
    const details: string[] = [];
    try {
      while (completed < count) {
        if (signal.aborted) {
          throw abortError();
        }
        assertAuthorized();
        const animal = this.locateAnimals({ species, maxDistance, plan })[0];
        if (animal === undefined) {
          break;
        }
        const target = bot.entities[animal.id];
        if (!target?.isValid) {
          continue;
        }

        const inventoryBefore = this.animalDropInventory(species);
        let deathPosition: Position | null = null;
        let lastPosition = integerPosition(target.position);
        for (let attackNumber = 0; attackNumber < 16; attackNumber += 1) {
          assertAuthorized();
          if (!this.isEligibleAnimalTarget({ id: target.id, species, maxDistance, plan })) {
            break;
          }
          lastPosition = integerPosition(target.position);
          if (target.position.distanceTo(bot.entity.position) > 3) {
            await this.moveTo({
              target: lastPosition,
              range: 2,
              plan,
              signal,
              assertAuthorized,
            });
          }
          assertAuthorized();
          assertNotAborted(signal);
          if (!this.isEligibleAnimalTarget({ id: target.id, species, maxDistance, plan })) {
            break;
          }
          if (target.position.distanceTo(bot.entity.position) > 3.5) {
            continue;
          }
          if (!this.hasClearSwordAttack(target.id)) {
            details.push(
              `Stopped pursuing ${species} ${String(target.id)} because another living entity was too close for a safe sword attack.`,
            );
            break;
          }

          await runAbortable({
            signal,
            operation: async () => {
              await bot.lookAt(target.position.offset(0, Math.max(target.height / 2, 0.5), 0), true);
            },
            stop: () => {
              bot.clearControlStates();
            },
          });
          assertAuthorized();
          assertNotAborted(signal);
          if (!this.isEligibleAnimalTarget({ id: target.id, species, maxDistance, plan })) {
            break;
          }
          if (!this.hasClearSwordAttack(target.id)) {
            break;
          }
          await this.equipHunterSword({ signal, assertAuthorized });
          deathPosition = await this.attackAndWaitForDeath({ target, signal });
          if (deathPosition !== null) {
            break;
          }
        }
        if (deathPosition === null) {
          details.push(`Stopped pursuing ${species} ${String(target.id)} because a safe kill was not verified.`);
          break;
        }

        completed += 1;
        const drops = await this.collectAnimalDrops({
          species,
          target: deathPosition,
          before: inventoryBefore,
          plan,
          signal,
          assertAuthorized,
        });
        const evidence = drops.length === 0 ? 'no eligible drops reached inventory' : `collected ${drops.join(', ')}`;
        details.push(
          `Killed unnamed adult ${species} at ${String(deathPosition.x)}, ${String(deathPosition.y)}, ${String(deathPosition.z)}; ${evidence}.`,
        );
      }
    } finally {
      bot.pathfinder.setMovements(previousMovements);
    }

    return { requested: count, completed, details };
  }

  async craft({
    itemName,
    count,
    signal,
    assertAuthorized,
  }: {
    itemName: string;
    count: number;
    signal: AbortSignal;
    assertAuthorized: () => void;
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

    assertAuthorized();
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
    assertAuthorized,
  }: {
    origin: Position;
    blocks: BlueprintBlock[];
    plan: Plan;
    signal: AbortSignal;
    assertAuthorized: () => void;
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
      assertAuthorized();
      const target = new Vec3(origin.x + operation.dx, origin.y + operation.dy, origin.z + operation.dz);
      const existing = bot.blockAt(target);
      if (existing?.name === operation.block || (operation.block === 'air' && existing?.name === 'air')) {
        completed += 1;
        continue;
      }

      await this.moveTo({ target: integerPosition(target), range: 3, plan, signal, assertAuthorized });
      if (operation.block === 'air') {
        if (existing === null || existing.name === 'air') {
          completed += 1;
          continue;
        }
        assertAuthorized();
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
        assertAuthorized();
        await runAbortable({
          signal,
          operation: async () => {
            await bot.equip(item, 'hand');
          },
          stop: () => {
            // Mineflayer exposes no equip cancellation; serialization waits for it to settle.
          },
        });
        const placement = this.findPlacementReference(target);
        if (placement === null) {
          throw new Error(`No supporting face is available to place ${operation.block} at ${target.toString()}.`);
        }
        assertAuthorized();
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
    assertAuthorized,
  }: {
    itemName: string;
    count: number;
    signal: AbortSignal;
    assertAuthorized: () => void;
  }): Promise<ActionProgress> {
    const bot = this.requireBot();
    const item = bot.inventory.items().find(candidate => candidate.name === itemName);
    if (item === undefined) {
      throw new Error(`${itemName} is not in the bot inventory.`);
    }
    const dropCount = Math.min(count, item.count);
    assertAuthorized();
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

  private async collectDrops({
    target,
    itemTypeId,
    previousCount,
    expectedIncrease = 1,
    plan,
    signal,
    assertAuthorized,
  }: {
    target: Position;
    itemTypeId: number;
    previousCount: number;
    expectedIncrease?: number;
    plan: Plan;
    signal: AbortSignal;
    assertAuthorized: () => void;
  }): Promise<void> {
    const bot = this.requireBot();
    await wait({ milliseconds: 200, signal });
    assertAuthorized();
    await this.moveTo({ target, range: 1, plan, signal, assertAuthorized });
    const deadline = Date.now() + 3_500;
    while (bot.inventory.count(itemTypeId, null) - previousCount < expectedIncrease && Date.now() < deadline) {
      assertAuthorized();
      await wait({ milliseconds: 150, signal });
    }
    const collected = bot.inventory.count(itemTypeId, null) - previousCount;
    if (collected < expectedIncrease) {
      throw new Error(
        `Mined ${String(expectedIncrease)} blocks, but only ${String(collected)} drops were verified in inventory.`,
      );
    }
  }

  private animalDropInventory(species: HuntSpecies): Map<string, number> {
    const bot = this.requireBot();
    const counts = new Map<string, number>();
    for (const item of bot.inventory.items()) {
      if (isVerifiedAnimalDrop({ species, itemName: item.name })) {
        counts.set(item.name, (counts.get(item.name) ?? 0) + item.count);
      }
    }
    return counts;
  }

  private isEligibleAnimalTarget({
    id,
    species,
    maxDistance,
    plan,
  }: {
    id: number;
    species: HuntSpecies;
    maxDistance: number;
    plan: Plan;
  }): boolean {
    const bot = this.requireBot();
    const target = bot.entities[id];
    return (
      target?.isValid === true &&
      this.locateAnimals({ species, maxDistance, plan }).some(candidate => candidate.id === id)
    );
  }

  private hasClearSwordAttack(targetId: number): boolean {
    const bot = this.requireBot();
    const target = bot.entities[targetId];
    if (target?.isValid !== true) {
      return false;
    }
    return hasSafeSwordClearance({
      targetId,
      targetPosition: integerPosition(target.position),
      entities: Object.values(bot.entities).map(entity => ({
        id: entity.id,
        type: entity.type,
        isValid: entity.isValid,
        position: integerPosition(entity.position),
      })),
    });
  }

  private async equipHunterSword({
    signal,
    assertAuthorized,
  }: {
    signal: AbortSignal;
    assertAuthorized: () => void;
  }): Promise<void> {
    const bot = this.requireBot();
    const weapon = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword', 'golden_sword']
      .map(itemName => bot.inventory.items().find(item => item.name === itemName))
      .find(item => item !== undefined);
    if (weapon === undefined) {
      throw new Error('The hunter requires a sword before hunting animals.');
    }
    assertAuthorized();
    await runAbortable({
      signal,
      operation: async () => {
        await bot.equip(weapon, 'hand');
      },
      stop: () => {
        bot.clearControlStates();
      },
    });
  }

  private async attackAndWaitForDeath({
    target,
    signal,
  }: {
    target: Bot['entity'];
    signal: AbortSignal;
  }): Promise<Position | null> {
    const bot = this.requireBot();
    let hurtByBot = false;
    let deathPosition: Position | null = null;
    const handleHurt = (hurtEntity: Bot['entity'], source: { id?: number } | undefined) => {
      if (hurtEntity.id === target.id) {
        hurtByBot = source?.id === bot.entity.id;
      }
    };
    const handleDeath = (deadEntity: Bot['entity']) => {
      if (deadEntity.id === target.id && hurtByBot) {
        deathPosition = integerPosition(deadEntity.position);
      }
    };
    bot.on('entityHurt', handleHurt);
    bot.on('entityDead', handleDeath);
    try {
      bot.attack(target);
      await wait({ milliseconds: 1_250, signal });
      return deathPosition;
    } finally {
      bot.removeListener('entityHurt', handleHurt);
      bot.removeListener('entityDead', handleDeath);
    }
  }

  private async collectAnimalDrops({
    species,
    target,
    before,
    plan,
    signal,
    assertAuthorized,
  }: {
    species: HuntSpecies;
    target: Position;
    before: Map<string, number>;
    plan: Plan;
    signal: AbortSignal;
    assertAuthorized: () => void;
  }): Promise<string[]> {
    await wait({ milliseconds: 200, signal });
    assertAuthorized();
    await this.moveTo({ target, range: 1, plan, signal, assertAuthorized });
    const deadline = Date.now() + 3_500;
    let changes: string[] = [];
    while (Date.now() < deadline) {
      assertAuthorized();
      const after = this.animalDropInventory(species);
      changes = [...after.entries()]
        .map(([itemName, itemCount]) => ({ itemName, count: itemCount - (before.get(itemName) ?? 0) }))
        .filter(change => change.count > 0)
        .map(change => `${String(change.count)} ${change.itemName}`);
      if (changes.length > 0) {
        return changes;
      }
      await wait({ milliseconds: 150, signal });
    }
    return changes;
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
