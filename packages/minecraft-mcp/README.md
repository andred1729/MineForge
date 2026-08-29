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

The Minecraft server is deliberately in offline mode and bound to localhost. Do not publish port 25565. In Minecraft, run `/spawn builder` to create a Builder with its own durable TrueForge agent and session. Player chat is serialized into that Builder session, so a player can paste a supported GrabCraft URL directly in Minecraft. The bot mirrors progress and final answers back into Minecraft chat.

`pnpm minecraft:server:reset` permanently removes only the `minecraft-agent-server` container and `minecraft-agent-world` Docker volume before recreating them on natural terrain. The separate `minecraft-agent-skins` volume is retained so the classic Steve skin remains cached.

If running components separately:

```bash
pnpm minecraft:server:up
pnpm standalone:dev
pnpm minecraft:bridge
```

The workforce manager provisions a connector, agent, and durable session when each `/spawn` succeeds. The server builds the small Paper command plugin in Docker, installs a pinned SkinsRestorer release, and keeps host ports bound to localhost. No client mod is required.

## Demo

Run `/spawn builder` in Minecraft, then paste a GrabCraft blueprint URL in normal chat. The Builder imports and inspects it through MCP. TrueForge pauses separately for visible creative mode, visible `sub_agentX` helper bodies, and the exact digest-bound build plan. The Builder then creates native TrueForge child threads and assigns their next deterministic batches to those bodies. Use the console stop control to cancel movement and invalidate the plan.

The first slice intentionally excludes combat, explosives, arbitrary server commands, and sandboxes.

## Small Modern Villa demo

The complex-build demo imports GrabCraft's [Small Modern Villa](https://www.grabcraft.com/minecraft/small-modern-villa/modern-houses) into the local, gitignored `.data/blueprints` directory:

```sh
pnpm minecraft:blueprint:import 'https://www.grabcraft.com/minecraft/small-modern-villa/modern-houses'
pnpm minecraft:blueprint:fixture
```

The importer discovers and validates the page's machine-readable render data. It never evaluates remote JavaScript. The normalized artifact records its source, author, dimensions, supported material bill, skipped materials, and an immutable digest.

The demo imports orientation-independent terrain, structure, glazing, and hedge blocks. A support compiler removes any mapped voxel that cannot be placed against the prepared ground or an earlier operation. It also skips decorative landscaping and blocks that need exact facing, half, fluid, or multiblock placement. The exact supported and skipped counts are visible through `inspect_blueprint` before approval.

The prepared site has inclusive outer corners `(2,64,0)` and `(34,64,32)`. The 32×32 villa uses corner origin `(2,64,0)` and leaves the final row and column as a one-block visual border. Ground landscaping is supplied by the flat site rather than rebuilt. Creative mode is never granted by the fixture: the bounded `enable_creative_mode` MCP tool runs only after its TrueForge approval. The world and human players remain in survival, and every villa block is still placed and verified through Mineflayer.

TrueForge approves an immutable binding containing the blueprint id, digest, and origin once. The agent then calls `execute_blueprint_batch` from batch zero through completion. Repeating a partially completed batch is safe because the bridge checks the live block at every target.

No extracted GrabCraft blueprint is committed to this repository. Re-run the import command when preparing a new local demo environment.
