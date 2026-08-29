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

export function ExternalTurnSync({ server, config }: { server: AgentUIServer; config: ExternalTurnSyncConfig }) {
  const remoteId = useAuiState(state => state.threadListItem.remoteId);
  const isLoading = useAuiState(state => state.thread.isLoading);
  const isRunning = useThreadIsRunning();
  const reload = useTrueFoundryReload();
  const reloadRef = useRef(reload);
  const latestTurnIdRef = useRef<string | null | undefined>(undefined);
  reloadRef.current = reload;

  useEffect(() => {
    latestTurnIdRef.current = undefined;
  }, [remoteId]);

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
        const page = await server.listTurns({ sessionId: remoteId, limit: 100 });
          // listTurns is chronological; retrieve all pages and use the final row.
          let newestTurnId = page.data.at(-1)?.id ?? null;
          let nextPageToken = page.nextPageToken;
          while (nextPageToken !== undefined) {
            const nextPage = await server.listTurns({ sessionId: remoteId, limit: 100, pageToken: nextPageToken });
            newestTurnId = nextPage.data.at(-1)?.id ?? newestTurnId;
            nextPageToken = nextPage.nextPageToken;
          }
        if (cancelled) {
          return;
        }
        
        if (latestTurnIdRef.current === undefined) {
          
          return;
        }
        if (latestTurnIdRef.current !== newestTurnId) {
          
          await reloadRef.current();
            
        }
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
  }, [config.intervalMs, isLoading, isRunning, remoteId, server]);

  return null;
}
