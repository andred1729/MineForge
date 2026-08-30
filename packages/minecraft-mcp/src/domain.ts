import { z } from 'zod';

export const ActionSchema = z.enum(['move', 'gather', 'craft', 'build', 'hunt', 'drop']);
export type Action = z.infer<typeof ActionSchema>;

export const PositionSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int(),
});
export interface Position {
  x: number;
  y: number;
  z: number;
}

export const BlueprintPlanBindingSchema = z.object({
  blueprint_id: z.string().min(1).max(100),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  origin: PositionSchema,
});

const PlanInputSchema = z.object({
  summary: z.string().min(1).max(500),
  steps: z.array(z.string().min(1).max(300)).min(1).max(12),
  permitted_actions: z.array(ActionSchema).min(1),
  duration_minutes: z.number().int().min(1).max(15).default(15),
  radius_blocks: z.number().int().min(1).max(32).default(32),
});

export const BeginPlanInputSchema = PlanInputSchema;
export type BeginPlanInput = z.infer<typeof BeginPlanInputSchema>;

export const BeginBlueprintPlanInputSchema = PlanInputSchema.extend({
  blueprint: BlueprintPlanBindingSchema,
});
export type BeginBlueprintPlanInput = z.infer<typeof BeginBlueprintPlanInputSchema>;

export const BlueprintBlockSchema = z.object({
  dx: z.number().int().min(-32).max(32),
  dy: z.number().int().min(-16).max(16),
  dz: z.number().int().min(-32).max(32),
  block: z.string().min(1).max(64),
});
export type BlueprintBlock = z.infer<typeof BlueprintBlockSchema>;

export const BlueprintSchema = z.object({
  plan_id: z.string().min(1),
  origin: PositionSchema,
  blocks: z.array(BlueprintBlockSchema).min(1).max(128),
});
export type Blueprint = z.infer<typeof BlueprintSchema>;

export const PlanSchema = z.object({
  id: z.string().min(1),
  summary: z.string(),
  steps: z.array(z.string()),
  permittedActions: z.array(ActionSchema),
  origin: PositionSchema,
  additionalOrigins: z.array(PositionSchema).max(5).optional(),
  radiusBlocks: z.number().int().positive(),
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  blueprint: BlueprintPlanBindingSchema.optional(),
});
export type Plan = z.infer<typeof PlanSchema>;

export const PlanOutcomeSchema = z.enum(['completed', 'failed']);
export type PlanOutcome = z.infer<typeof PlanOutcomeSchema>;

export interface MinecraftChatEvent {
  type: 'minecraft_chat';
  username: string;
  message: string;
}
