import { TrueForge, type TrueForgeApi } from '@truefoundry/trueforge-sdk';

export interface TurnSnapshot {
  id: string;
  status: 'running' | 'done' | 'cancelled' | 'error';
  hasRequiredActions: boolean;
  responseText: string | null;
}

export interface TrueForgeSessionPort {
  latestTurn(): Promise<TurnSnapshot | null>;
  createUserTurn(message: string): Promise<TurnSnapshot>;
  cancelActiveTurn(): Promise<void>;
}

interface PageLike<T> {
  data: T[];
  hasNextPage(): boolean;
  getNextPage(): Promise<PageLike<T>>;
}

export async function lastItemAcrossPages<T>(firstPage: PageLike<T>): Promise<T | null> {
  let page = firstPage;
  let last = page.data.at(-1) ?? null;
  while (page.hasNextPage()) {
    page = await page.getNextPage();
    last = page.data.at(-1) ?? last;
  }
  return last;
}

function contentText(content: TrueForgeApi.ModelMessageEventContent | null | undefined): string | null {
  if (typeof content === 'string') {
    return content.trim().length === 0 ? null : content.trim();
  }
  if (content === null || content === undefined) {
    return null;
  }
  const text = content
    .map(part => (part.type === 'text' ? part.text : part.refusal))
    .filter(part => part.length > 0)
    .join('\n')
    .trim();
  return text.length === 0 ? null : text;
}

function toSnapshot(turn: TrueForgeApi.Turn): TurnSnapshot {
  const state = turn.state;
  return {
    id: turn.id,
    status: state.status,
    hasRequiredActions: state.status === 'done' && state.requiredActions.length > 0,
    responseText: state.status === 'done' ? contentText(state.output?.content) : null,
  };
}

export class TrueForgeSessionClient implements TrueForgeSessionPort {
  private readonly client: TrueForge;

  constructor({ baseUrl, token, sessionId }: { baseUrl: string; token?: string; sessionId: string }) {
    this.client = new TrueForge({ baseUrl, ...(token === undefined ? {} : { token }) });
    this.sessionId = sessionId;
  }

  private readonly sessionId: string;

  async latestTurn(): Promise<TurnSnapshot | null> {
    const page = await this.client.sessions.listTurns(this.sessionId, { limit: 25 });
    const turn = await lastItemAcrossPages(page);
    return turn === null ? null : toSnapshot(turn);
  }

  async createUserTurn(message: string): Promise<TurnSnapshot> {
    const response = await this.client.sessions.createTurn(this.sessionId, {
      input: [{ type: 'user.message', content: message }],
    });
    return toSnapshot(response.data);
  }

  async cancelActiveTurn(): Promise<void> {
    await this.client.sessions.cancel(this.sessionId);
  }
}
