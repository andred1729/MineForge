import { z } from 'zod';

import type { Position } from './domain.js';

export const BotRoleSchema = z.enum(['lumberjack', 'miner', 'builder', 'hunter', 'scout']);
export type BotRole = z.infer<typeof BotRoleSchema>;

export const BotIdentitySchema = z.object({
  ordinal: z.number().int().min(1).max(5),
  username: z.string().regex(/^ForgeBot[1-5]$/),
  slug: z.string().regex(/^forgebot[1-5]$/),
  role: BotRoleSchema,
  connectorName: z.string().regex(/^minecraft-forgebot[1-5]$/),
  agentName: z.string().regex(/^forgebot[1-5]-(?:lumberjack|miner|builder|hunter|scout)$/),
});
export type BotIdentity = z.infer<typeof BotIdentitySchema>;

const ROLE_SLOTS: readonly BotRole[] = ['lumberjack', 'miner', 'builder', 'hunter', 'scout'];
const ROLE_LABELS: Record<BotRole, string> = {
  lumberjack: 'Lumberjack',
  miner: 'Miner',
  builder: 'Builder',
  hunter: 'Hunter',
  scout: 'Scout',
};

export const LUMBERJACK_DEMO_WORKSITE: Readonly<Position> = { x: -46, y: 66, z: -6 };
export const BUILDER_DEMO_ORIGIN: Readonly<Position> = { x: 2, y: 64, z: 0 };
export const BUILDER_DEMO_CENTER: Readonly<Position> = { x: 18, y: 64, z: 16 };

export function demoWorksitesForRole(role: BotRole): Position[] {
  if (role === 'lumberjack') {
    return [{ ...LUMBERJACK_DEMO_WORKSITE }];
  }
  return role === 'builder' ? [{ ...BUILDER_DEMO_CENTER }] : [];
}

export function createBotIdentity(ordinal: number, requestedRole?: BotRole): BotIdentity {
  const role = requestedRole ?? ROLE_SLOTS[ordinal - 1];
  if (role === undefined) {
    throw new Error('The Minecraft workforce is limited to five bots.');
  }
  const username = `ForgeBot${String(ordinal)}`;
  const slug = `forgebot${String(ordinal)}`;
  return BotIdentitySchema.parse({
    ordinal,
    username,
    slug,
    role,
    connectorName: `minecraft-${slug}`,
    agentName: `${slug}-${role}`,
  });
}

export function roleActivationMessage(identity: BotIdentity): string {
  const equipment: Record<BotRole, string> = {
    lumberjack: 'given a stone axe',
    miner: 'given an iron pickaxe',
    builder: 'given building supplies',
    hunter: 'given an iron sword',
    scout: 'given a compass and spyglass',
  };
  return `${roleLabel(identity.role)} — ${identity.username} · ${equipment[identity.role]}`;
}

export function roleLabel(role: BotRole): string {
  return ROLE_LABELS[role];
}
