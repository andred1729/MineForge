import { describe, expect, it, vi } from 'vitest';

import { runAbortable } from '../src/mineflayerBot.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: () => void = () => {};
  const promise = new Promise<void>(resolve => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

describe('Mineflayer cancellation', () => {
  it('does not release a cancelled craft or placement wrapper before the operation settles', async () => {
    const controller = new AbortController();
    const operationSettled = deferred();
    const stop = vi.fn();
    let wrapperSettled = false;

    const result = runAbortable({
      signal: controller.signal,
      operation: async () => {
        await operationSettled.promise;
      },
      stop,
    }).finally(() => {
      wrapperSettled = true;
    });

    controller.abort();
    await Promise.resolve();
    expect(stop).toHaveBeenCalledOnce();
    expect(wrapperSettled).toBe(false);

    operationSettled.resolve();
    await expect(result).rejects.toThrow('cancelled');
    expect(wrapperSettled).toBe(true);
  });
});
