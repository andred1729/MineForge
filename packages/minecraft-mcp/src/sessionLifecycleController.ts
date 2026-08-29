import type { MinecraftBotPort } from './botPort.js';
import type { TrueForgeSessionPort, TurnSnapshot } from './trueforgePort.js';

function isTerminalFailure(turn: TurnSnapshot): boolean {
  return turn.status === 'cancelled' || turn.status === 'error';
}

export class SessionLifecycleController {
  private pollingHandle: NodeJS.Timeout | null = null;
  private polling = false;
  private handledTerminalTurnId: string | null = null;

  constructor(
    private readonly bot: MinecraftBotPort,
    private readonly trueforge: TrueForgeSessionPort,
    private readonly onTurnCancelled: () => void,
    private readonly pollIntervalMs = 1_000,
  ) {}

  start(): Promise<void> {
    this.pollingHandle = setInterval(() => void this.tick(), this.pollIntervalMs);
    return Promise.resolve();
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
      if (latest !== null && isTerminalFailure(latest) && this.handledTerminalTurnId !== latest.id) {
        this.handledTerminalTurnId = latest.id;
        this.bot.stop();
        this.onTurnCancelled();
      }
    } catch (caught) {
      console.warn('Minecraft session lifecycle poll failed', caught);
    } finally {
      this.polling = false;
    }
  }
}
