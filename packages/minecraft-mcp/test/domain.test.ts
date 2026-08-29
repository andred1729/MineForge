import { describe, expect, it } from 'vitest';

import { BeginPlanInputSchema } from '../src/domain.js';

describe('Minecraft plan input', () => {
  it('keeps imported and ordinary plans within the same 15-minute authorization window', () => {
    const ordinary = {
      summary: 'Build for too long',
      steps: ['Build'],
      permitted_actions: ['build'],
      duration_minutes: 30,
      radius_blocks: 8,
    };
    expect(BeginPlanInputSchema.safeParse(ordinary).success).toBe(false);
    expect(
      BeginPlanInputSchema.safeParse({
        ...ordinary,
        blueprint: {
          blueprint_id: 'test-villa',
          digest: 'a'.repeat(64),
          origin: { x: 0, y: 100, z: 0 },
        },
      }).success,
    ).toBe(false);
  });
});
