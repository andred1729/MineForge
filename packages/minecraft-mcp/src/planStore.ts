import { randomUUID } from 'node:crypto';

import type { Action, BeginPlanInput, Plan, Position } from './domain.js';

export function isPositionWithinPlanBounds({ plan, position }: { plan: Plan; position: Position }): boolean {
  const distanceToSegment = (end: Position): number => {
    const segmentX = end.x - plan.origin.x;
    const segmentZ = end.z - plan.origin.z;
    const lengthSquared = segmentX * segmentX + segmentZ * segmentZ;
    if (lengthSquared === 0) {
      return Math.hypot(position.x - plan.origin.x, position.z - plan.origin.z);
    }
    const projection =
      ((position.x - plan.origin.x) * segmentX + (position.z - plan.origin.z) * segmentZ) / lengthSquared;
    const boundedProjection = Math.max(0, Math.min(1, projection));
    const closestX = plan.origin.x + boundedProjection * segmentX;
    const closestZ = plan.origin.z + boundedProjection * segmentZ;
    return Math.hypot(position.x - closestX, position.z - closestZ);
  };

  const additionalOrigins = plan.additionalOrigins ?? [];
  if (additionalOrigins.length === 0) {
    return distanceToSegment(plan.origin) <= plan.radiusBlocks;
  }
  return additionalOrigins.some(origin => distanceToSegment(origin) <= plan.radiusBlocks);
}

export class PlanStore {
  private activePlan: Plan | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  begin({
    input,
    origin,
    additionalOrigins = [],
  }: {
    input: BeginPlanInput;
    origin: Position;
    additionalOrigins?: Position[];
  }): Plan {
    if (this.current() !== null) {
      throw new Error('A plan is already active. Finish or stop it before beginning another plan.');
    }
    const createdAt = this.now();
    const plan: Plan = {
      id: randomUUID(),
      summary: input.summary,
      steps: [...input.steps],
      permittedActions: [...new Set(input.permitted_actions)],
      origin,
      additionalOrigins: additionalOrigins.map(additionalOrigin => ({ ...additionalOrigin })),
      radiusBlocks: input.radius_blocks,
      createdAt,
      expiresAt: createdAt + input.duration_minutes * 60_000,
      blueprint: input.blueprint,
    };
    this.activePlan = plan;
    return plan;
  }

  current(): Plan | null {
    const plan = this.activePlan;
    if (plan !== null && plan.expiresAt <= this.now()) {
      this.activePlan = null;
      return null;
    }
    return plan;
  }

  require({ planId, action }: { planId: string; action: Action }): Plan {
    const plan = this.current();
    if (plan === null) {
      throw new Error('No active approved plan. Call begin_plan and wait for approval first.');
    }
    if (plan.id !== planId) {
      throw new Error('The supplied plan_id is not the active approved plan.');
    }
    if (!plan.permittedActions.includes(action)) {
      throw new Error(`The approved plan does not permit the ${action} action.`);
    }
    return plan;
  }

  assertWithinBounds({ plan, position }: { plan: Plan; position: Position }): void {
    if (!isPositionWithinPlanBounds({ plan, position })) {
      throw new Error(
        `Target is outside the approved ${String(plan.radiusBlocks)}-block plan corridor and work areas.`,
      );
    }
  }

  finish(planId: string): Plan {
    const plan = this.current();
    if (plan?.id !== planId) {
      throw new Error('Cannot finish a plan that is not active.');
    }
    this.activePlan = null;
    return plan;
  }

  invalidate(): void {
    this.activePlan = null;
  }
}
