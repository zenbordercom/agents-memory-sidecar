#!/usr/bin/env bash
set -euo pipefail

source_dir=${SOURCE_DIR:-$(pwd)}
config_dir=${CONFIG_DIR:-/etc/agents-memory}
runtime_dir=${TARGET_DIR:-/opt/agents-memory-sidecar}
backup_dir=${BACKUP_DIR:-/var/backups/agents-memory}
log_dir=${LOG_DIR:-/var/log/agents-memory}
runtime_user=${RUNTIME_USER:-agents-memory}
runtime_group=${RUNTIME_GROUP:-agents-memory}
enable_units=0
restart_services=0

usage() {
  cat <<'USAGE'
Usage: sudo scripts/install-local.sh [--enable] [--restart]

Installs Agents Memory Sidecar templates for a local Linux systemd deployment.

Environment overrides:
  SOURCE_DIR    source checkout, default current directory
  TARGET_DIR    runtime directory, default /opt/agents-memory-sidecar
  CONFIG_DIR    config directory, default /etc/agents-memory
  BACKUP_DIR    backup directory, default /var/backups/agents-memory
  LOG_DIR       log directory, default /var/log/agents-memory

The script does not overwrite existing sidecar.env or http-tokens.json files.
Create real PostgreSQL roles/databases and tokens before starting the service.
USAGE
}

for arg in "$@"; do
  case "$arg" in
    --enable)
      enable_units=1
      ;;
    --restart)
      restart_services=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  echo "run with sudo so the script can create system users and install files" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node is required and was not found in PATH" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required and was not found in PATH" >&2
  exit 1
fi

if ! getent group "$runtime_group" >/dev/null; then
  groupadd --system "$runtime_group"
fi

if ! id "$runtime_user" >/dev/null 2>&1; then
  useradd --system --no-create-home --home-dir "$runtime_dir" --shell /usr/sbin/nologin --gid "$runtime_group" "$runtime_user"
fi

install -d -o root -g "$runtime_group" -m 0750 "$config_dir"
install -d -o "$runtime_user" -g "$runtime_group" -m 0750 "$backup_dir" "$log_dir"

if [[ ! -e "$config_dir/sidecar.env" ]]; then
  install -o root -g "$runtime_group" -m 0640 "$source_dir/.env.example" "$config_dir/sidecar.env"
  echo "created example config: $config_dir/sidecar.env"
else
  echo "kept existing config: $config_dir/sidecar.env"
fi

if [[ ! -e "$config_dir/http-tokens.json" ]]; then
  install -o root -g "$runtime_group" -m 0640 "$source_dir/config/http-tokens.example.json" "$config_dir/http-tokens.json"
  echo "created example token registry: $config_dir/http-tokens.json"
else
  echo "kept existing token registry: $config_dir/http-tokens.json"
fi

SOURCE_DIR="$source_dir" TARGET_DIR="$runtime_dir" RUNTIME_GROUP="$runtime_group" "$source_dir/scripts/deploy-opt-runtime.sh"
SOURCE_DIR="$source_dir" "$source_dir/scripts/install-systemd-units.sh"

if [[ "$enable_units" -eq 1 ]]; then
  systemctl enable agents-memory-sidecar.service
  systemctl enable agents-memory-backup.timer
  systemctl enable agents-memory-observation-prune.timer
  systemctl enable agents-memory-health-check.timer
fi

if [[ "$restart_services" -eq 1 ]]; then
  systemctl restart agents-memory-sidecar.service
fi

cat <<EOF
Installed Agents Memory Sidecar templates.

Next steps:
  1. Edit $config_dir/sidecar.env for PostgreSQL and HTTP settings.
  2. Replace $config_dir/http-tokens.json with real generated tokens.
  3. Run: sudo systemctl start agents-memory-sidecar.service
  4. Check: sudo systemctl status agents-memory-sidecar.service
EOF
