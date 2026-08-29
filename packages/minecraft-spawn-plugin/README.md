# Minecraft `/spawn` Paper plugin

This server-only Paper plugin turns `/spawn <role>` into a request for the local Minecraft bot manager. Supported commands are `/spawn lumber-jack`, `/spawn miner`, `/spawn builder`, `/spawn hunter`, and `/spawn scout`. No client mod is required.

## Spawn control contract

The plugin sends an authenticated `POST` to `MINECRAFT_SPAWN_URL` (default `http://host.docker.internal:8793/spawn`) with header:

```text
X-Minecraft-Agent-Token: <MINECRAFT_SPAWN_TOKEN>
```

The body uses `application/x-www-form-urlencoded` and contains:

```text
role
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

The host bot manager is authoritative for identity allocation. Each role has a stable identity: Lumberjack is `ForgeBot1`, Miner is `ForgeBot2`, Builder is `ForgeBot3`, Hunter is `ForgeBot4`, and Scout is `ForgeBot5`. The manager creates that bot's TrueForge connector, agent, and session, waits for the bot to join, and then returns:

- `201 text/plain` with exactly `ForgeBotN` on success.
- `409` when the selected role is already active or workforce capacity is reached.
- Another non-2xx status when creation fails; it must release any reservation and disconnect partial bot state.

The plugin performs the HTTP call off the Paper main thread. After success it returns to the main thread, finds safe natural ground near the request coordinates, teleports the bot, grants its role-specific demo kit, and applies the classic skin through SkinsRestorer.

Only one placement can be in flight at a time. If the bot cannot join, the world or natural ground is unavailable, or Paper rejects the teleport, the plugin sends an authenticated form POST to `/spawn/rollback` with `username=ForgeBotN`. The manager disconnects that latest bot, removes its durable workforce record, and makes the role available again. After Paper grants the role-specific kit, it posts `/spawn/ready`; the manager then creates the role-labelled first TrueForge turn.

## Local configuration

- `MINECRAFT_SPAWN_TOKEN` must match the host bot manager. The demo-only fallback is `minecraft-agent-local-demo`.
- `MINECRAFT_SPAWN_URL` can override the host endpoint.
- `MINECRAFT_BOT_SKIN` selects the cached SkinsRestorer skin name and defaults to `Steve`.

The server image builds and tests the plugin with Java 21 in Docker, so the host does not need Maven or a compatible JDK.
