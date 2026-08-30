#!/usr/bin/env bash
set -euo pipefail

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

if [[ -z "${MINECRAFT_MODEL_FQN:-}" ]]; then
  echo 'Set MINECRAFT_MODEL_FQN to a model configured in TrueForge (for example openai/gpt-5-4-mini).' >&2
  exit 2
fi

# Generate an ephemeral credential shared only by the local Paper plugin and host manager.
export MINECRAFT_SPAWN_TOKEN="${MINECRAFT_SPAWN_TOKEN:-$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")}"

pnpm minecraft:server:up
pnpm --filter @truefoundry/trueforge-sdk build

trueforge_pid=''
bridge_pid=''
cleanup() {
  if [[ -n "$bridge_pid" ]]; then kill "$bridge_pid" 2>/dev/null || true; fi
  if [[ -n "$trueforge_pid" ]]; then kill "$trueforge_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

pnpm standalone:dev &
trueforge_pid=$!
pnpm --dir packages/minecraft-mcp exec tsx watch src/main.ts &
bridge_pid=$!

for _ in $(seq 1 120); do
  if curl --fail --silent http://127.0.0.1:8790/healthz >/dev/null && \
    curl --fail --silent http://127.0.0.1:8792/healthz >/dev/null && \
    curl --fail --silent http://127.0.0.1:8793/healthz >/dev/null && \
    curl --fail --silent http://localhost:3000/ >/dev/null; then
    break
  fi
  sleep 1
done

curl --fail --silent http://127.0.0.1:8790/healthz >/dev/null
curl --fail --silent http://127.0.0.1:8792/healthz >/dev/null
curl --fail --silent http://127.0.0.1:8793/healthz >/dev/null
curl --fail --silent http://localhost:3000/ >/dev/null

echo 'TrueForge console: http://localhost:3000'
echo 'Minecraft spectator: http://127.0.0.1:3007'
echo 'Java client: localhost:25565'
echo 'In Minecraft: run /spawn builder, then paste a GrabCraft blueprint URL in chat.'
while kill -0 "$trueforge_pid" 2>/dev/null && kill -0 "$bridge_pid" 2>/dev/null; do
  sleep 1
done
echo 'A demo process exited unexpectedly; shutting down the remaining local processes.' >&2
exit 1
