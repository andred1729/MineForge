'use client';

import { useThreadIsRunning } from '@assistant-ui/core/react';
import { useTrueFoundryReload } from '@truefoundry/assistant-ui-runtime';
import { useEffect, useRef } from 'react';

import { useAuiState } from '../assistant-ui.js';
import type { AgentUIServer } from '../server/types.js';

export type ExternalTurnSyncConfig = {
  /** How often to check the active idle session for a turn created outside this UI. Default: 1000ms. */
  intervalMs?: number;
};

type SyncBaseline = string | null | undefined;

async function newestTurnId({
  server,
  sessionId,
  isCancelled,
}: {
  server: AgentUIServer;
  sessionId: string;
  isCancelled: () => boolean;
}): Promise<string | null> {
  let pageToken: string | undefined;
  let newestId: string | null = null;
  const seenPageTokens = new Set<string>();

  do {
    const page = await server.listTurns({
      sessionId,
      limit: 100,
      ...(pageToken === undefined ? {} : { pageToken }),
    });
    if (isCancelled()) {
      return newestId;
    }
    newestId = page.data.at(-1)?.id ?? newestId;
    pageToken = page.nextPageToken;
    if (pageToken !== undefined) {
      if (seenPageTokens.has(pageToken)) {
        throw new Error('Turn pagination returned a repeated page token.');
      }
      seenPageTokens.add(pageToken);
    }
  } while (pageToken !== undefined);

  return newestId;
}

export function ExternalTurnSync({ server, config }: { server: AgentUIServer; config: ExternalTurnSyncConfig }) {
  const remoteId = useAuiState(state => state.threadListItem.remoteId);
  const isLoading = useAuiState(state => state.thread.isLoading);
  const localTurnId = useAuiState(state => {
    for (let index = state.thread.messages.length - 1; index >= 0; index -= 1) {
      const custom = state.thread.messages[index]?.metadata.custom as { turnId?: unknown } | undefined;
      if (typeof custom?.turnId === 'string') {
        return custom.turnId;
      }
    }
    return null;
  });
  const isRunning = useThreadIsRunning();
  const reload = useTrueFoundryReload();
  const reloadRef = useRef(reload);
  const baselineBySessionRef = useRef(new Map<string, SyncBaseline>());
  reloadRef.current = reload;

  useEffect(() => {
    if (remoteId == null || isRunning || isLoading) {
      return;
    }
    const intervalMs = Math.max(config.intervalMs ?? 1_000, 250);
    let cancelled = false;
    let requestInFlight = false;

    const poll = async () => {
      if (cancelled || requestInFlight || document.visibilityState !== 'visible') {
        return;
      }
      requestInFlight = true;
      try {
        const newestId = await newestTurnId({ server, sessionId: remoteId, isCancelled: () => cancelled });
        if (cancelled) {
          return;
        }

        const baseline = baselineBySessionRef.current.get(remoteId);
        if (baseline === undefined) {
          baselineBySessionRef.current.set(remoteId, newestId);
          return;
        }
        if (baseline === newestId) {
          return;
        }
        if (localTurnId === newestId) {
          baselineBySessionRef.current.set(remoteId, newestId);
          return;
        }

        await reloadRef.current();
        baselineBySessionRef.current.set(remoteId, newestId);
      } catch {
        // External synchronization is best-effort and must never disrupt chat.
      } finally {
        requestInFlight = false;
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void poll();
      }
    };
    void poll();
    const interval = window.setInterval(() => void poll(), intervalMs);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [config.intervalMs, isLoading, isRunning, localTurnId, remoteId, server]);

  return null;
}
