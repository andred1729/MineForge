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
  minecraftUsername: z.string().min(1).max(16).default('ForgeBot'),
  minecraftAuth: z.literal('offline').default('offline'),
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
    minecraftUsername: env['MC_USERNAME'],
    minecraftAuth: env['MC_AUTH'],
    minecraftVersion: env['MC_VERSION'],
    mcpHost: env['MCP_HOST'],
    mcpPort: env['MCP_PORT'],
    viewerPort: env['MC_VIEWER_PORT'],
    trueforgeBaseUrl: env['TRUEFORGE_BASE_URL'],
    trueforgeToken: env['TRUEFORGE_TOKEN'],
    stateDirectory: env['MINECRAFT_STATE_DIRECTORY'],
  });
}

export const BootstrapConfigSchema = z.object({
  ...MinecraftConfigSchema.shape,
  modelFqn: z.string().min(1),
  openaiApiKey: z.string().min(1).optional(),
  agentName: z.string().min(1).default('minecraft-agent'),
  connectorName: z.string().min(1).default('minecraft'),
});

export type BootstrapConfig = z.infer<typeof BootstrapConfigSchema>;

export function loadBootstrapConfig(env: NodeJS.ProcessEnv = process.env): BootstrapConfig {
  loadWorkspaceEnv(env);
  return BootstrapConfigSchema.parse({
    ...loadMinecraftConfig(env),
    modelFqn: env['MINECRAFT_MODEL_FQN'],
    openaiApiKey: env['OPEN_AI_KEY'] ?? env['OPENAI_API_KEY'],
    agentName: env['MINECRAFT_AGENT_NAME'],
    connectorName: env['MINECRAFT_CONNECTOR_NAME'],
  });
}
