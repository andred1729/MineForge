#!/usr/bin/env bash
set -euo pipefail

container_name='minecraft-agent-server'
volume_name='minecraft-agent-world'
skins_volume_name='minecraft-agent-skins'
server_image='minecraft-agent-paper:local'
script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
workspace_directory="$(cd "$script_directory/.." && pwd)"
spawn_url="${MINECRAFT_SPAWN_URL:-http://host.docker.internal:8793/spawn}"
spawn_token="${MINECRAFT_SPAWN_TOKEN:-minecraft-agent-local-demo}"
bot_skin="${MINECRAFT_BOT_SKIN:-Steve}"

build_server_image() {
  docker build \
    --file "$workspace_directory/packages/minecraft-spawn-plugin/Dockerfile" \
    --tag "$server_image" \
    "$workspace_directory"
}

prepare_skins_volume() {
  docker volume create "$skins_volume_name" >/dev/null
  docker run --rm \
    --entrypoint /bin/sh \
    -v "$skins_volume_name:/skins" \
    "$server_image" \
    -c 'chown -R 1000:1000 /skins'
}

container_exists() {
  docker container inspect "$container_name" >/dev/null 2>&1
}

container_has_environment() {
  docker container inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_name" | \
    grep --fixed-strings --line-regexp --quiet "$1"
}

start_server() {
  build_server_image
  prepare_skins_volume
  if container_exists; then
    container_image_id="$(docker container inspect --format '{{.Image}}' "$container_name")"
    desired_image_id="$(docker image inspect --format '{{.Id}}' "$server_image")"
    if [[ "$container_image_id" != "$desired_image_id" ]] || \
      ! container_has_environment "MINECRAFT_SPAWN_URL=$spawn_url" || \
      ! container_has_environment "MINECRAFT_SPAWN_TOKEN=$spawn_token" || \
      ! container_has_environment "MINECRAFT_BOT_SKIN=$bot_skin"; then
      docker rm -f "$container_name" >/dev/null
    fi
  fi
  if container_exists; then
    docker start "$container_name" >/dev/null
  else
    docker run -d \
      --name "$container_name" \
      --restart unless-stopped \
      --add-host host.docker.internal:host-gateway \
      -p 127.0.0.1:25565:25565 \
      -e EULA=TRUE \
      -e TYPE=PAPER \
      -e VERSION=1.21.4 \
      -e ONLINE_MODE=FALSE \
      -e MODE=SURVIVAL \
      -e DIFFICULTY=PEACEFUL \
      -e SPAWN_PROTECTION=0 \
      -e MEMORY=2G \
      -e MODRINTH_PROJECTS=skinsrestorer:wXS6bHiC \
      -e MINECRAFT_SPAWN_URL="$spawn_url" \
      -e MINECRAFT_SPAWN_TOKEN="$spawn_token" \
      -e MINECRAFT_BOT_SKIN="$bot_skin" \
      -v "$volume_name:/data" \
      -v "$skins_volume_name:/data/plugins/SkinsRestorer" \
      "$server_image" >/dev/null
  fi
  echo "Waiting for Minecraft at 127.0.0.1:25565"
  for _ in $(seq 1 180); do
    if docker exec "$container_name" rcon-cli list >/dev/null 2>&1; then
      docker exec "$container_name" rcon-cli difficulty peaceful >/dev/null
      echo 'Minecraft server is ready (survival, peaceful).'
      return
    fi
    sleep 1
  done
  echo 'Minecraft did not become ready within 180 seconds.' >&2
  docker logs --tail 80 "$container_name" >&2
  exit 1
}

case "${1:-}" in
  up)
    start_server
    ;;
  down)
    if container_exists; then
      docker stop "$container_name"
    fi
    ;;
  reset)
    if container_exists; then
      docker rm -f "$container_name"
    fi
    if docker volume inspect "$volume_name" >/dev/null 2>&1; then
      docker volume rm "$volume_name"
    fi
    rm -f "$workspace_directory/packages/minecraft-mcp/.data/minecraft-workforce.json"
    start_server
    ;;
  status)
    if container_exists; then
      docker container inspect --format '{{.State.Status}}' "$container_name"
    else
      echo 'not-created'
    fi
    ;;
  *)
    echo 'Usage: minecraft-server.sh {up|down|reset|status}' >&2
    exit 2
    ;;
esac
