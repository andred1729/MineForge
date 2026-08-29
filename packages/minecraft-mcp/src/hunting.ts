import { z } from 'zod';

import type { Position } from './domain.js';

export const HuntSpeciesSchema = z.enum(['cow', 'pig', 'sheep', 'chicken']);
export const HUNT_SPECIES = HuntSpeciesSchema.options;
export type HuntSpecies = z.infer<typeof HuntSpeciesSchema>;

export interface HuntCandidate {
  id: number;
  type: string;
  name?: string;
  position: Position;
  registryIdentityMatches: boolean;
  customNamed: boolean;
  baby: boolean;
  saddled: boolean;
  attached: boolean;
  hasPassengers: boolean;
}

export interface HuntableAnimal {
  id: number;
  species: HuntSpecies;
  distance: number;
  position: Position;
}

export interface NearbyAttackEntity {
  id: number;
  type: string;
  isValid: boolean;
  position: Position;
}

const DROP_NAMES: Record<HuntSpecies, readonly string[]> = {
  cow: ['beef', 'cooked_beef', 'leather'],
  pig: ['porkchop', 'cooked_porkchop'],
  sheep: ['mutton', 'cooked_mutton'],
  chicken: ['chicken', 'cooked_chicken', 'feather'],
};

function normalizedSpecies(candidate: HuntCandidate): HuntSpecies | null {
  const value = (candidate.name ?? '').toLowerCase().replaceAll(' ', '_');
  const parsed = HuntSpeciesSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function horizontalDistance({ left, right }: { left: Position; right: Position }): number {
  return Math.hypot(left.x - right.x, left.z - right.z);
}

export function selectHuntableAnimals({
  candidates,
  species,
  origin,
  maxDistance,
  withinBounds,
}: {
  candidates: HuntCandidate[];
  species: HuntSpecies;
  origin: Position;
  maxDistance: number;
  withinBounds: (position: Position) => boolean;
}): HuntableAnimal[] {
  return candidates
    .filter(candidate => {
      return (
        candidate.type === 'animal' &&
        candidate.registryIdentityMatches &&
        !candidate.customNamed &&
        !candidate.baby &&
        !candidate.saddled &&
        !candidate.attached &&
        !candidate.hasPassengers &&
        normalizedSpecies(candidate) === species &&
        withinBounds(candidate.position) &&
        horizontalDistance({ left: origin, right: candidate.position }) <= maxDistance
      );
    })
    .map(candidate => ({
      id: candidate.id,
      species,
      distance: Math.round(horizontalDistance({ left: origin, right: candidate.position }) * 10) / 10,
      position: { ...candidate.position },
    }))
    .sort((left, right) => left.distance - right.distance);
}

export function isVerifiedAnimalDrop({ species, itemName }: { species: HuntSpecies; itemName: string }): boolean {
  if (species === 'sheep' && itemName.endsWith('_wool')) {
    return true;
  }
  return DROP_NAMES[species].includes(itemName);
}

export function hasSafeSwordClearance({
  targetId,
  targetPosition,
  entities,
}: {
  targetId: number;
  targetPosition: Position;
  entities: NearbyAttackEntity[];
}): boolean {
  return entities.every(entity => {
    if (!entity.isValid || entity.id === targetId || !['animal', 'mob', 'player'].includes(entity.type)) {
      return true;
    }
    return (
      Math.hypot(
        targetPosition.x - entity.position.x,
        targetPosition.y - entity.position.y,
        targetPosition.z - entity.position.z,
      ) > 3
    );
  });
}
