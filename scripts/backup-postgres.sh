#!/usr/bin/env bash
set -euo pipefail

CONFIG_FILE="${AGENT_MEMORY_CONFIG_FILE:-/etc/agents-memory/sidecar.env}"
PASSPHRASE_FILE="${AGENT_MEMORY_BACKUP_PASSPHRASE_FILE:-/etc/agents-memory/backup.passphrase}"
BACKUP_DIR="${AGENT_MEMORY_BACKUP_DIR:-/var/backups/agents-memory}"
RETENTION_DAYS="${AGENT_MEMORY_BACKUP_RETENTION_DAYS:-14}"
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

mkdir -p "$BACKUP_DIR"
chmod 0750 "$BACKUP_DIR" 2>/dev/null || true
mkdir -p "$GNUPGHOME"
chmod 0700 "$GNUPGHOME"
export GNUPGHOME

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
database="${PGDATABASE:-agent_memory}"
output="${BACKUP_DIR}/${database}-${timestamp}.dump.gpg"

pg_dump \
  --format=custom \
  --no-owner \
  --no-privileges \
  "$database" |
  gpg \
    --batch \
    --yes \
    --symmetric \
    --cipher-algo AES256 \
    --pinentry-mode loopback \
    --passphrase-file "$PASSPHRASE_FILE" \
    --output "$output"

chmod 0640 "$output"

find "$BACKUP_DIR" -type f -name "${database}-*.dump.gpg" -mtime "+${RETENTION_DAYS}" -delete

sha256sum "$output" > "${output}.sha256"
chmod 0640 "${output}.sha256"

echo "$output"
