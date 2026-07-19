#!/usr/bin/env bash
set -euo pipefail

compose_project=${COMPOSE_PROJECT_NAME:-agents-memory-smoke-$RANDOM-$RANDOM}
compose_dir=.local/agents-memory-compose
keep=0

if [[ ${1:-} == "--keep" ]]; then
  keep=1
elif [[ $# -gt 0 ]]; then
  echo "Usage: scripts/compose-smoke.sh [--keep]" >&2
  exit 2
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required for the Compose smoke test" >&2
  exit 1
fi

COMPOSE_PROJECT_NAME="$compose_project" node scripts/bootstrap-compose.mjs "$compose_dir"

cleanup() {
  if [[ $keep -eq 0 ]]; then
    COMPOSE_PROJECT_NAME="$compose_project" docker compose down --volumes --remove-orphans
  fi
}
trap cleanup EXIT

COMPOSE_PROJECT_NAME="$compose_project" docker compose up --build --detach --wait

token=$(node -e "const fs=require('fs');const r=JSON.parse(fs.readFileSync('$compose_dir/http-tokens.json','utf8'));const e=Object.entries(r).find(([,a])=>a.agentId==='compose-local-cli'&&a.runtime==='compose');if(!e) throw new Error('compose token missing');process.stdout.write(e[0])")
write=$(curl --fail-with-body --silent --show-error \
  --header "Authorization: Bearer $token" \
  --header 'content-type: application/json' \
  --data '{"tenant":"default","project":"compose-smoke","namespace":"ops","kind":"note","title":"Compose persistence","body":"Compose smoke validates durable PostgreSQL memory.","source_type":"manual"}' \
  http://127.0.0.1:18790/v1/memory)
memory_id=$(node -e "const value=JSON.parse(process.argv[1]);if(!value.accepted) throw new Error('write was not accepted');process.stdout.write(value.id)" "$write")

COMPOSE_PROJECT_NAME="$compose_project" docker compose restart sidecar
COMPOSE_PROJECT_NAME="$compose_project" docker compose up --detach --wait sidecar

search=$(curl --fail-with-body --silent --show-error \
  --header "Authorization: Bearer $token" \
  --header 'content-type: application/json' \
  --data '{"tenant":"default","project":"compose-smoke","query":"Compose persistence","limit":5}' \
  http://127.0.0.1:18790/v1/memory/search)
node -e "const value=JSON.parse(process.argv[1]);if(!value.items.some((item)=>item.id===process.argv[2])) throw new Error('memory did not persist after restart')" "$search" "$memory_id"
echo "compose smoke ok (project=$compose_project)"
