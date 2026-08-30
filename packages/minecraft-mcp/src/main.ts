import { knownTaskLocationsForRole, VILLA_BUILD_ORIGIN } from './botRoles.js';
import { loadWorkforceConfig } from './config.js';
import { BlueprintCatalog } from './grabcraftBlueprint.js';
import { createMinecraftMcpServer, startMinecraftMcpHttpServer } from './mcpServer.js';
import { DockerMinecraftAdmin } from './minecraftAdmin.js';
import { MineflayerBot } from './mineflayerBot.js';
import { SessionMirrorController } from './sessionMirrorController.js';
import { startSpawnServer } from './spawnServer.js';
import { waitForTrueForge } from './trueforgeHealth.js';
import { TrueForgeSessionClient } from './trueforgePort.js';
import { TrueForgeProvisioner } from './trueforgeProvisioner.js';
import { WorkforceManager } from './workforceManager.js';

function botSlugFromMcpPath(path: string): string | null {
  const match = /^\/bots\/(forgebot[1-5])\/mcp$/.exec(path);
  return match?.[1] ?? null;
}

export async function main(): Promise<void> {
  const config = loadWorkforceConfig();
  const shutdownController = new AbortController();
  let resolveShutdown: (() => void) | undefined;
  const shutdownPromise = new Promise<void>(resolve => {
    resolveShutdown = resolve;
  });
  const shutdown = () => {
    shutdownController.abort();
    resolveShutdown?.();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  const blueprintCatalog = new BlueprintCatalog(config.stateDirectory);
  const minecraftAdmin = new DockerMinecraftAdmin();

  const provisioner = new TrueForgeProvisioner({
    baseUrl: config.trueforgeBaseUrl,
    ...(config.trueforgeToken === undefined ? {} : { token: config.trueforgeToken }),
    modelFqn: config.modelFqn,
    ...(config.openaiApiKey === undefined ? {} : { openaiApiKey: config.openaiApiKey }),
    mcpPublicBaseUrl: config.mcpPublicBaseUrl,
  });
  const workforce = new WorkforceManager({
    stateDirectory: config.stateDirectory,
    consoleBaseUrl: config.trueforgeBaseUrl,
    maxBots: config.maxBots,
    viewerBasePort: config.viewerPort,
    provisioner,
    createBot: identity =>
      new MineflayerBot({
        host: config.minecraftHost,
        port: config.minecraftPort,
        username: identity.username,
        version: config.minecraftVersion,
      }),
    createSessionClient: record =>
      new TrueForgeSessionClient({
        baseUrl: config.trueforgeBaseUrl,
        ...(config.trueforgeToken === undefined ? {} : { token: config.trueforgeToken }),
        sessionId: record.sessionId,
      }),
    createController: ({ bot, session, onTurnCancelled, acceptMinecraftChat }) =>
      new SessionMirrorController(bot, session, onTurnCancelled, 1_000, acceptMinecraftChat),
  });
  const mcpHttpServer = startMinecraftMcpHttpServer({
    host: config.mcpHost,
    port: config.mcpPort,
    resolveServerForRequest: path => {
      const slug = botSlugFromMcpPath(path);
      if (slug === null) {
        return null;
      }
      const context = workforce.resolveBySlug(slug);
      return context === null
        ? null
        : () =>
            createMinecraftMcpServer({
              bot: context.bot,
              planStore: context.planStore,
              actionQueue: context.actionQueue,
              role: context.record.role,
              blueprintCatalog,
              additionalPlanOrigins: knownTaskLocationsForRole(context.record.role),
              ...(context.record.role === 'builder' || context.record.role === 'generalist'
                ? {
                    recommendedBlueprintOrigin: { ...VILLA_BUILD_ORIGIN },
                    enableCreativeMode: async () => {
                      await minecraftAdmin.setCreativeMode(context.record.username);
                    },
                  }
                : {}),
            });
    },
  });
  const spawnServer = startSpawnServer({
    host: config.spawnHost,
    port: config.spawnPort,
    token: config.spawnToken,
    spawn: async () => await workforce.spawn(),
    rollback: async username => await workforce.rollback(username),
    ready: async username => await workforce.ready(username),
  });

  try {
    await mcpHttpServer.listen();
    console.log(`Bot-scoped Minecraft MCP: ${config.mcpPublicBaseUrl.replace(/\/$/, '')}/bots/{bot}/mcp`);
    await waitForTrueForge({ baseUrl: config.trueforgeBaseUrl, signal: shutdownController.signal });
    await workforce.start();
    await spawnServer.listen();
    console.log(`Minecraft /spawn ingress: http://${config.spawnHost}:${String(config.spawnPort)}/spawn`);
    console.log(`TrueForge console: ${config.trueforgeBaseUrl.replace(/\/$/, '')}`);
    await shutdownPromise;
  } finally {
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
    await spawnServer.close();
    await workforce.close();
    await mcpHttpServer.close();
  }
}

void main().catch((caught: unknown) => {
  console.error('Minecraft workforce failed', caught);
  process.exitCode = 1;
});
