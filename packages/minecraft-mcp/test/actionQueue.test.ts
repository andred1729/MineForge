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
      operation: async () => {
        order.push('first:start');
        await firstGate.promise;
        order.push('first:end');
        return 'first';
      },
    });
    const second = queue.run({
      signal,
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
      operation: async () => {
        await firstGate.promise;
      },
    });
    const cancelled = new AbortController();
    const operation = vi.fn(async () => 'unexpected');
    const second = queue.run({ signal: cancelled.signal, operation });

    cancelled.abort();
    firstGate.resolve();
    await first;

    await expect(second).rejects.toThrow('cancelled before execution');
    expect(operation).not.toHaveBeenCalled();
  });
});
