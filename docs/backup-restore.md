# Backup And Restore

The backup scripts assume PostgreSQL and a local GPG passphrase file.

## Backup

```bash
AGENT_MEMORY_CONFIG_FILE=/etc/agents-memory/sidecar.env \
AGENT_MEMORY_BACKUP_PASSPHRASE_FILE=/etc/agents-memory/backup.passphrase \
AGENT_MEMORY_BACKUP_DIR=/var/backups/agents-memory \
scripts/backup-postgres.sh
```

## Restore Rehearsal

```bash
AGENT_MEMORY_CONFIG_FILE=/etc/agents-memory/sidecar.env \
AGENT_MEMORY_BACKUP_PASSPHRASE_FILE=/etc/agents-memory/backup.passphrase \
AGENT_MEMORY_BACKUP_DIR=/var/backups/agents-memory \
scripts/restore-rehearsal.sh
```

The rehearsal creates a temporary restore database, restores the latest encrypted dump, prints key table counts, and drops the restore database unless `KEEP_RESTORE_DB=1`.
