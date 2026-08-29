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

The Minecraft server is deliberately in offline mode and bound to localhost. Do not publish port 25565. In Minecraft, run `/spawn lumber-jack`, `/spawn hunter`, or another supported role; plain `/spawn` selects the next default role. The argument is sent only to the backend and is not advertised in command help or chat. It chooses the ForgeBot's demo specialty and starting kit, while every TrueForge session retains the complete tool catalog and can accept any supported task. Minecraft chat only redirects the player to TrueForge; all agent conversation and progress stays in the console.

`pnpm minecraft:server:reset` permanently removes only the `minecraft-agent-server` container and `minecraft-agent-world` Docker volume before recreating them on natural terrain. The separate `minecraft-agent-skins` volume is retained so the classic Steve skin remains cached.

If running components separately:

```bash
pnpm minecraft:server:up
pnpm standalone:dev
pnpm minecraft:bridge
```

The workforce manager provisions a connector, agent, and durable session when each `/spawn` succeeds. The server builds the small Paper command plugin in Docker, installs a pinned SkinsRestorer release, and keeps host ports bound to localhost. No client mod is required.

## Demo

Run `/spawn <role>` in Minecraft, then select the new role-labelled session in TrueForge. The first durable turn records the backend-recognized starting kit. Assign any supported task in that console session; roles guide the demo introduction but do not restrict tools. The agent calls `begin_plan`; TrueForge pauses before that tool executes. Approve once, then watch the bot act without repeated approvals. Use the console stop control to cancel movement and invalidate the plan.

Every bot connector exposes tree, entity, gathering, crafting, building, and bounded hunting tools. Bots can find and pursue unnamed adult cows, pigs, sheep, and chickens inside approved bounds. Sword attacks are rejected when another living entity is within sweep range. Players, babies, named or attached animals, hostile combat, explosives, arbitrary server commands, sandboxes, and subagents remain excluded.
