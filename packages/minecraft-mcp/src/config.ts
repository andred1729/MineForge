import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

const WORKSPACE_ENV_FILE = fileURLToPath(new URL('../../../.env', import.meta.url));

function loadWorkspaceEnv(env: NodeJS.ProcessEnv): void {
  if (env !== process.env) {
    return;
  }
  try {
    loadEnvFile(WORKSPACE_ENV_FILE);
  } catch (caught) {
    if (caught instanceof Error && 'code' in caught && caught.code === 'ENOENT') {
      return;
    }
    throw new Error(`Could not load the workspace environment file at ${WORKSPACE_ENV_FILE}.`, { cause: caught });
  }
}

const PortSchema = z.coerce.number().int().min(1).max(65_535);

export const MinecraftConfigSchema = z.object({
  minecraftHost: z.string().min(1).default('127.0.0.1'),
  minecraftPort: PortSchema.default(25_565),
  minecraftVersion: z.string().min(1).default('1.21.4'),
  mcpHost: z.string().min(1).default('127.0.0.1'),
  mcpPort: PortSchema.default(8_792),
  viewerPort: PortSchema.default(3_007),
  trueforgeBaseUrl: z.url().default('http://127.0.0.1:8790'),
  trueforgeToken: z.string().min(1).optional(),
  stateDirectory: z.string().min(1).default('.data'),
});

export type MinecraftConfig = z.infer<typeof MinecraftConfigSchema>;

export function loadMinecraftConfig(env: NodeJS.ProcessEnv = process.env): MinecraftConfig {
  loadWorkspaceEnv(env);
  return MinecraftConfigSchema.parse({
    minecraftHost: env['MC_HOST'],
    minecraftPort: env['MC_PORT'],
    minecraftVersion: env['MC_VERSION'],
    mcpHost: env['MCP_HOST'],
    mcpPort: env['MCP_PORT'],
    viewerPort: env['MC_VIEWER_PORT'],
    trueforgeBaseUrl: env['TRUEFORGE_BASE_URL'],
    trueforgeToken: env['TRUEFORGE_TOKEN'],
    stateDirectory: env['MINECRAFT_STATE_DIRECTORY'],
  });
}

export const WorkforceConfigSchema = z.object({
  ...MinecraftConfigSchema.shape,
  modelFqn: z.string().min(1),
  openaiApiKey: z.string().min(1).optional(),
  maxBots: z.coerce.number().int().min(1).max(5).default(5),
  spawnHost: z.string().min(1).default('0.0.0.0'),
  spawnPort: PortSchema.default(8_793),
  spawnToken: z.string().min(16).default('minecraft-agent-local-demo'),
  mcpPublicBaseUrl: z.url().default('http://127.0.0.1:8792'),
});
export type WorkforceConfig = z.infer<typeof WorkforceConfigSchema>;

export function loadWorkforceConfig(env: NodeJS.ProcessEnv = process.env): WorkforceConfig {
  loadWorkspaceEnv(env);
  return WorkforceConfigSchema.parse({
    ...loadMinecraftConfig(env),
    modelFqn: env['MINECRAFT_MODEL_FQN'],
    openaiApiKey: env['OPEN_AI_KEY'] ?? env['OPENAI_API_KEY'],
    maxBots: env['MINECRAFT_MAX_BOTS'],
    spawnHost: env['MINECRAFT_SPAWN_HOST'],
    spawnPort: env['MINECRAFT_SPAWN_PORT'],
    spawnToken: env['MINECRAFT_SPAWN_TOKEN'],
    mcpPublicBaseUrl: env['MINECRAFT_MCP_PUBLIC_BASE_URL'],
  });
}
