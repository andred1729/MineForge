# Minecraft MCP bridge

This private workspace package connects a Mineflayer bot to TrueForge through MCP. TrueForge owns the model loop, session, tool approval, streaming, and cancellation; this package implements bounded Minecraft observations and actions.

## Quick start

Requirements: Node 22+, pnpm 11, Docker, and an OpenAI API key. Put the key under `OPEN_AI_KEY` in the gitignored workspace `.env`; bootstrap persists it in TrueForge's redacted provider store. `OPENAI_API_KEY` remains accepted as a compatibility fallback.

```bash
OPEN_AI_KEY=your-key
MINECRAFT_MODEL_FQN=openai/gpt-5-4-mini
pnpm minecraft:demo
```

The command starts or reuses `minecraft-agent-server`, launches TrueForge and ForgeBot, creates the connector/agent/session, and prepares a deterministic build area. Open:

- TrueForge console: `http://localhost:3000`
- Browser spectator: `http://127.0.0.1:3007`
- Java Edition 1.21.4 multiplayer: `localhost:25565`

The Minecraft server is deliberately in offline mode and bound to localhost. Do not publish port 25565. `pnpm minecraft:server:reset` permanently removes only the `minecraft-agent-server` container and `minecraft-agent-world` Docker volume before recreating them.

If running components separately:

```bash
pnpm minecraft:server:up
pnpm standalone:dev
pnpm minecraft:bridge
pnpm minecraft:bootstrap
pnpm minecraft:fixture
```

Start the bridge before bootstrap so TrueForge can inspect the MCP connector. The bridge waits for the bootstrap state file and then attaches Minecraft chat to the dedicated session. The fixture command requires ForgeBot to be online.

## Demo

Write `build a small oak shelter` either in the TrueForge session or Minecraft chat. The agent inspects the world and calls `begin_plan`; TrueForge pauses before that tool executes. Approve once in the console, then watch gathering, crafting, and blueprint execution without additional approvals. Use the console stop control or ask the bot to stop to cancel movement and invalidate the plan.

The first slice intentionally excludes combat, explosives, arbitrary server commands, sandboxes, and subagents.
