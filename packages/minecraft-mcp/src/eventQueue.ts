import type { MinecraftChatEvent } from './domain.js';

export class EventQueue {
  private readonly items: MinecraftChatEvent[] = [];
  private readonly chatKeys = new Set<string>();

  constructor(private readonly capacity = 50) {}

  enqueue(event: MinecraftChatEvent): boolean {
    const key = `${event.username}\u0000${event.message}`;
    if (this.chatKeys.has(key)) {
      return false;
    }
    if (this.items.length >= this.capacity) {
      return false;
    }
    this.items.push(event);
    this.chatKeys.add(key);
    return true;
  }

  dequeue(): MinecraftChatEvent | undefined {
    const event = this.items.shift();
    if (event !== undefined) {
      this.chatKeys.delete(`${event.username}\u0000${event.message}`);
    }
    return event;
  }

  requeueFront(event: MinecraftChatEvent): void {
    if (this.items.length >= this.capacity) {
      const dropped = this.items.pop();
      if (dropped !== undefined) {
        this.chatKeys.delete(`${dropped.username}\u0000${dropped.message}`);
      }
    }
    this.items.unshift(event);
    this.chatKeys.add(`${event.username}\u0000${event.message}`);
  }

  get size(): number {
    return this.items.length;
  }
}
