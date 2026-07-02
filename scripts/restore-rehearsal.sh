#!/usr/bin/env bash
set -euo pipefail

CONFIG_FILE="${AGENT_MEMORY_CONFIG_FILE:-/etc/agents-memory/sidecar.env}"
PASSPHRASE_FILE="${AGENT_MEMORY_BACKUP_PASSPHRASE_FILE:-/etc/agents-memory/backup.passphrase}"
BACKUP_DIR="${AGENT_MEMORY_BACKUP_DIR:-/var/backups/agents-memory}"
RESTORE_DB="${AGENT_MEMORY_RESTORE_DB:-agent_memory_restore_test}"
GNUPGHOME="${AGENT_MEMORY_GNUPGHOME:-/tmp/agents-memory-gnupg-$(id -u)}"

if [[ ! -r "$CONFIG_FILE" ]]; then
  echo "Config file is not readable: $CONFIG_FILE" >&2
  exit 1
fi

if [[ ! -r "$PASSPHRASE_FILE" ]]; then
  echo "Backup passphrase file is not readable: $PASSPHRASE_FILE" >&2
  exit 1
fi

set -a
# shellcheck source=/dev/null
. "$CONFIG_FILE"
set +a

mkdir -p "$GNUPGHOME"
chmod 0700 "$GNUPGHOME"
export GNUPGHOME

database="${PGDATABASE:-agent_memory}"
backup_file="${1:-}"

if [[ -z "$backup_file" ]]; then
  backup_file="$(find "$BACKUP_DIR" -type f -name "${database}-*.dump.gpg" | sort | tail -n 1)"
fi

if [[ -z "$backup_file" || ! -r "$backup_file" ]]; then
  echo "No readable backup file found" >&2
  exit 1
fi

sudo -u postgres dropdb --if-exists "$RESTORE_DB"
sudo -u postgres createdb -O ubuntu "$RESTORE_DB"

gpg \
  --batch \
  --quiet \
  --decrypt \
  --pinentry-mode loopback \
  --passphrase-file "$PASSPHRASE_FILE" \
  "$backup_file" |
  sudo -u postgres pg_restore \
    --no-owner \
    --no-privileges \
    --dbname "$RESTORE_DB"

sudo -u postgres psql -d "$RESTORE_DB" -v ON_ERROR_STOP=1 <<'SQL'
SELECT 'memory_items' AS table_name, count(*) FROM memory_items
UNION ALL SELECT 'project_contexts', count(*) FROM project_contexts
UNION ALL SELECT 'audit_events', count(*) FROM audit_events;
SQL

if [[ "${KEEP_RESTORE_DB:-0}" != "1" ]]; then
  sudo -u postgres dropdb "$RESTORE_DB"
fi

echo "restore rehearsal ok: $backup_file"
