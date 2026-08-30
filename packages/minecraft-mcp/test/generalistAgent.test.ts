import { describe, expect, it } from 'vitest';

import { createBotIdentity } from '../src/botRoles.js';
import { minecraftAgentInstructions } from '../src/prompt.js';
import { agentManifest } from '../src/trueforgeProvisioner.js';

describe('generalist TrueForge agent', () => {
  it('starts without a scripted task and can request every task-specific approval', () => {
    const identity = createBotIdentity(1);
    const manifest = agentManifest({ identity, modelFqn: 'openai/test-model' });

    expect(identity.role).toBe('generalist');
    expect(manifest.mcpServers?.[0]?.requireApprovalForTools).toEqual([
      'enable_creative_mode',
      'begin_plan',
      'begin_blueprint_plan',
    ]);
    expect(manifest.config?.dynamicSubAgents).toEqual({ enabled: false });
  });

  it('describes nearby trees naturally without exposing demo terminology', () => {
    const instructions = minecraftAgentInstructions(createBotIdentity(1));

    expect(instructions).toContain('There are natural trees around (-46, 66, -6)');
    expect(instructions).toContain('you will go there and cut them');
    expect(instructions).toContain('call move_to for those coordinates before calling harvest_tree');
    expect(instructions.toLowerCase()).not.toContain('worksite');
    expect(instructions.toLowerCase()).not.toContain('demo');
    expect(instructions).not.toContain('a generalist embodied');
  });
});
