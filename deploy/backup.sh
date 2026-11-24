#!/bin/sh
# Backup diário do PostgreSQL (roda dentro do container "backup").
# Guarda os últimos BACKUP_KEEP_DAYS dias em /backups (pasta ./backups no servidor).
set -eu
KEEP="${BACKUP_KEEP_DAYS:-14}"
while true; do
  FILE="/backups/rotafacil-$(date +%Y-%m-%d_%H%M).dump"
  # com DATABASE_URL (Supabase) usa a URL; sem ela, o banco "db" do docker-compose.yml
  if [ -n "${DATABASE_URL:-}" ]; then
    set -- -d "$DATABASE_URL" --schema=public --no-owner --no-privileges
  else
    set -- -h db -U rotafacil -d rotafacil
  fi
  if pg_dump "$@" -Fc -f "$FILE.tmp"; then
    mv "$FILE.tmp" "$FILE"
    echo "[backup] ok: $FILE ($(du -h "$FILE" | cut -f1))"
  else
    rm -f "$FILE.tmp"
    echo "[backup] FALHOU" >&2
  fi
  find /backups -name 'rotafacil-*.dump' -mtime +"$KEEP" -delete
  sleep 86400
done
