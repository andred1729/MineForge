# Minecraft MCP bridge

This private workspace package connects a Mineflayer bot to TrueForge through MCP. TrueForge owns the model loop, session, tool approval, streaming, and cancellation; this package implements bounded Minecraft observations and actions.

## Quick start

Requirements: Node 22+, pnpm 11, Docker, and an OpenAI API key. This project uses `OPEN_AI_KEY` in the gitignored workspace `.env` (and accepts `OPENAI_API_KEY` as a compatibility fallback), then persists the credential in TrueForge's redacted provider store.

```bash
export OPEN_AI_KEY=your-key
export MINECRAFT_MODEL_FQN=openai/gpt-5-4-mini
pnpm minecraft:demo
```

The command starts or reuses `minecraft-agent-server`, launches TrueForge and the Minecraft workforce manager, and installs the server-side `/spawn` command. Open:

- TrueForge console: `http://localhost:3000`
- Browser spectator: `http://127.0.0.1:3007`
- Java Edition 1.21.4 multiplayer: `localhost:25565`

The Minecraft server is deliberately in offline mode and bound to localhost. Do not publish port 25565. In Minecraft, choose a role explicitly with `/spawn lumber-jack`, `/spawn miner`, `/spawn builder`, `/spawn hunter`, or `/spawn scout`. Each role maps to one stable ForgeBot and its own TrueForge agent and session. Bot prompts belong in the TrueForge console, while the bots mirror progress into Minecraft chat.

`pnpm minecraft:server:reset` permanently removes only the `minecraft-agent-server` container and `minecraft-agent-world` Docker volume before recreating them on natural terrain. The separate `minecraft-agent-skins` volume is retained so the classic Steve skin remains cached.

If running components separately:

```bash
pnpm minecraft:server:up
pnpm standalone:dev
pnpm minecraft:bridge
```

The workforce manager provisions a connector, agent, and durable session when each `/spawn` succeeds. The server builds the small Paper command plugin in Docker, installs a pinned SkinsRestorer release, and keeps host ports bound to localhost. No client mod is required.

## Demo

Run a role-scoped `/spawn` command in Minecraft, then select its role-labelled session in TrueForge. The first durable turn records the starting kit: the Lumberjack gets a stone axe and reports nearby trees before asking for wood type and quantity; the Hunter gets an iron sword and shield, lists the nearest eligible animals, and asks what to hunt. Assign the actual task in that console session. The agent calls `begin_plan`; TrueForge pauses before that tool executes. Approve once, then watch the bot act without repeated approvals. Use the console stop control to cancel movement and invalidate the plan.

The Hunter connector exposes `locate_entities`, `locate_animals`, and `hunt_animals`. It can find and pursue unnamed adult cows, pigs, sheep, and chickens inside approved bounds. Sword attacks are rejected when another living entity is within sweep range. Players, babies, named or attached animals, hostile combat, explosives, arbitrary server commands, sandboxes, and subagents remain excluded.
