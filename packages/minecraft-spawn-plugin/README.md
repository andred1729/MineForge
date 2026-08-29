# Minecraft `/spawn` Paper plugin

This server-only Paper plugin turns the literal `/spawn` command into a request for the local Minecraft bot manager. No client mod is required.

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

- `201 text/plain` with exactly `ForgeBotN` on success.
- `409` when five bots are already active.
- Another non-2xx status when creation fails; it must release any reservation and disconnect partial bot state.

The plugin performs the HTTP call off the Paper main thread. After success it returns to the main thread, finds safe natural ground near the request coordinates, teleports the bot, grants its role-specific demo kit, and applies the classic skin through SkinsRestorer.

## Local configuration

- `MINECRAFT_SPAWN_TOKEN` must match the host bot manager. The demo-only fallback is `minecraft-agent-local-demo`.
- `MINECRAFT_SPAWN_URL` can override the host endpoint.
- `MINECRAFT_BOT_SKIN` selects the cached SkinsRestorer skin name and defaults to `Steve`.

The server image builds and tests the plugin with Java 21 in Docker, so the host does not need Maven or a compatible JDK.
