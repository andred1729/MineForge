import { describe, expect, it, vi } from 'vitest';

import { MinecraftActionQueue } from '../src/actionQueue.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: () => void = () => {};
  const promise = new Promise<void>(resolve => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

describe('MinecraftActionQueue', () => {
  it('runs actions one at a time in FIFO order', async () => {
    const queue = new MinecraftActionQueue();
    const firstGate = deferred();
    const order: string[] = [];
    const signal = new AbortController().signal;

    const first = queue.run({
      signal,
      onAbort: () => {},
      operation: async () => {
        order.push('first:start');
        await firstGate.promise;
        order.push('first:end');
        return 'first';
      },
    });
    const second = queue.run({
      signal,
      onAbort: () => {},
      operation: async () => {
        order.push('second:start');
        return 'second';
      },
    });

    await Promise.resolve();
    expect(order).toEqual(['first:start']);
    firstGate.resolve();

    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
    expect(order).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('skips a queued action that was cancelled before execution', async () => {
    const queue = new MinecraftActionQueue();
    const firstGate = deferred();
    const first = queue.run({
      signal: new AbortController().signal,
      onAbort: () => {},
      operation: async () => {
        await firstGate.promise;
      },
    });
    const cancelled = new AbortController();
    const operation = vi.fn(async () => 'unexpected');
    const second = queue.run({ signal: cancelled.signal, operation, onAbort: () => {} });

    cancelled.abort();
    firstGate.resolve();
    await first;

    await expect(second).rejects.toThrow('cancelled before execution');
    expect(operation).not.toHaveBeenCalled();
  });

  it('cancels the active action when a queued request is aborted and waits for it to settle', async () => {
    const queue = new MinecraftActionQueue();
    const activeStarted = deferred();
    const activeSettled = deferred();
    let activeSignal: AbortSignal | undefined;
    let activeFinished = false;

    const first = queue.run({
      signal: new AbortController().signal,
      onAbort: () => {},
      operation: async signal => {
        activeSignal = signal;
        activeStarted.resolve();
        await activeSettled.promise;
        activeFinished = true;
        throw new Error('Underlying operation settled after cancellation.');
      },
    });
    await activeStarted.promise;

    const queuedController = new AbortController();
    const queuedOperation = vi.fn(async () => 'unexpected');
    const revokePlan = vi.fn();
    const second = queue.run({
      signal: queuedController.signal,
      operation: queuedOperation,
      onAbort: revokePlan,
    });

    queuedController.abort();
    expect(revokePlan).toHaveBeenCalledOnce();
    expect(activeSignal?.aborted).toBe(true);
    expect(activeFinished).toBe(false);

    activeSettled.resolve();
    await expect(first).rejects.toThrow('settled after cancellation');
    await expect(second).rejects.toThrow('cancelled before execution');
    expect(queuedOperation).not.toHaveBeenCalled();
  });
});
