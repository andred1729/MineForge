import type { BlueprintBlock, Plan, Position } from './domain.js';

export interface InventoryItem {
  name: string;
  count: number;
}

export interface NearbyBlock {
  name: string;
  position: Position;
}

export interface NearbyEntity {
  id: number;
  name: string;
  kind: string;
  distance: number;
  position: Position;
}

export interface WorldObservation {
  connected: boolean;
  username: string;
  position: Position;
  health: number;
  food: number;
  dimension: string;
  timeOfDay: number;
  isRaining: boolean;
  inventory: InventoryItem[];
  nearbyBlocks: NearbyBlock[];
  nearbyEntities: NearbyEntity[];
}

export interface ActionProgress {
  requested: number;
  completed: number;
  details: string[];
}

export interface MinecraftBotPort {
  start(): Promise<void>;
  close(): Promise<void>;
  isConnected(): boolean;
  position(): Position;
  inspect(options: { radius: number }): WorldObservation;
  moveTo(options: {
    target: Position;
    range: number;
    plan: Plan;
    signal: AbortSignal;
    assertAuthorized: () => void;
  }): Promise<void>;
  gather(options: {
    blockName: string;
    count: number;
    maxDistance: number;
    plan: Plan;
    signal: AbortSignal;
    assertAuthorized: () => void;
  }): Promise<ActionProgress>;
  craft(options: {
    itemName: string;
    count: number;
    signal: AbortSignal;
    assertAuthorized: () => void;
  }): Promise<ActionProgress>;
  executeBlueprint(options: {
    origin: Position;
    blocks: BlueprintBlock[];
    plan: Plan;
    signal: AbortSignal;
    assertAuthorized: () => void;
  }): Promise<ActionProgress>;
  drop(options: {
    itemName: string;
    count: number;
    signal: AbortSignal;
    assertAuthorized: () => void;
  }): Promise<ActionProgress>;
  stop(): void;
  say(message: string): Promise<void>;
  onChat(listener: (event: { username: string; message: string }) => void): () => void;
}
