import { MinecraftActionQueue } from './actionQueue.js';
import type { MinecraftBotPort } from './botPort.js';
import { createBotIdentity, type BotIdentity, type BotRole } from './botRoles.js';
import { PlanStore } from './planStore.js';
import type { TrueForgeSessionPort } from './trueforgePort.js';
import type { TrueForgeProvisionerPort } from './trueforgeProvisioner.js';
import {
  loadWorkforceState,
  saveWorkforceState,
  type WorkforceBotRecord,
  type WorkforceState,
} from './workforceState.js';

export interface ManagedMinecraftBot extends MinecraftBotPort {
  startViewer(port: number): Promise<void>;
}

export interface WorkforceBotContext {
  record: WorkforceBotRecord;
  bot: ManagedMinecraftBot;
  planStore: PlanStore;
  actionQueue: MinecraftActionQueue;
}

export interface SpawnedBot {
  username: string;
  role: BotIdentity['role'];
  agentName: string;
  sessionId: string;
  consoleUrl: string;
}

export interface BuildWorkerContext {
  id: string;
  username: string;
  bot: ManagedMinecraftBot;
  actionQueue: MinecraftActionQueue;
}

interface ActiveBot extends WorkforceBotContext {
  controller: SessionMirrorPort;
}

export interface SessionMirrorPort {
  start(): Promise<void>;
  close(): Promise<void>;
}

export interface WorkforceManagerOptions {
  stateDirectory: string;
  consoleBaseUrl: string;
  maxBots: number;
  viewerBasePort?: number;
  provisioner: TrueForgeProvisionerPort;
  createBot(identity: BotIdentity): ManagedMinecraftBot;
  createHelperBot?(username: string): ManagedMinecraftBot;
  prepareHelper?(worker: { id: string; username: string; index: number }): Promise<void>;
  createSessionClient(record: WorkforceBotRecord): TrueForgeSessionPort;
  createController(options: {
    bot: MinecraftBotPort;
    session: TrueForgeSessionPort;
    onTurnCancelled: () => void;
    acceptMinecraftChat: boolean;
  }): SessionMirrorPort;
}

export class WorkforceCapacityError extends Error {}

export class WorkforceManager {
  private readonly activeBots = new Map<string, ActiveBot>();
  private readonly buildHelpers = new Map<string, Map<string, BuildWorkerContext>>();
  private state: WorkforceState | null = null;
  private spawnSequence: Promise<void> = Promise.resolve();

  constructor(private readonly options: WorkforceManagerOptions) {}

  async start(): Promise<void> {
    if (this.state !== null) {
      return;
    }
    const state = await loadWorkforceState(this.options.stateDirectory);
    await this.options.provisioner.ensureProvider();
    try {
      for (const record of state.bots) {
        await this.activate({ identity: record, existingRecord: record });
      }
      const restoredState: WorkforceState = {
        ...state,
        bots: [...this.activeBots.values()].map(active => active.record),
      };
      const resourcesChanged = restoredState.bots.some((record, index) => {
        const previous = state.bots[index];
        return previous?.sessionId !== record.sessionId || previous.agentId !== record.agentId;
      });
      if (resourcesChanged) {
        await saveWorkforceState({ directory: this.options.stateDirectory, state: restoredState });
      }
      this.state = restoredState;
    } catch (caught) {
      await this.closeActiveBots();
      throw new Error('Could not restore the Minecraft workforce.', { cause: caught });
    }
  }

