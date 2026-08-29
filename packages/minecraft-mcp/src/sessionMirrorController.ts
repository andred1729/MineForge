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
  private readonly pendingMinecraftMessages: string[] = [];
  private removeChatListener: (() => void) | null = null;

  constructor(
    private readonly bot: MinecraftBotPort,
    private readonly trueforge: TrueForgeSessionPort,
    private readonly onTurnCancelled: () => void,
    private readonly pollIntervalMs = 1_000,
    private readonly acceptMinecraftChat = false,
  ) {}

  async start(): Promise<void> {
    const initialTurn = await this.trueforge.latestTurn();
    this.mirroredTurnId = initialTurn?.status === 'running' ? null : (initialTurn?.id ?? null);
    if (this.acceptMinecraftChat) {
      const ownUsername = this.bot.inspect({ radius: 1 }).username;
      this.removeChatListener = this.bot.onChat(({ username, message }) => {
        if (username === ownUsername || /^ForgeBot\d+$/.test(username) || /^sub_agent\d+$/.test(username)) {
          return;
        }
        if (this.pendingMinecraftMessages.length >= 50) {
          this.pendingMinecraftMessages.shift();
        }
        this.pendingMinecraftMessages.push(`${username} says in Minecraft: ${message}`);
      });
    }
    this.pollingHandle = setInterval(() => void this.tick(), this.pollIntervalMs);
  }

  close(): Promise<void> {
    if (this.pollingHandle !== null) {
      clearInterval(this.pollingHandle);
      this.pollingHandle = null;
    }
    this.removeChatListener?.();
    this.removeChatListener = null;
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
        const pendingMessage = this.pendingMinecraftMessages[0];
        if (pendingMessage !== undefined) {
          await this.trueforge.createUserTurn(pendingMessage);
          this.pendingMinecraftMessages.shift();
        }
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
      const canStartExternalTurn =
        !latest.hasRequiredActions &&
        (latest.status === 'done' || latest.status === 'cancelled' || latest.status === 'error');
      const pendingMessage = this.pendingMinecraftMessages[0];
      if (canStartExternalTurn && pendingMessage !== undefined) {
        await this.trueforge.createUserTurn(pendingMessage);
        this.pendingMinecraftMessages.shift();
      }
    } catch (caught) {
      console.warn('Minecraft session mirror tick failed', caught);
    } finally {
      this.polling = false;
    }
  }
}
