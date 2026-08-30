# Minecraft `/spawn` Paper plugin

This server-only Paper plugin turns `/spawn X` into a request for a neutral worker. `X` is a player-facing label, not a specialization; the first TrueForge console prompt determines the worker's task. No client mod is required.

## Spawn control contract

The plugin sends an authenticated `POST` to `MINECRAFT_SPAWN_URL` (default `http://host.docker.internal:8793/spawn`) with header:

```text
X-Minecraft-Agent-Token: <MINECRAFT_SPAWN_TOKEN>
```

The body uses `application/x-www-form-urlencoded` and contains:

```text
requester_uuid
requester_name
world_uuid
world_name
x
y
z
yaw
pitch
```

The host bot manager is authoritative for capacity and identity allocation. It must reserve the lowest available name from `ForgeBot1` through `ForgeBot5`, create that bot's TrueForge connector, agent, and session, wait for the bot to join, and then return:

- `201 text/plain` with `ForgeBotN:generalist` on success.
- `409` when five bots are already active.
- Another non-2xx status when creation fails; it must release any reservation and disconnect partial bot state.

The plugin performs the HTTP call off the Paper main thread. After success it returns to the main thread, finds safe natural ground near the request coordinates, teleports the bot, grants a neutral starting kit, and applies the classic skin through SkinsRestorer. It then calls `/spawn/ready`; this confirms placement without creating a TrueForge turn, so every new session remains empty until the user writes the first prompt.

Only one placement can be in flight at a time. If the bot cannot join, the world or natural ground is unavailable, or Paper rejects the teleport, the plugin sends an authenticated form POST to `/spawn/rollback` with `username=ForgeBotN`. The manager disconnects that latest bot, removes its durable workforce record, and makes the slot available again.

## Local configuration

- `MINECRAFT_SPAWN_TOKEN` is required, must contain at least 32 characters, and must match the host bot manager. `pnpm minecraft:demo` generates an ephemeral value when one is not configured.
- `MINECRAFT_SPAWN_URL` can override the host endpoint.
- `MINECRAFT_BOT_SKIN` selects the cached SkinsRestorer skin name and defaults to `Steve`.

The server image builds and tests the plugin with Java 21 in Docker, so the host does not need Maven or a compatible JDK.
