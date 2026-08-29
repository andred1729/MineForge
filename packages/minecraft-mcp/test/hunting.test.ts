import { describe, expect, it } from 'vitest';

import {
  hasSafeSwordClearance,
  isVerifiedAnimalDrop,
  selectHuntableAnimals,
  type HuntCandidate,
} from '../src/hunting.js';

function candidate(overrides: Partial<HuntCandidate> = {}): HuntCandidate {
  return {
    id: 1,
    type: 'animal',
    name: 'cow',
    position: { x: 4, y: 64, z: 0 },
    registryIdentityMatches: true,
    customNamed: false,
    baby: false,
    saddled: false,
    attached: false,
    hasPassengers: false,
    ...overrides,
  };
}

describe('safe animal selection', () => {
  it.each(['cow', 'pig', 'sheep', 'chicken'] as const)('accepts an eligible %s', species => {
    const animals = selectHuntableAnimals({
      candidates: [candidate({ name: species })],
      species,
      origin: { x: 0, y: 64, z: 0 },
      maxDistance: 16,
      withinBounds: () => true,
    });

    expect(animals).toHaveLength(1);
  });

  it('returns only unprotected, allowlisted adult animals inside the approved bounds', () => {
    const animals = selectHuntableAnimals({
      candidates: [
        candidate(),
        candidate({ id: 2, customNamed: true }),
        candidate({ id: 3, type: 'player' }),
        candidate({ id: 4, name: 'zombie' }),
        candidate({ id: 5, position: { x: 40, y: 64, z: 0 } }),
        candidate({ id: 6, position: { x: 8, y: 64, z: 0 } }),
        candidate({ id: 7, baby: true }),
        candidate({ id: 8, saddled: true }),
        candidate({ id: 9, attached: true }),
        candidate({ id: 10, hasPassengers: true }),
        candidate({ id: 11, registryIdentityMatches: false }),
      ],
      species: 'cow',
      origin: { x: 0, y: 64, z: 0 },
      maxDistance: 16,
      withinBounds: position => position.x <= 6,
    });

    expect(animals).toEqual([{ id: 1, species: 'cow', distance: 4, position: { x: 4, y: 64, z: 0 } }]);
  });

  it('recognizes only species-specific inventory evidence', () => {
    expect(isVerifiedAnimalDrop({ species: 'cow', itemName: 'beef' })).toBe(true);
    expect(isVerifiedAnimalDrop({ species: 'sheep', itemName: 'black_wool' })).toBe(true);
    expect(isVerifiedAnimalDrop({ species: 'chicken', itemName: 'feather' })).toBe(true);
    expect(isVerifiedAnimalDrop({ species: 'cow', itemName: 'cooked_beef' })).toBe(true);
    expect(isVerifiedAnimalDrop({ species: 'pig', itemName: 'leather' })).toBe(false);
  });

  it('permits a sword attack only when no other living entity is in sweep range', () => {
    const target = { id: 1, type: 'animal', isValid: true, position: { x: 4, y: 64, z: 0 } };
    expect(hasSafeSwordClearance({ targetId: 1, targetPosition: target.position, entities: [target] })).toBe(true);
    expect(
      hasSafeSwordClearance({
        targetId: 1,
        targetPosition: target.position,
        entities: [target, { id: 2, type: 'player', isValid: true, position: { x: 5, y: 64, z: 0 } }],
      }),
    ).toBe(false);
  });
});
