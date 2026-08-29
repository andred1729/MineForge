import { describe, expect, it } from 'vitest';

import { loadBootstrapConfig, loadMinecraftConfig } from '../src/config.js';

describe('Minecraft configuration', () => {
  it('uses safe local defaults', () => {
    const config = loadMinecraftConfig({});
    expect(config).toMatchObject({
      minecraftHost: '127.0.0.1',
      minecraftPort: 25_565,
      minecraftUsername: 'ForgeBot',
      minecraftAuth: 'offline',
      minecraftVersion: '1.21.4',
      mcpHost: '127.0.0.1',
      mcpPort: 8_792,
      viewerPort: 3_007,
      trueforgeBaseUrl: 'http://127.0.0.1:8790',
    });
  });

  it('accepts the existing OPEN_AI_KEY spelling for local bootstrap', () => {
    const config = loadBootstrapConfig({
      MINECRAFT_MODEL_FQN: 'openai/gpt-5-4-mini',
      OPEN_AI_KEY: 'test-key',
    });
    expect(config.modelFqn).toBe('openai/gpt-5-4-mini');
    expect(config.openaiApiKey).toBe('test-key');
  });

  it('prefers the standard OPENAI_API_KEY spelling', () => {
    const config = loadBootstrapConfig({
      MINECRAFT_MODEL_FQN: 'openai/gpt-5-4-mini',
      OPENAI_API_KEY: 'standard-key',
      OPEN_AI_KEY: 'legacy-key',
    });
    expect(config.openaiApiKey).toBe('standard-key');
  });
});
