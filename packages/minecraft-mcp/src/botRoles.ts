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

const BOT_ROLES: readonly BotRole[] = ['lumberjack', 'miner', 'builder', 'hunter', 'scout'];
const ROLE_LABELS: Record<BotRole, string> = {
  lumberjack: 'Lumberjack',
  miner: 'Miner',
  builder: 'Builder',
  hunter: 'Hunter',
  scout: 'Scout',
};

export const LUMBERJACK_DEMO_WORKSITE: Readonly<Position> = { x: -46, y: 66, z: -6 };

export function demoWorksites(): Position[] {
  return [{ ...LUMBERJACK_DEMO_WORKSITE }];
}

export function createBotIdentity(ordinal: number): BotIdentity {
  const role = BOT_ROLES[ordinal - 1];
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
