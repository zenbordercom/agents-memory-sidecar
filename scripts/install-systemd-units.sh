#!/usr/bin/env bash
set -euo pipefail

source_dir=${SOURCE_DIR:-$(pwd)}
unit_dir=${UNIT_DIR:-/etc/systemd/system}
enable_units=0

for arg in "$@"; do
  case "$arg" in
    --enable)
      enable_units=1
      ;;
    *)
      echo "unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  echo "run with sudo so the script can install systemd units" >&2
  exit 1
fi

install -d -o root -g root -m 0755 "$unit_dir"
install -d -o agents-memory -g agents-memory -m 0750 /var/log/agents-memory

units=(
  agents-memory-sidecar.service
  agents-memory-backup.service
  agents-memory-backup.timer
  agents-memory-observation-prune.service
  agents-memory-observation-prune.timer
  agents-memory-health-check.service
  agents-memory-health-check.timer
  agents-memory-health-check-failure.service
)

for unit in "${units[@]}"; do
  install -o root -g root -m 0644 "$source_dir/systemd/$unit" "$unit_dir/$unit"
done

systemctl daemon-reload

if [[ "$enable_units" -eq 1 ]]; then
  systemctl enable agents-memory-sidecar.service
  systemctl enable --now agents-memory-backup.timer
  systemctl enable --now agents-memory-observation-prune.timer
  systemctl enable --now agents-memory-health-check.timer
fi

echo "installed ${#units[@]} systemd units from $source_dir/systemd to $unit_dir"
