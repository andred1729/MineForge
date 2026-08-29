import { MinecraftActionQueue } from './actionQueue.js';
import { loadMinecraftConfig } from './config.js';
import { MinecraftEventController } from './controller.js';
import { createMinecraftMcpServer, startMinecraftMcpHttpServer } from './mcpServer.js';
import { MineflayerBot } from './mineflayerBot.js';
import { PlanStore } from './planStore.js';
import { loadBootstrapState } from './state.js';
import { TrueForgeSessionClient } from './trueforgePort.js';

async function waitForBootstrapState(directory: string, signal: AbortSignal) {
  while (!signal.aborted) {
    const state = await loadBootstrapState(directory);
    if (state !== null) {
      return state;
    }
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  throw new Error('Minecraft bridge stopped before TrueForge bootstrap completed.');
}

export async function main(): Promise<void> {
  const config = loadMinecraftConfig();
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
  const bot = new MineflayerBot({
    host: config.minecraftHost,
    port: config.minecraftPort,
    username: config.minecraftUsername,
    version: config.minecraftVersion,
  });
  const planStore = new PlanStore();
  const actionQueue = new MinecraftActionQueue();

  let controller: MinecraftEventController | null = null;
  const mcpHttpServer = startMinecraftMcpHttpServer({
    host: config.mcpHost,
    port: config.mcpPort,
    createServerForRequest: () =>
      createMinecraftMcpServer({
        bot,
        planStore,
        actionQueue,
      }),
  });

  try {
    await bot.start();
    bot.startViewer(config.viewerPort);
    await mcpHttpServer.listen();

    console.log(
      `ForgeBot joined ${config.minecraftHost}:${String(config.minecraftPort)} as ${config.minecraftUsername}`,
    );
    console.log(`Minecraft MCP: http://${config.mcpHost}:${String(config.mcpPort)}/mcp`);
    console.log(`Browser spectator: http://127.0.0.1:${String(config.viewerPort)}`);
    console.log('Waiting for an idempotent `pnpm minecraft:bootstrap` if no session state exists.');

    const state = await waitForBootstrapState(config.stateDirectory, shutdownController.signal);
    const trueforge = new TrueForgeSessionClient({
      baseUrl: config.trueforgeBaseUrl,
      ...(config.trueforgeToken === undefined ? {} : { token: config.trueforgeToken }),
      sessionId: state.sessionId,
    });
    controller = new MinecraftEventController(bot, trueforge, 1_000, () => {
      planStore.invalidate();
    });
    await controller.start();
    console.log(`Minecraft chat is attached to TrueForge session ${state.sessionId}`);
    await shutdownPromise;
  } finally {
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
    await controller?.close();
    await mcpHttpServer.close();
    planStore.invalidate();
    bot.stop();
    await bot.close();
  }
}

void main().catch((caught: unknown) => {
  console.error('Minecraft bridge failed', caught);
  process.exitCode = 1;
});
