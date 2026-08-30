import { TrueForge, type TrueForgeApi } from '@truefoundry/trueforge-sdk';

import type { BotIdentity } from './botRoles.js';
import { minecraftAgentInstructions } from './prompt.js';
import type { WorkforceBotRecord } from './workforceState.js';

export interface ProvisionedBotResources {
  agentId: string;
  sessionId: string;
}

export interface TrueForgeProvisionerPort {
  ensureProvider(): Promise<void>;
  provisionBot(options: {
    identity: BotIdentity;
    existingRecord?: WorkforceBotRecord;
  }): Promise<ProvisionedBotResources>;
}

export interface TrueForgeProvisionerOptions {
  baseUrl: string;
  token?: string;
  modelFqn: string;
  openaiApiKey?: string;
  mcpPublicBaseUrl: string;
}

function providerNameFromModel(modelFqn: string): string {
  const separator = modelFqn.indexOf('/');
  return separator === -1 ? modelFqn : modelFqn.slice(0, separator);
}

export function agentManifest({
  identity,
  modelFqn,
}: {
  identity: BotIdentity;
  modelFqn: string;
}): TrueForgeApi.AgentSpec {
  const canBuildComplexBlueprints = identity.role === 'builder' || identity.role === 'generalist';
  return {
    model: { name: modelFqn },
    instructions: minecraftAgentInstructions(identity),
    mcpServers: [
      {
        name: identity.connectorName,
        preload: true,
        enableTools: ['@all'],
        requireApprovalForTools: canBuildComplexBlueprints
          ? ['enable_creative_mode', 'spawn_build_helpers', 'begin_plan']
          : ['begin_plan'],
      },
    ],
    config: {
      askUserQuestions: { enabled: true },
      dynamicSubAgents: { enabled: canBuildComplexBlueprints },
      generativeUi: { enabled: false },
      iterationLimit: 100,
      sandbox: { enabled: false },
    },
  };
}

export class TrueForgeProvisioner implements TrueForgeProvisionerPort {
  private readonly client: TrueForge;
  private providerSetup: Promise<void> | null = null;

  constructor(private readonly options: TrueForgeProvisionerOptions) {
    this.client = new TrueForge({
      baseUrl: options.baseUrl,
      ...(options.token === undefined ? {} : { token: options.token }),
    });
  }

  ensureProvider(): Promise<void> {
    this.providerSetup ??= this.configureProvider();
    return this.providerSetup;
  }

  async provisionBot({
    identity,
    existingRecord,
  }: {
    identity: BotIdentity;
    existingRecord?: WorkforceBotRecord;
  }): Promise<ProvisionedBotResources> {
    await this.ensureProvider();
    await this.client.settings.mcpServers.createOrUpdate({
      manifest: {
        name: identity.connectorName,
        description: `Bot-scoped Minecraft controls for ${identity.username}.`,
        type: 'remote',
        url: `${this.options.mcpPublicBaseUrl.replace(/\/$/, '')}/bots/${identity.slug}/mcp`,
      },
    });

    const manifest = agentManifest({ identity, modelFqn: this.options.modelFqn });
    const agents = await this.client.agents.list();
    const existingAgent = agents.data.find(agent => agent.name === identity.agentName);
    const agent =
      existingAgent === undefined
        ? (await this.client.agents.create({ name: identity.agentName, manifest })).data
        : (await this.client.agents.update(existingAgent.id, { manifest })).data;

    if (existingRecord?.agentId === agent.id) {
      try {
        const existingSession = await this.client.sessions.get(existingRecord.sessionId);
        return { agentId: agent.id, sessionId: existingSession.data.id };
      } catch (caught) {
        console.warn(`Stored session for ${identity.username} is unavailable; creating a replacement.`, caught);
      }
    }

    const session = await this.client.sessions.create({ agent: { name: identity.agentName } });
    return { agentId: agent.id, sessionId: session.data.id };
  }

  private async configureProvider(): Promise<void> {
    const providerName = providerNameFromModel(this.options.modelFqn);
    const configured = await this.client.settings.modelProviders.list();
    const existing = configured.data.find(provider => provider.name === providerName);

    if (providerName !== 'openai') {
      if (existing === undefined) {
        throw new Error(
          `Model provider ${providerName} is not configured. Add it in the TrueForge console before spawning bots.`,
        );
      }
      return;
    }

    if (this.options.openaiApiKey === undefined) {
      if (existing === undefined) {
        throw new Error(
          'OpenAI is not configured. Set OPEN_AI_KEY in the workspace .env or add OpenAI in the TrueForge console.',
        );
      }
      return;
    }

    const catalog = await this.client.catalogs.modelProviders.list();
    const openai = catalog.data.find(provider => provider.type === 'openai');
    if (openai?.type !== 'openai') {
      throw new Error('The TrueForge model catalog does not contain an OpenAI provider preset.');
    }
    await this.client.settings.modelProviders.createOrUpdate({
      manifest: {
        type: 'openai',
        auth: { apiKey: this.options.openaiApiKey },
        models: openai.models,
      },
    });
  }
}