  spawn(requestedRole?: BotRole): Promise<SpawnedBot> {
    const result = this.spawnSequence.then(async () => await this.spawnNext(requestedRole));
    this.spawnSequence = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  rollback(username: string): Promise<boolean> {
    const result = this.spawnSequence.then(async () => await this.rollbackLatest(username));
    this.spawnSequence = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  ready(username: string): Promise<boolean> {
    const result = this.spawnSequence.then(async () => await this.initializeSession(username));
    this.spawnSequence = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  resolveBySlug(slug: string): WorkforceBotContext | null {
    const active = this.activeBots.get(slug);
    if (active === undefined) {
      return null;
    }
    return {
      record: active.record,
      bot: active.bot,
      planStore: active.planStore,
      actionQueue: active.actionQueue,
    };
  }

  list(): SpawnedBot[] {
    return [...this.activeBots.values()]
      .sort((left, right) => left.record.ordinal - right.record.ordinal)
      .map(active => this.toSpawnedBot(active.record));
  }

  async spawnBuildHelpers(ownerSlug: string, count: number): Promise<{ id: string; username: string }[]> {
    const owner = this.activeBots.get(ownerSlug);
    if (owner === undefined || (owner.record.role !== 'builder' && owner.record.role !== 'generalist')) {
      throw new Error('Only an active worker with building tools can spawn build helpers.');
    }
    if (!Number.isInteger(count) || count < 1 || count > 3) {
      throw new Error('A Builder may request between one and three helpers.');
    }
    if (this.options.createHelperBot === undefined) {
      throw new Error('Build helpers are not configured for this bridge.');
    }
    const crew = this.buildHelpers.get(ownerSlug) ?? new Map<string, BuildWorkerContext>();
    this.buildHelpers.set(ownerSlug, crew);
    for (let index = 1; index <= count; index += 1) {
      const id = `sub_agent${String(index)}`;
      if (crew.has(id)) {
        continue;
      }
      const bot = this.options.createHelperBot(id);
      try {
        await bot.start();
        await this.options.prepareHelper?.({ id, username: id, index });
        crew.set(id, { id, username: id, bot, actionQueue: new MinecraftActionQueue() });
      } catch (caught) {
        bot.stop();
        await bot.close();
        throw new Error(`Could not spawn visible helper ${id}.`, { cause: caught });
      }
    }
    return [...crew.values()].slice(0, count).map(({ id, username }) => ({ id, username }));
  }

  resolveBuildWorker(ownerSlug: string, workerId: string): BuildWorkerContext | null {
    return this.buildHelpers.get(ownerSlug)?.get(workerId) ?? null;
  }

  async close(): Promise<void> {
    await this.closeActiveBots();
    this.state = null;
  }

  private async closeActiveBots(): Promise<void> {
    const helpers = [...this.buildHelpers.values()].flatMap(crew => [...crew.values()]);
    this.buildHelpers.clear();
    await Promise.all(
      helpers.map(async helper => {
        helper.actionQueue.cancelActive();
        helper.bot.stop();
        await helper.bot.close();
      }),
    );
    const active = [...this.activeBots.values()];
    this.activeBots.clear();
    await Promise.all(
      active.map(async entry => {
        entry.planStore.invalidate();
        entry.bot.stop();
        await entry.controller.close();
        await entry.bot.close();
      }),
    );
  }

  private async spawnNext(requestedRole?: BotRole): Promise<SpawnedBot> {
    const state = this.requireState();
    if (state.bots.length >= this.options.maxBots || state.nextOrdinal > this.options.maxBots) {
      throw new WorkforceCapacityError(
        `The Minecraft workforce already has its ${String(this.options.maxBots)} bot maximum.`,
      );
    }
    const identity = createBotIdentity(state.nextOrdinal, requestedRole);
    const active = await this.activate({ identity });
    const nextState: WorkforceState = {
      version: 1,
      nextOrdinal: identity.ordinal + 1,
      bots: [...state.bots, active.record],
    };
    try {
      await saveWorkforceState({ directory: this.options.stateDirectory, state: nextState });
      this.state = nextState;
      return this.toSpawnedBot(active.record);
    } catch (caught) {
      this.activeBots.delete(identity.slug);
      active.planStore.invalidate();
      active.bot.stop();
      await active.controller.close();
      await active.bot.close();
      throw new Error(`Could not persist ${identity.username}.`, { cause: caught });
    }
  }

  private async rollbackLatest(username: string): Promise<boolean> {
    const state = this.requireState();
    const record = state.bots.at(-1);
    if (record?.username !== username) {
      return false;
    }
    const active = this.activeBots.get(record.slug);
    if (active === undefined) {
      return false;
    }
    const nextState: WorkforceState = {
      version: 1,
      nextOrdinal: record.ordinal,
      bots: state.bots.slice(0, -1),
    };
    await saveWorkforceState({ directory: this.options.stateDirectory, state: nextState });
    this.state = nextState;
    this.activeBots.delete(record.slug);
    active.planStore.invalidate();
    active.bot.stop();
    await active.controller.close();
    await active.bot.close();
    console.log(`Rolled back unplaced ${record.username}.`);
    return true;
  }

  private initializeSession(username: string): Promise<boolean> {
    return Promise.resolve([...this.activeBots.values()].some(entry => entry.record.username === username));
  }

  private async activate({
    identity,
    existingRecord,
  }: {
    identity: BotIdentity;
    existingRecord?: WorkforceBotRecord;
  }): Promise<ActiveBot> {
    if (this.activeBots.has(identity.slug)) {
      throw new Error(`${identity.username} is already active.`);
    }
    const bot = this.options.createBot(identity);
    try {
      await bot.start();
      if (this.options.viewerBasePort !== undefined) {
        await bot.startViewer(this.options.viewerBasePort + identity.ordinal - 1);
      }
      const resources = await this.options.provisioner.provisionBot({
        identity,
        ...(existingRecord === undefined ? {} : { existingRecord }),
      });
      const record: WorkforceBotRecord = { ...identity, ...resources };
      const planStore = new PlanStore();
      const actionQueue = new MinecraftActionQueue();
      const session = this.options.createSessionClient(record);
      const controller = this.options.createController({
        bot,
        session,
        acceptMinecraftChat: false,
        onTurnCancelled: () => {
          planStore.invalidate();
          actionQueue.cancelActive();
        },
      });
      await controller.start();
      const active: ActiveBot = { record, bot, planStore, actionQueue, controller };
      this.activeBots.set(identity.slug, active);
      console.log(
        `${identity.username} (${identity.role}) attached to ${this.options.consoleBaseUrl.replace(/\/$/, '')}/sessions/${record.sessionId}`,
      );
      return active;
    } catch (caught) {
      bot.stop();
      await bot.close();
      throw new Error(`Could not activate ${identity.username}.`, { cause: caught });
    }
  }

  private requireState(): WorkforceState {
    if (this.state === null) {
      throw new Error('The Minecraft workforce manager has not started.');
    }
    return this.state;
  }

  private toSpawnedBot(record: WorkforceBotRecord): SpawnedBot {
    return {
      username: record.username,
      role: record.role,
      agentName: record.agentName,
      sessionId: record.sessionId,
      consoleUrl: `${this.options.consoleBaseUrl.replace(/\/$/, '')}/sessions/${record.sessionId}`,
    };
  }
}
