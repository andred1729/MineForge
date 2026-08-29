// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ServerProvider } from '@/server/ServerContext.js';
import type { Session, Turn } from '@/server/types.js';
import { createMockAgentUIServer } from '../server/mockServer.js';

const reload = vi.hoisted(() => vi.fn<() => Promise<void>>());
const reloadThreadList = vi.hoisted(() => vi.fn<() => Promise<void>>());
const runtimeState = vi.hoisted(() => ({
  remoteId: 'session-1',
  isLoading: false,
  isRunning: false,
  localTurnId: 'turn-1' as string | null,
}));

vi.mock('@truefoundry/assistant-ui-runtime', () => ({
  useTrueFoundryReload: () => reload,
}));

vi.mock('@assistant-ui/core/react', () => ({
  useThreadIsRunning: () => runtimeState.isRunning,
}));

vi.mock('@/assistant-ui.js', () => ({
  useAui: () => ({ threads: () => ({ reload: reloadThreadList }) }),
  useAuiState: (selector: (state: unknown) => unknown) =>
    selector({
      threadListItem: { remoteId: runtimeState.remoteId },
      thread: {
        isLoading: runtimeState.isLoading,
        messages:
          runtimeState.localTurnId === null ? [] : [{ metadata: { custom: { turnId: runtimeState.localTurnId } } }],
      },
    }),
}));

import { ExternalTurnSync } from '@/hooks/useExternalTurnSync.js';

function turn(id: string, sessionId = runtimeState.remoteId): Turn {
  return {
    id,
    sessionId,
    createdAt: new Date().toISOString(),
    state: { status: 'done', completedAt: new Date().toISOString(), requiredActions: [] },
  };
}

function session(id: string, updatedAt: string): Session {
  return {
    id,
    isMutable: false,
    createdAt: '2026-08-29T00:00:00.000Z',
    updatedAt,
  };
}

function renderSync(server: ReturnType<typeof createMockAgentUIServer>) {
  return render(
    <ServerProvider server={server}>
      <ExternalTurnSync server={server} config={{ intervalMs: 250 }} />
    </ServerProvider>,
  );
}

