#!/usr/bin/env bash
set -euo pipefail

source_dir=${SOURCE_DIR:-$(pwd)}
target_dir=${TARGET_DIR:-/opt/agents-memory-sidecar}
runtime_group=${RUNTIME_GROUP:-agents-memory}
restart_services=0

for arg in "$@"; do
  case "$arg" in
    --restart)
      restart_services=1
      ;;
    *)
      echo "unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  echo "run with sudo so the script can write $target_dir and update service permissions" >&2
  exit 1
fi

source_owner=$(stat -c %U "$source_dir")
runuser -u "$source_owner" -- bash -lc "cd '$source_dir' && npm run typecheck && npm run build"

install -d -o root -g "$runtime_group" -m 0750 "$target_dir"

rsync -a --delete \
  --exclude .git \
  --exclude data \
  "$source_dir/" "$target_dir/"

chown -R root:"$runtime_group" "$target_dir"
find "$target_dir" -type d -exec chmod 0755 {} +
find "$target_dir" -type f -exec chmod 0644 {} +
find "$target_dir/scripts" -type f \( -name "*.sh" -o -name "*.mjs" \) -exec chmod 0755 {} +

if [[ "$restart_services" -eq 1 ]]; then
  systemctl daemon-reload
  systemctl restart agents-memory-sidecar.service
fi

echo "deployed $source_dir to $target_dir"
