#!/usr/bin/env bash
set -euo pipefail

container_name='minecraft-agent-server'
volume_name='minecraft-agent-world'

container_exists() {
  docker container inspect "$container_name" >/dev/null 2>&1
}

start_server() {
  if container_exists; then
    docker start "$container_name" >/dev/null
  else
    docker run -d \
      --name "$container_name" \
      --restart unless-stopped \
      -p 127.0.0.1:25565:25565 \
      -e EULA=TRUE \
      -e TYPE=PAPER \
      -e VERSION=1.21.4 \
      -e ONLINE_MODE=FALSE \
      -e MODE=SURVIVAL \
      -e DIFFICULTY=PEACEFUL \
      -e SPAWN_PROTECTION=0 \
      -e MEMORY=2G \
      -v "$volume_name:/data" \
      itzg/minecraft-server:latest >/dev/null
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
