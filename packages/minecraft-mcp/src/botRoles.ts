import { z } from 'zod';

import type { Position } from './domain.js';

export const BotRoleSchema = z.enum(['generalist', 'lumberjack', 'miner', 'builder', 'hunter', 'scout']);
export type BotRole = z.infer<typeof BotRoleSchema>;

export const BotIdentitySchema = z.object({
  ordinal: z.number().int().min(1).max(5),
  username: z.string().regex(/^ForgeBot[1-5]$/),
  slug: z.string().regex(/^forgebot[1-5]$/),
  role: BotRoleSchema,
  connectorName: z.string().regex(/^minecraft-forgebot[1-5]$/),
  agentName: z.string().regex(/^forgebot[1-5]-(?:generalist|lumberjack|miner|builder|hunter|scout)$/),
});
export type BotIdentity = z.infer<typeof BotIdentitySchema>;

const ROLE_LABELS: Record<BotRole, string> = {
  generalist: 'Worker',
  lumberjack: 'Lumberjack',
  miner: 'Miner',
  builder: 'Builder',
  hunter: 'Hunter',
  scout: 'Scout',
};

export const KNOWN_TREE_COORDINATE: Readonly<Position> = { x: -46, y: 66, z: -6 };
export const VILLA_BUILD_ORIGIN: Readonly<Position> = { x: 2, y: 64, z: 0 };
export const VILLA_BUILD_CENTER: Readonly<Position> = { x: 18, y: 64, z: 16 };

export function knownTaskLocationsForRole(role: BotRole): Position[] {
  if (role === 'generalist') {
    return [{ ...KNOWN_TREE_COORDINATE }, { ...VILLA_BUILD_CENTER }];
  }
  if (role === 'lumberjack') {
    return [{ ...KNOWN_TREE_COORDINATE }];
  }
  return role === 'builder' ? [{ ...VILLA_BUILD_CENTER }] : [];
}

export function createBotIdentity(ordinal: number, requestedRole?: BotRole): BotIdentity {
  if (ordinal < 1 || ordinal > 5) {
    throw new Error('The Minecraft workforce is limited to five bots.');
  }
  const role = requestedRole ?? 'generalist';
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

export function roleLabel(role: BotRole): string {
  return ROLE_LABELS[role];
}
