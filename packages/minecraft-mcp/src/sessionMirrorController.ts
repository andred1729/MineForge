import type { MinecraftBotPort } from './botPort.js';
import type { TrueForgeSessionPort, TurnSnapshot } from './trueforgePort.js';

function isTerminalFailure(turn: TurnSnapshot): boolean {
  return turn.status === 'cancelled' || turn.status === 'error';
}

export class SessionMirrorController {
  private pollingHandle: NodeJS.Timeout | null = null;
  private polling = false;
  private mirroredTurnId: string | null = null;
  private handledTerminalTurnId: string | null = null;

  constructor(
    private readonly bot: MinecraftBotPort,
    private readonly trueforge: TrueForgeSessionPort,
    private readonly onTurnCancelled: () => void,
    private readonly pollIntervalMs = 1_000,
  ) {}

  async start(): Promise<void> {
    const initialTurn = await this.trueforge.latestTurn();
    this.mirroredTurnId = initialTurn?.status === 'running' ? null : (initialTurn?.id ?? null);
    this.pollingHandle = setInterval(() => void this.tick(), this.pollIntervalMs);
  }

  close(): Promise<void> {
    if (this.pollingHandle !== null) {
      clearInterval(this.pollingHandle);
      this.pollingHandle = null;
    }
    return Promise.resolve();
  }

  async tick(): Promise<void> {
    if (this.polling) {
      return;
    }
    this.polling = true;
    try {
      const latest = await this.trueforge.latestTurn();
      if (latest === null) {
        return;
      }
      if (isTerminalFailure(latest) && this.handledTerminalTurnId !== latest.id) {
        this.handledTerminalTurnId = latest.id;
        this.bot.stop();
        this.onTurnCancelled();
      }
      if (
        latest.status === 'done' &&
        !latest.hasRequiredActions &&
        latest.responseText !== null &&
        this.mirroredTurnId !== latest.id
      ) {
        await this.bot.say(latest.responseText);
        this.mirroredTurnId = latest.id;
      }
    } catch (caught) {
      console.warn('Minecraft session mirror tick failed', caught);
    } finally {
      this.polling = false;
    }
  }
}
