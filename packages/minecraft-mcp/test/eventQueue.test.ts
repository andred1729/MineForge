import { describe, expect, it } from 'vitest';

import { EventQueue } from '../src/eventQueue.js';

describe('EventQueue', () => {
  it('deduplicates chat while preserving FIFO order', () => {
    const queue = new EventQueue(2);
    expect(queue.enqueue({ type: 'minecraft_chat', username: 'Alex', message: 'build' })).toBe(true);
    expect(queue.enqueue({ type: 'minecraft_chat', username: 'Alex', message: 'build' })).toBe(false);
    expect(queue.enqueue({ type: 'minecraft_chat', username: 'Sam', message: 'stop' })).toBe(true);
    expect(queue.enqueue({ type: 'minecraft_chat', username: 'Pat', message: 'look' })).toBe(false);

    expect(queue.dequeue()).toEqual({ type: 'minecraft_chat', username: 'Alex', message: 'build' });
    expect(queue.enqueue({ type: 'minecraft_chat', username: 'Alex', message: 'build' })).toBe(true);
  });

  it('reserves a failed in-flight event at the front', () => {
    const queue = new EventQueue(2);
    const first = { type: 'minecraft_chat' as const, username: 'Alex', message: 'first' };
    queue.enqueue(first);
    expect(queue.dequeue()).toEqual(first);
    queue.enqueue({ type: 'minecraft_chat', username: 'Sam', message: 'second' });
    queue.requeueFront(first);

    expect(queue.dequeue()).toEqual(first);
    expect(queue.dequeue()).toEqual({ type: 'minecraft_chat', username: 'Sam', message: 'second' });
  });
});
