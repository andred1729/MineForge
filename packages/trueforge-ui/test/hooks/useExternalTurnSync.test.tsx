// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ServerProvider } from '@/server/ServerContext.js';
import { createMockAgentUIServer } from '../server/mockServer.js';

const reload = vi.hoisted(() => vi.fn(async () => {}));
const runtimeState = vi.hoisted(() => ({ remoteId: 'session-1', isLoading: false, isRunning: false }));

vi.mock('@truefoundry/assistant-ui-runtime', () => ({
  useTrueFoundryReload: () => reload,
}));

vi.mock('@assistant-ui/core/react', () => ({
  useThreadIsRunning: () => runtimeState.isRunning,
}));

vi.mock('@/assistant-ui.js', () => ({
  useAuiState: (selector: (state: unknown) => unknown) =>
    selector({
      threadListItem: { remoteId: runtimeState.remoteId },
      thread: { isLoading: runtimeState.isLoading },
    }),
}));

import { ExternalTurnSync } from '@/hooks/useExternalTurnSync.js';

describe('ExternalTurnSync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    reload.mockClear();
    runtimeState.remoteId = 'session-1';
    runtimeState.isLoading = false;
    runtimeState.isRunning = false;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  it('establishes a baseline and reloads when a newer external turn appears', async () => {
    let latestId = 'turn-1';
    const server = createMockAgentUIServer({
      listTurns: async () => ({
        data: [
          {
            id: latestId,
            sessionId: 'session-1',
            createdAt: new Date().toISOString(),
            state: { status: 'running' },
          },
        ],
      }),
    });
    render(
      <ServerProvider server={server}>
        <ExternalTurnSync server={server} config={{ intervalMs: 250 }} />
      </ServerProvider>,
    );
    await act(async () => await vi.advanceTimersByTimeAsync(0));
    expect(reload).not.toHaveBeenCalled();

    latestId = 'turn-2';
    await act(async () => await vi.advanceTimersByTimeAsync(250));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not poll while the page is hidden', async () => {
    const listTurns = vi.fn(async () => ({ data: [] }));
    const server = createMockAgentUIServer({ listTurns });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    render(
      <ServerProvider server={server}>
        <ExternalTurnSync server={server} config={{ intervalMs: 250 }} />
      </ServerProvider>,
    );
    await act(async () => await vi.advanceTimersByTimeAsync(1_000));
    expect(listTurns).not.toHaveBeenCalled();

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    await act(async () => await vi.advanceTimersByTimeAsync(0));
    expect(listTurns).toHaveBeenCalledOnce();
  });

  it('does not poll while the runtime is streaming', async () => {
    const listTurns = vi.fn(async () => ({ data: [] }));
    const server = createMockAgentUIServer({ listTurns });
    runtimeState.isRunning = true;
    render(
      <ServerProvider server={server}>
        <ExternalTurnSync server={server} config={{ intervalMs: 250 }} />
      </ServerProvider>,
    );
    await act(async () => await vi.advanceTimersByTimeAsync(1_000));
    expect(listTurns).not.toHaveBeenCalled();
  });

  it('silently retries transient API failures without duplicate reloads', async () => {
    let attempt = 0;
    const server = createMockAgentUIServer({
      listTurns: async () => {
        attempt += 1;
        if (attempt === 1) {
          throw new Error('temporary network failure');
        }
        return {
          data: [
            {
              id: attempt < 3 ? 'turn-1' : 'turn-2',
              sessionId: 'session-1',
              createdAt: new Date().toISOString(),
              state: {
                status: 'done',
                completedAt: new Date().toISOString(),
                requiredActions: [],
              },
            },
          ],
        };
      },
    });
    render(
      <ServerProvider server={server}>
        <ExternalTurnSync server={server} config={{ intervalMs: 250 }} />
      </ServerProvider>,
    );
    await act(async () => await vi.advanceTimersByTimeAsync(750));
    expect(reload).toHaveBeenCalledOnce();
  });
});
