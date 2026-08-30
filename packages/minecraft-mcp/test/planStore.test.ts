import { describe, expect, it } from 'vitest';

import { isPositionWithinPlanBounds, PlanStore } from '../src/planStore.js';

describe('PlanStore', () => {
  it('enforces action, radius, and expiration bounds', () => {
    let now = 1_000;
    const store = new PlanStore(() => now);
    const plan = store.begin({
      input: {
        summary: 'Build a shelter',
        steps: ['Gather wood', 'Build'],
        permitted_actions: ['gather', 'build'],
        duration_minutes: 1,
        radius_blocks: 8,
      },
      origin: { x: 0, y: 64, z: 0 },
    });

    expect(store.require({ planId: plan.id, action: 'build' })).toEqual(plan);
    expect(() => store.require({ planId: plan.id, action: 'drop' })).toThrow('does not permit');
    expect(isPositionWithinPlanBounds({ plan, position: { x: 8, y: 64, z: 0 } })).toBe(true);
    expect(isPositionWithinPlanBounds({ plan, position: { x: 8, y: 64, z: 8 } })).toBe(false);
    expect(() => store.assertWithinBounds({ plan, position: { x: 9, y: 64, z: 0 } })).toThrow('outside');
    expect(() =>
      store.begin({
        input: {
          summary: 'Replace the active plan',
          steps: ['Build'],
          permitted_actions: ['build'],
          duration_minutes: 1,
          radius_blocks: 8,
        },
        origin: { x: 0, y: 64, z: 0 },
      }),
    ).toThrow('already active');

    now += 60_001;
    expect(store.current()).toBeNull();
  });

  it('authorizes a bounded corridor to a known tree location', () => {
    const store = new PlanStore();
    const plan = store.begin({
      input: {
        summary: 'Harvest near the known trees',
        steps: ['Travel', 'Harvest'],
        permitted_actions: ['move', 'gather'],
        duration_minutes: 15,
        radius_blocks: 8,
      },
      origin: { x: 0, y: 64, z: 0 },
      additionalOrigins: [{ x: 40, y: 66, z: 0 }],
    });

    expect(isPositionWithinPlanBounds({ plan, position: { x: 20, y: 64, z: 8 } })).toBe(true);
    expect(isPositionWithinPlanBounds({ plan, position: { x: 40, y: 66, z: 8 } })).toBe(true);
    expect(isPositionWithinPlanBounds({ plan, position: { x: 20, y: 64, z: 9 } })).toBe(false);
    expect(isPositionWithinPlanBounds({ plan, position: { x: 49, y: 66, z: 0 } })).toBe(false);
  });
});
