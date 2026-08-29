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
  const requestInFlightRef = useRef(false);
  reloadRef.current = reload;

  useEffect(() => {
    latestTurnIdRef.current = undefined;
  }, [remoteId]);

  useEffect(() => {
    if (isRunning || isLoading) {
      // The runtime already owns locally-created turns. The next idle poll establishes
      // a fresh baseline rather than reloading the turn that just finished here.
      latestTurnIdRef.current = undefined;
    }
  }, [isLoading, isRunning]);

  useEffect(() => {
    if (remoteId == null || isRunning || isLoading) {
      return;
    }
    const intervalMs = Math.max(config.intervalMs ?? 1_000, 250);
    let cancelled = false;

    const poll = async () => {
      if (cancelled || requestInFlightRef.current || document.visibilityState !== 'visible') {
        return;
      }
      requestInFlightRef.current = true;
      try {
        const page = await server.listTurns({ sessionId: remoteId, limit: 1 });
        if (cancelled) {
          return;
        }
        const newestTurnId = page.data[0]?.id ?? null;
        if (latestTurnIdRef.current === undefined) {
          latestTurnIdRef.current = newestTurnId;
          return;
        }
        if (latestTurnIdRef.current !== newestTurnId) {
          latestTurnIdRef.current = newestTurnId;
          await reloadRef.current();
        }
      } catch {
        // External synchronization is best-effort and must never disrupt chat.
      } finally {
        requestInFlightRef.current = false;
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
