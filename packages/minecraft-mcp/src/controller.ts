import type { MinecraftBotPort } from './botPort.js';
import type { MinecraftChatEvent } from './domain.js';
import { EventQueue } from './eventQueue.js';
import type { TrueForgeSessionPort, TurnSnapshot } from './trueforgePort.js';

function eventPrompt(event: MinecraftChatEvent): string {
  return `[Minecraft chat from ${event.username}] ${event.message}`;
}

function isBusy(turn: TurnSnapshot | null): boolean {
  return turn?.status === 'running' || turn?.hasRequiredActions === true;
}

function isStopMessage(message: string): boolean {
  return /^(?:\/)?(?:stop|cancel)\b/i.test(message.trim());
}

function noop(): void {
  // Optional cancellation hook.
}

export class MinecraftEventController {
  private readonly queue = new EventQueue(50);
  private pollingHandle: NodeJS.Timeout | null = null;
  private unsubscribeChat: (() => void) | null = null;
  private polling = false;
  private mirroredTurnId: string | null = null;
  private handledTerminalTurnId: string | null = null;

  constructor(
    private readonly bot: MinecraftBotPort,
    private readonly trueforge: TrueForgeSessionPort,
    private readonly pollIntervalMs = 1_000,
    private readonly onTurnCancelled: () => void = noop,
  ) {}

  async start(): Promise<void> {
    const initialTurn = await this.trueforge.latestTurn();
    this.mirroredTurnId = initialTurn?.status === 'running' ? null : (initialTurn?.id ?? null);
    this.unsubscribeChat = this.bot.onChat(event => {
      if (event.username === this.botUsername()) {
        return;
      }
      if (isStopMessage(event.message)) {
        void this.stopActiveTurn();
        return;
      }
      this.enqueueChat(event);
    });
    this.pollingHandle = setInterval(() => void this.tick(), this.pollIntervalMs);
  }

  close(): Promise<void> {
    if (this.pollingHandle !== null) {
      clearInterval(this.pollingHandle);
      this.pollingHandle = null;
    }
    this.unsubscribeChat?.();
    this.unsubscribeChat = null;
    return Promise.resolve();
  }

  enqueueChat(event: Omit<MinecraftChatEvent, 'type'>): boolean {
    const queued = this.queue.enqueue({ type: 'minecraft_chat', ...event });
    if (queued) {
      void this.tick();
    }
    return queued;
  }

  async tick(): Promise<void> {
    if (this.polling) {
      return;
    }
    this.polling = true;
    try {
      const latest = await this.trueforge.latestTurn();
      this.handleCancelledTurn(latest);
      await this.mirrorFinishedTurn(latest);
      if (isBusy(latest)) {
        return;
      }

      const event = this.queue.dequeue();
      if (event === undefined) {
        return;
      }
      try {
        await this.trueforge.createUserTurn(eventPrompt(event));
      } catch (caught) {
        this.queue.requeueFront(event);
        throw new Error('Could not create a TrueForge turn for the Minecraft event.', { cause: caught });
      }
    } catch (caught) {
      console.warn('Minecraft event controller tick failed', caught);
    } finally {
      this.polling = false;
    }
  }

  private async mirrorFinishedTurn(turn: TurnSnapshot | null): Promise<void> {
    if (turn === null) {
      return;
    }
    if (turn.status !== 'done' || turn.hasRequiredActions || turn.responseText === null) {
      return;
    }
    if (this.mirroredTurnId === turn.id) {
      return;
    }
    await this.bot.say(turn.responseText);
    this.mirroredTurnId = turn.id;
  }

  private handleCancelledTurn(turn: TurnSnapshot | null): void {
    if (turn === null || (turn.status !== 'cancelled' && turn.status !== 'error')) {
      return;
    }
    if (this.handledTerminalTurnId === turn.id) {
      return;
    }
    this.handledTerminalTurnId = turn.id;
    this.bot.stop();
    this.onTurnCancelled();
  }

  private async stopActiveTurn(): Promise<void> {
    this.bot.stop();
    this.onTurnCancelled();
    try {
      const latest = await this.trueforge.latestTurn();
      if (isBusy(latest)) {
        await this.trueforge.cancelActiveTurn();
      }
      await this.bot.say('Stopped. The active Minecraft plan is no longer authorized.');
    } catch (caught) {
      console.warn('Could not cancel the active TrueForge turn from Minecraft chat', caught);
    }
  }

  private botUsername(): string {
    return this.bot.inspect({ radius: 1 }).username;
  }
}
