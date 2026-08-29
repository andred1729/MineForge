import { setTimeout as delay } from 'node:timers/promises';

export function calculateNewItemCount({
  currentItemCount,
  expectedCount,
  startingItemCount,
}: {
  currentItemCount: number;
  expectedCount: number;
  startingItemCount: number;
}): number {
  return Math.min(expectedCount, Math.max(0, currentItemCount - startingItemCount));
}

export async function waitForItemCountAtLeast({
  readItemCount,
  expectedItemCount,
  signal,
  timeoutMs = 5_000,
  pollIntervalMs = 100,
}: {
  readItemCount: () => number;
  expectedItemCount: number;
  signal: AbortSignal;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<number> {
  if (signal.aborted) {
    throw new Error('Minecraft action was cancelled while waiting for an inventory update.');
  }
  const deadline = Date.now() + timeoutMs;
  let currentItemCount = readItemCount();
  while (currentItemCount < expectedItemCount && Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    try {
      await delay(Math.min(Math.max(1, pollIntervalMs), remainingMs), undefined, { signal });
    } catch (caught) {
      throw new Error('Minecraft action was cancelled while waiting for an inventory update.', { cause: caught });
    }
    currentItemCount = readItemCount();
  }
  return currentItemCount;
}