describe('ExternalTurnSync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    reload.mockReset().mockResolvedValue();
    reloadThreadList.mockReset().mockResolvedValue();
    runtimeState.remoteId = 'session-1';
    runtimeState.isLoading = false;
    runtimeState.isRunning = false;
    runtimeState.localTurnId = 'turn-1';
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  it('follows chronological pages and reloads when the actual newest turn changes', async () => {
    let newestIds = ['turn-3'];
    const listTurns = vi.fn(async ({ pageToken }: { pageToken?: string }) =>
      pageToken === undefined
        ? { data: [turn('turn-1'), turn('turn-2')], nextPageToken: 'page-2' }
        : { data: newestIds.map(id => turn(id)) },
    );
    const server = createMockAgentUIServer({ listTurns });
    renderSync(server);

    await act(async () => await vi.advanceTimersByTimeAsync(0));
    expect(reload).not.toHaveBeenCalled();
    expect(listTurns).toHaveBeenCalledWith({ sessionId: 'session-1', limit: 100, pageToken: 'page-2' });

    newestIds = ['turn-3', 'turn-4'];
    await act(async () => await vi.advanceTimersByTimeAsync(250));
    expect(reload).toHaveBeenCalledOnce();
  });

  it('retries the same external turn when reload fails', async () => {
    let latestId = 'turn-1';
    const server = createMockAgentUIServer({ listTurns: async () => ({ data: [turn(latestId)] }) });
    renderSync(server);
    await act(async () => await vi.advanceTimersByTimeAsync(0));

    latestId = 'turn-2';
    reload.mockRejectedValueOnce(new Error('temporary reload failure'));
    await act(async () => await vi.advanceTimersByTimeAsync(250));
    expect(reload).toHaveBeenCalledTimes(1);

    await act(async () => await vi.advanceTimersByTimeAsync(250));
    expect(reload).toHaveBeenCalledTimes(2);
    await act(async () => await vi.advanceTimersByTimeAsync(250));
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('reloads an external turn created while local streaming is paused', async () => {
    let latestId = 'turn-1';
    const server = createMockAgentUIServer({ listTurns: async () => ({ data: [turn(latestId)] }) });
    const view = renderSync(server);
    await act(async () => await vi.advanceTimersByTimeAsync(0));

    runtimeState.isRunning = true;
    runtimeState.localTurnId = 'turn-2';
    view.rerender(
      <ServerProvider server={server}>
        <ExternalTurnSync server={server} config={{ intervalMs: 250 }} />
      </ServerProvider>,
    );
    latestId = 'turn-3';
    await act(async () => await vi.advanceTimersByTimeAsync(500));
    expect(reload).not.toHaveBeenCalled();

    runtimeState.isRunning = false;
    view.rerender(
      <ServerProvider server={server}>
        <ExternalTurnSync server={server} config={{ intervalMs: 250 }} />
      </ServerProvider>,
    );
    await act(async () => await vi.advanceTimersByTimeAsync(0));
    expect(reload).toHaveBeenCalledOnce();
  });

  it('accepts a locally owned turn after streaming without reloading it', async () => {
    let latestId = 'turn-1';
    const server = createMockAgentUIServer({ listTurns: async () => ({ data: [turn(latestId)] }) });
    const view = renderSync(server);
    await act(async () => await vi.advanceTimersByTimeAsync(0));

    runtimeState.isRunning = true;
    runtimeState.localTurnId = 'turn-2';
    view.rerender(
      <ServerProvider server={server}>
        <ExternalTurnSync server={server} config={{ intervalMs: 250 }} />
      </ServerProvider>,
    );
    latestId = 'turn-2';
    runtimeState.isRunning = false;
    view.rerender(
      <ServerProvider server={server}>
        <ExternalTurnSync server={server} config={{ intervalMs: 250 }} />
      </ServerProvider>,
    );
    await act(async () => await vi.advanceTimersByTimeAsync(0));
    expect(reload).not.toHaveBeenCalled();
  });

  it('lets a new session poll while the old session request is hung', async () => {
    let resolveOldRequest: ((value: { data: Turn[] }) => void) | undefined;
    const oldRequest = new Promise<{ data: Turn[] }>(resolve => {
      resolveOldRequest = resolve;
    });
    const listTurns = vi.fn(async ({ sessionId }: { sessionId: string }) => {
      if (sessionId === 'session-1') {
        return await oldRequest;
      }
      return { data: [turn('turn-b', sessionId)] };
    });
    const server = createMockAgentUIServer({ listTurns });
    const view = renderSync(server);
    await act(async () => await vi.advanceTimersByTimeAsync(0));

    runtimeState.remoteId = 'session-2';
    runtimeState.localTurnId = 'turn-b';
    view.rerender(
      <ServerProvider server={server}>
        <ExternalTurnSync server={server} config={{ intervalMs: 250 }} />
      </ServerProvider>,
    );
    await act(async () => await vi.advanceTimersByTimeAsync(0));
    expect(listTurns).toHaveBeenCalledWith({ sessionId: 'session-2', limit: 100 });

    resolveOldRequest?.({ data: [turn('turn-a', 'session-1')] });
    await act(async () => await Promise.resolve());
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not poll while hidden and resumes immediately when visible', async () => {
    const listTurns = vi.fn(async () => ({ data: [] }));
    const server = createMockAgentUIServer({ listTurns });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    renderSync(server);
    await act(async () => await vi.advanceTimersByTimeAsync(1_000));
    expect(listTurns).not.toHaveBeenCalled();

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    await act(async () => await vi.advanceTimersByTimeAsync(0));
    expect(listTurns).toHaveBeenCalledOnce();
  });

  it('silently retries transient polling failures', async () => {
    let attempt = 0;
    const server = createMockAgentUIServer({
      listTurns: async () => {
        attempt += 1;
        if (attempt === 1) {
          throw new Error('temporary network failure');
        }
        return { data: [turn(attempt < 3 ? 'turn-1' : 'turn-2')] };
      },
    });
    renderSync(server);
    await act(async () => await vi.advanceTimersByTimeAsync(750));
    expect(reload).toHaveBeenCalledOnce();
  });

  it('reloads the thread list when an externally created session appears', async () => {
    let sessions = [session('session-1', '2026-08-29T00:00:00.000Z')];
    const listSessions = vi.fn(async () => ({ data: sessions }));
    const server = createMockAgentUIServer({ listSessions });
    renderSync(server);

    await act(async () => await vi.advanceTimersByTimeAsync(0));
    expect(reloadThreadList).not.toHaveBeenCalled();
    expect(listSessions).toHaveBeenCalledWith({ limit: 25, order: 'desc' });

    sessions = [session('session-2', '2026-08-29T00:00:01.000Z'), session('session-1', '2026-08-29T00:00:00.000Z')];
    await act(async () => await vi.advanceTimersByTimeAsync(250));
    expect(reloadThreadList).toHaveBeenCalledOnce();
  });

  it('retries external session discovery when the thread-list reload fails', async () => {
    let sessions = [session('session-1', '2026-08-29T00:00:00.000Z')];
    const server = createMockAgentUIServer({ listSessions: async () => ({ data: sessions }) });
    renderSync(server);
    await act(async () => await vi.advanceTimersByTimeAsync(0));

    sessions = [session('session-2', '2026-08-29T00:00:01.000Z'), ...sessions];
    reloadThreadList.mockRejectedValueOnce(new Error('temporary thread-list reload failure'));
    await act(async () => await vi.advanceTimersByTimeAsync(250));
    expect(reloadThreadList).toHaveBeenCalledTimes(1);

    await act(async () => await vi.advanceTimersByTimeAsync(250));
    expect(reloadThreadList).toHaveBeenCalledTimes(2);
    await act(async () => await vi.advanceTimersByTimeAsync(250));
    expect(reloadThreadList).toHaveBeenCalledTimes(2);
  });

  it('discovers sessions while the selected thread is streaming', async () => {
    runtimeState.isRunning = true;
    let sessions = [session('session-1', '2026-08-29T00:00:00.000Z')];
    const listTurns = vi.fn(async () => ({ data: [turn('turn-1')] }));
    const server = createMockAgentUIServer({ listSessions: async () => ({ data: sessions }), listTurns });
    renderSync(server);
    await act(async () => await vi.advanceTimersByTimeAsync(0));

    sessions = [session('session-2', '2026-08-29T00:00:01.000Z'), ...sessions];
    await act(async () => await vi.advanceTimersByTimeAsync(250));
    expect(reloadThreadList).toHaveBeenCalledOnce();
    expect(listTurns).not.toHaveBeenCalled();
  });
});
