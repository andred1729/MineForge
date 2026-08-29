import type { AgentEvent } from './domain.js';

export class EventQueue {
  private readonly items: AgentEvent[] = [];
  private readonly chatKeys = new Set<string>();

  constructor(private readonly capacity = 50) {}

  enqueue(event: AgentEvent): boolean {
    const key = event.type === 'minecraft_chat' ? `${event.username}\u0000${event.message}` : null;
    if (key !== null && this.chatKeys.has(key)) {
      return false;
    }
    if (this.items.length >= this.capacity) {
      return false;
    }
    this.items.push(event);
    if (key !== null) {
      this.chatKeys.add(key);
    }
    return true;
  }

  dequeue(): AgentEvent | undefined {
    const event = this.items.shift();
    if (event?.type === 'minecraft_chat') {
      this.chatKeys.delete(`${event.username}\u0000${event.message}`);
    }
    return event;
  }

  requeueFront(event: AgentEvent): void {
    if (this.items.length >= this.capacity) {
      const dropped = this.items.pop();
      if (dropped?.type === 'minecraft_chat') {
        this.chatKeys.delete(`${dropped.username}\u0000${dropped.message}`);
      }
    }
    this.items.unshift(event);
    if (event.type === 'minecraft_chat') {
      this.chatKeys.add(`${event.username}\u0000${event.message}`);
    }
  }

  get size(): number {
    return this.items.length;
  }
}
