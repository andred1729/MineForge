import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { describe, expect, it, vi } from 'vitest';

import { MineflayerBot, runAbortable, runCreativeFlight } from '../src/mineflayerBot.js';

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

  it('halts creative movement promptly and restores gravity after abort', async () => {
    vi.useFakeTimers();
    const originalGravity = 0.08;
    const startFlying = vi.fn();
    const stopFlying = vi.fn();
    const fakeBot = {
      creative: { startFlying, stopFlying },
      entity: { position: new Vec3(0, 100, 0), velocity: new Vec3(0, 0, 0) },
      physics: { gravity: originalGravity },
    } as unknown as Bot;
    startFlying.mockImplementation(() => {
      fakeBot.physics.gravity = 0;
    });
    stopFlying.mockImplementation(() => {
      fakeBot.physics.gravity = originalGravity;
    });
    const controller = new AbortController();
    const flight = runCreativeFlight({
      bot: fakeBot,
      destination: new Vec3(10, 100, 0),
      signal: controller.signal,
      assertAuthorized: () => {},
    });

    await vi.advanceTimersByTimeAsync(50);
    controller.abort();
    const stoppedAt = fakeBot.entity.position.x;
    await expect(flight).rejects.toThrow('cancelled');
    await vi.advanceTimersByTimeAsync(500);

    expect(fakeBot.entity.position.x).toBe(stoppedAt);
    expect(stopFlying).toHaveBeenCalledOnce();
    expect(fakeBot.physics.gravity).toBe(originalGravity);
    vi.useRealTimers();
  });

  it('does not touch creative gravity when stopping a survival action', () => {
    const stopFlying = vi.fn();
    const fakeBot = {
      creative: { stopFlying },
      pathfinder: { stop: vi.fn() },
      stopDigging: vi.fn(),
      clearControlStates: vi.fn(),
    } as unknown as Bot;
    const adapter = new MineflayerBot({ host: '127.0.0.1', port: 25_565, username: 'Bot', version: '1.21.4' });
    (adapter as unknown as { bot: Bot }).bot = fakeBot;

    adapter.stop();

    expect(stopFlying).not.toHaveBeenCalled();
  });
});
