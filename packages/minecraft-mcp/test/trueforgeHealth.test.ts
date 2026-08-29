import { afterEach, describe, expect, it, vi } from 'vitest';

import { waitForTrueForge } from '../src/trueforgeHealth.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TrueForge startup health wait', () => {
  it('times out a hung request and retries', async () => {
    let attempts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, options?: RequestInit) => {
        attempts += 1;
        if (attempts === 1) {
          await new Promise<void>((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
          });
        }
        return new Response(null, { status: 200 });
      }),
    );

    await waitForTrueForge({
      baseUrl: 'http://127.0.0.1:8790',
      signal: new AbortController().signal,
      requestTimeoutMs: 5,
      retryDelayMs: 1,
    });
    expect(attempts).toBe(2);
  });

  it('aborts a hung request immediately during shutdown', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, options?: RequestInit) => {
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
        });
        return new Response(null, { status: 200 });
      }),
    );

    const waiting = waitForTrueForge({
      baseUrl: 'http://127.0.0.1:8790',
      signal: controller.signal,
      requestTimeoutMs: 10_000,
      retryDelayMs: 10_000,
    });
    controller.abort(new Error('shutdown'));
    await expect(waiting).rejects.toThrow('shutdown');
  });
});
