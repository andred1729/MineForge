import { TrueForge, type TrueForgeApi } from '@truefoundry/trueforge-sdk';

import { loadBootstrapConfig } from './config.js';
import { MINECRAFT_AGENT_INSTRUCTIONS } from './prompt.js';
import { loadBootstrapState, saveBootstrapState } from './state.js';

async function ensureModelProvider({
  client,
  config,
}: {
  client: TrueForge;
  config: ReturnType<typeof loadBootstrapConfig>;
}): Promise<void> {
  const separator = config.modelFqn.indexOf('/');
  const providerName = separator === -1 ? config.modelFqn : config.modelFqn.slice(0, separator);
  const configured = await client.settings.modelProviders.list();
  const existing = configured.data.find(provider => provider.name === providerName);

  if (providerName !== 'openai') {
    if (existing === undefined) {
      throw new Error(
        `Model provider ${providerName} is not configured. Add it in the TrueForge console before bootstrapping.`,
      );
    }
    return;
  }

  if (config.openaiApiKey === undefined) {
    if (existing === undefined) {
      throw new Error(
        'OpenAI is not configured. Set OPENAI_API_KEY in the workspace .env or add OpenAI in the TrueForge console.',
      );
    }
    return;
  }

  const catalog = await client.catalogs.modelProviders.list();
  const openai = catalog.data.find(provider => provider.type === 'openai');
  if (openai?.type !== 'openai') {
    throw new Error('The TrueForge model catalog does not contain an OpenAI provider preset.');
  }
  await client.settings.modelProviders.createOrUpdate({
    manifest: {
      type: 'openai',
      auth: { apiKey: config.openaiApiKey },
      models: openai.models,
    },
  });
}

function agentManifest(config: ReturnType<typeof loadBootstrapConfig>): TrueForgeApi.AgentSpec {
  return {
    model: { name: config.modelFqn },
    instructions: MINECRAFT_AGENT_INSTRUCTIONS,
    mcpServers: [
      {
        name: config.connectorName,
        preload: true,
        enableTools: ['@all'],
        requireApprovalForTools: ['begin_plan'],
      },
    ],
    config: {
      askUserQuestions: { enabled: true },
      dynamicSubAgents: { enabled: false },
      generativeUi: { enabled: false },
      iterationLimit: 100,
      sandbox: { enabled: false },
    },
  };
}

async function upsertAgent({
  client,
  config,
}: {
  client: TrueForge;
  config: ReturnType<typeof loadBootstrapConfig>;
}): Promise<TrueForgeApi.Agent> {
  const manifest = agentManifest(config);
  const agents = await client.agents.list();
  const existing = agents.data.find(agent => agent.name === config.agentName);
  if (existing === undefined) {
    const created = await client.agents.create({ name: config.agentName, manifest });
    return created.data;
  }
  const updated = await client.agents.update(existing.id, { manifest });
  return updated.data;
}

async function resolveSession({
  client,
  config,
  agent,
}: {
  client: TrueForge;
  config: ReturnType<typeof loadBootstrapConfig>;
  agent: TrueForgeApi.Agent;
}): Promise<TrueForgeApi.Session> {
  const state = await loadBootstrapState(config.stateDirectory);
  if (state !== null && state.agentId === agent.id) {
    try {
      const existing = await client.sessions.get(state.sessionId);
      return existing.data;
    } catch (caught) {
      console.warn('Stored TrueForge session is unavailable; creating a replacement.', caught);
    }
  }
  const created = await client.sessions.create({ agent: { name: config.agentName } });
  return created.data;
}

export async function bootstrap(): Promise<void> {
  const config = loadBootstrapConfig();
  const client = new TrueForge({
    baseUrl: config.trueforgeBaseUrl,
    ...(config.trueforgeToken === undefined ? {} : { token: config.trueforgeToken }),
  });
  await ensureModelProvider({ client, config });
  await client.settings.mcpServers.createOrUpdate({
    manifest: {
      name: config.connectorName,
      description: 'Local Mineflayer control plane for the Minecraft agent demo.',
      type: 'remote',
      url: `http://${config.mcpHost}:${String(config.mcpPort)}/mcp`,
    },
  });
  const agent = await upsertAgent({ client, config });
  const session = await resolveSession({ client, config, agent });
  await saveBootstrapState({
    directory: config.stateDirectory,
    state: { agentId: agent.id, connectorName: config.connectorName, sessionId: session.id },
  });

  console.log(`Minecraft connector: ${config.connectorName}`);
  console.log(`TrueForge agent: ${agent.name} (${agent.id})`);
  console.log(`Console: ${config.trueforgeBaseUrl.replace(/\/$/, '')}/sessions/${session.id}`);
}

void bootstrap().catch((caught: unknown) => {
  console.error('Minecraft TrueForge bootstrap failed', caught);
  process.exitCode = 1;
});
