import { afterEach, describe, expect, it, vi } from 'vitest';

import { calculateNewItemCount, waitForItemCountAtLeast } from '../src/inventory.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('calculateNewItemCount', () => {
  it('reports only new items and caps the expected amount', () => {
    expect(calculateNewItemCount({ currentItemCount: 14, expectedCount: 8, startingItemCount: 10 })).toBe(4);
    expect(calculateNewItemCount({ currentItemCount: 22, expectedCount: 8, startingItemCount: 10 })).toBe(8);
  });

  it('never reports a negative result if inventory shrinks', () => {
    expect(calculateNewItemCount({ currentItemCount: 3, expectedCount: 8, startingItemCount: 10 })).toBe(0);
  });
});

describe('waitForItemCountAtLeast', () => {
  it('polls until the expected gathered or crafted items appear', async () => {
    vi.useFakeTimers();
    let itemCount = 3;
    const result = waitForItemCountAtLeast({
      readItemCount: () => itemCount,
      expectedItemCount: 4,
      signal: new AbortController().signal,
    });

    await vi.advanceTimersByTimeAsync(400);
    itemCount = 4;
    await vi.advanceTimersByTimeAsync(100);

    await expect(result).resolves.toBe(4);
  });

  it('returns the observed count after the bounded timeout', async () => {
    vi.useFakeTimers();
    const result = waitForItemCountAtLeast({
      readItemCount: () => 3,
      expectedItemCount: 4,
      signal: new AbortController().signal,
      timeoutMs: 500,
    });

    await vi.advanceTimersByTimeAsync(500);

    await expect(result).resolves.toBe(3);
  });

  it('stops polling when the action is cancelled', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const result = waitForItemCountAtLeast({
      readItemCount: () => 3,
      expectedItemCount: 4,
      signal: controller.signal,
    });

    controller.abort();

    await expect(result).rejects.toThrow('cancelled while waiting');
  });

  it('rejects an action that was already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      waitForItemCountAtLeast({
        readItemCount: () => 4,
        expectedItemCount: 4,
        signal: controller.signal,
      }),
    ).rejects.toThrow('cancelled while waiting');
  });
});
