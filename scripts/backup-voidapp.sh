#!/usr/bin/env bash
set -euo pipefail
umask 077

usage() {
  cat <<'USAGE'
Usage:
  ./scripts/backup-voidapp.sh [--no-archive] [--allow-incomplete]

Environment:
  VOIDAPP_ENV_FILE=/path/to/VOID0000-api/.env
  VOIDAPP_BACKUP_DIR=/path/to/backup-root
  VOIDAPP_BACKUP_SKIP_POSTGRES=1
  VOIDAPP_BACKUP_SKIP_SCYLLA=1
  VOIDAPP_BACKUP_SKIP_MINIO=1
  VOIDAPP_BACKUP_SKIP_VALKEY=1
  VOIDAPP_MINIO_DATA_DIR=/path/to/minio-data

What it backs up:
  - PostgreSQL with pg_dump custom format
  - ScyllaDB tables with cqlsh COPY
  - MinIO object bytes with mc mirror plus authoritative metadata manifests
  - Valkey RDB snapshot when valkey-cli/redis-cli supports it

Notes:
  A full backup quiesces all PM2 VOID writers before the recovery point and
  resumes them only after every required store completed successfully. Use
  VOIDAPP_BACKUP_QUIESCE_COMMAND and VOIDAPP_BACKUP_RESUME_COMMAND for a
  non-PM2 deployment (for example Compose).

  This is a simple hobby-server backup helper. For huge Scylla datasets, replace
  the cqlsh COPY part with proper Scylla snapshots/backup tooling.
USAGE
}

NO_ARCHIVE=0
ALLOW_INCOMPLETE=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-archive)
      NO_ARCHIVE=1
      shift
      ;;
    --allow-incomplete)
      ALLOW_INCOMPLETE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${VOIDAPP_ENV_FILE:-$APP_ROOT/VOID0000-api/.env}"
BACKUP_ROOT="${VOIDAPP_BACKUP_DIR:-$HOME/voidapp-backups}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_NAME="voidapp-$TIMESTAMP"
BACKUP_DIR="$BACKUP_ROOT/$BACKUP_NAME"
WARNINGS_FILE="$BACKUP_DIR/WARNINGS.txt"
MANIFEST_FILE="$BACKUP_DIR/MANIFEST.txt"
COMPLETE=1
QUIESCED=0
QUIESCE_METHOD="none"
PM2_STARTED_FILE="$BACKUP_DIR/.pm2-started"
POSTGRES_STATUS="pending"
SCYLLA_STATUS="pending"
MINIO_STATUS="pending"
VALKEY_STATUS="pending"

mkdir -p "$BACKUP_DIR"
: > "$WARNINGS_FILE"

log() {
  printf '[backup] %s\n' "$*"
}

warn() {
  printf '[backup] WARN: %s\n' "$*" >&2
  printf '%s\n' "$*" >> "$WARNINGS_FILE"
}

fail() {
  printf '[backup] ERROR: %s\n' "$*" >&2
  exit 1
}

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

source_env_file() {
  if [ ! -f "$ENV_FILE" ]; then
    warn "Env file not found: $ENV_FILE. Falling back to process/default env values."
    return
  fi

  set -a
  # Strip CRLF safely so env files edited on Windows do not break bash source.
  # shellcheck disable=SC1090
  source <(sed 's/\r$//' "$ENV_FILE")
  set +a
}

write_manifest() {
  {
    echo "backup_name=$BACKUP_NAME"
    echo "backup_format=2"
    echo "backup_complete=$COMPLETE"
    echo "recovery_point_quiesced=$QUIESCED"
    echo "quiesce_method=$QUIESCE_METHOD"
    echo "created_at_utc=$TIMESTAMP"
    echo "host=$(hostname)"
    echo "app_root=$APP_ROOT"
    echo "env_file=$ENV_FILE"
    echo "git_commit=$(git -C "$APP_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
    echo "git_branch=$(git -C "$APP_ROOT" branch --show-current 2>/dev/null || echo unknown)"
    echo "postgres_database=${PGDATABASE:-unset}"
    echo "scylla_keyspace=${SCYLLA_KEYSPACE:-voidapp}"
    echo "scylla_tables=messages reaction_state reaction_schema schema_migrations"
    echo "minio_buckets=${MINIO_BUCKET:-avatars} ${MINIO_GROUP_AVATAR_BUCKET:-group-avatars} ${MINIO_ATTACH_BUCKET:-chat-attachments}"
    echo "minio_metadata_format=void-minio-object-metadata-v1"
    echo "postgres_status=$POSTGRES_STATUS"
    echo "scylla_status=$SCYLLA_STATUS"
    echo "minio_status=$MINIO_STATUS"
    echo "valkey_status=$VALKEY_STATUS"
    echo "valkey_host=${VALKEY_HOST:-127.0.0.1}"
  } > "$MANIFEST_FILE"
}

resume_writers() {
  if [ "$QUIESCED" -ne 1 ]; then return; fi
  if [ "$QUIESCE_METHOD" = "pm2" ] && [ -s "$PM2_STARTED_FILE" ]; then
    xargs -r pm2 start < "$PM2_STARTED_FILE" || printf '[backup] ERROR: failed to resume PM2 writers\n' >&2
  elif [ "$QUIESCE_METHOD" = "external" ]; then
    eval "$VOIDAPP_BACKUP_RESUME_COMMAND" || printf '[backup] ERROR: external writer resume failed\n' >&2
  fi
  QUIESCED=0
}

trap resume_writers EXIT

quiesce_writers() {
  if [ "$ALLOW_INCOMPLETE" -eq 1 ]; then
    COMPLETE=0
    return
  fi
  if [ -n "${VOIDAPP_BACKUP_QUIESCE_COMMAND:-}" ]; then
    [ -n "${VOIDAPP_BACKUP_RESUME_COMMAND:-}" ] || fail "VOIDAPP_BACKUP_RESUME_COMMAND is required with VOIDAPP_BACKUP_QUIESCE_COMMAND."
    eval "$VOIDAPP_BACKUP_QUIESCE_COMMAND"
    QUIESCED=1
    QUIESCE_METHOD="external"
    return
  fi
  have_cmd pm2 || fail "Full backup requires PM2 or explicit quiesce/resume commands."
  local names=(voidapp-api voidapp-message-service voidapp-conversation-service voidapp-social-profile-service voidapp-worker-service voidapp-gateway-phoenix voidapp-vmd-service voidapp-media-worker)
  : > "$PM2_STARTED_FILE"
  local name
  for name in "${names[@]}"; do
    if pm2 describe "$name" 2>/dev/null | grep -q 'status.*online'; then
      printf '%s\n' "$name" >> "$PM2_STARTED_FILE"
    fi
  done
  [ -s "$PM2_STARTED_FILE" ] || fail "Full backup found no running VOID PM2 writers; use explicit quiesce/resume commands for this deployment."
  xargs -r pm2 stop < "$PM2_STARTED_FILE"
  QUIESCED=1
  QUIESCE_METHOD="pm2"
}

backup_postgres() {
  if [ "${VOIDAPP_BACKUP_SKIP_POSTGRES:-0}" = "1" ]; then
    [ "$ALLOW_INCOMPLETE" -eq 1 ] || fail "PostgreSQL is required for a full backup. Use --allow-incomplete to intentionally skip it."
    COMPLETE=0; POSTGRES_STATUS="skipped"; warn "Skipping PostgreSQL backup because VOIDAPP_BACKUP_SKIP_POSTGRES=1."
    return
  fi

  if ! have_cmd pg_dump; then
    fail "pg_dump not found. PostgreSQL is required for a full backup."
  fi

  local out_dir="$BACKUP_DIR/postgres"
  mkdir -p "$out_dir"

  local host="${PGHOST:-127.0.0.1}"
  local port="${PGPORT:-5432}"
  local user="${PGUSER:-postgres}"
  local database="${PGDATABASE:-void-app}"
  local password="${PGPASSWORD:-}"

  log "Backing up PostgreSQL database $database..."
  PGPASSWORD="$password" pg_dump \
    -h "$host" \
    -p "$port" \
    -U "$user" \
    -d "$database" \
    -Fc \
    -f "$out_dir/$database.dump"

  PGPASSWORD="$password" pg_dump \
    -h "$host" \
    -p "$port" \
    -U "$user" \
    -d "$database" \
    --schema-only \
    -f "$out_dir/schema.sql"

  if have_cmd pg_dumpall; then
    PGPASSWORD="$password" pg_dumpall \
      -h "$host" \
      -p "$port" \
      -U "$user" \
      --globals-only \
      -f "$out_dir/globals.sql" || fail "pg_dumpall --globals-only failed."
  fi
  POSTGRES_STATUS="complete"
}

backup_scylla() {
  if [ "${VOIDAPP_BACKUP_SKIP_SCYLLA:-0}" = "1" ]; then
    [ "$ALLOW_INCOMPLETE" -eq 1 ] || fail "Scylla is required for a full backup. Use --allow-incomplete to intentionally skip it."
    COMPLETE=0; SCYLLA_STATUS="skipped"; warn "Skipping Scylla backup because VOIDAPP_BACKUP_SKIP_SCYLLA=1."
    return
  fi

  if ! have_cmd cqlsh; then
    fail "cqlsh not found. Scylla is required for a full backup."
  fi

  local out_dir="$BACKUP_DIR/scylla"
  mkdir -p "$out_dir"

  local host="${SCYLLA_HOST:-127.0.0.1}"
  host="${host%%,*}"
  local port="${SCYLLA_PORT:-9042}"
  local keyspace="${SCYLLA_KEYSPACE:-voidapp}"
  local tables=(
    messages
    reaction_state
    reaction_schema
    schema_migrations
  )

  log "Backing up Scylla keyspace $keyspace with cqlsh COPY..."
  cqlsh "$host" "$port" -e "DESCRIBE KEYSPACE $keyspace;" > "$out_dir/schema.cql" || fail "Could not export Scylla schema for $keyspace."

  local table
  for table in "${tables[@]}"; do
    local csv="$out_dir/$table.csv"
    log "Exporting Scylla table $keyspace.$table..."
    cqlsh "$host" "$port" -e "COPY $keyspace.$table TO '$csv' WITH HEADER = TRUE;" || fail "Scylla export failed for $keyspace.$table."
  done
  SCYLLA_STATUS="complete"
}

backup_minio() {
  if [ "${VOIDAPP_BACKUP_SKIP_MINIO:-0}" = "1" ]; then
    [ "$ALLOW_INCOMPLETE" -eq 1 ] || fail "MinIO is required for a full backup. Use --allow-incomplete to intentionally skip it."
    COMPLETE=0; MINIO_STATUS="skipped"; warn "Skipping MinIO backup because VOIDAPP_BACKUP_SKIP_MINIO=1."
    return
  fi

  local out_dir="$BACKUP_DIR/minio"
  mkdir -p "$out_dir"

  local bucket_avatar="${MINIO_BUCKET:-avatars}"
  local bucket_group="${MINIO_GROUP_AVATAR_BUCKET:-group-avatars}"
  local bucket_attach="${MINIO_ATTACH_BUCKET:-chat-attachments}"

  if have_cmd mc; then
    local scheme="http"
    if [ "${MINIO_USE_SSL:-false}" = "true" ]; then scheme="https"; fi
    local endpoint="${scheme}://${MINIO_ENDPOINT:-127.0.0.1}:${MINIO_PORT:-9000}"
    local access_key="${MINIO_ACCESS_KEY:-minioadmin}"
    local secret_key="${MINIO_SECRET_KEY:-minioadmin}"
    local alias_name="voidapp-backup-$TIMESTAMP"

    log "Backing up MinIO buckets and object metadata..."
    mc alias set "$alias_name" "$endpoint" "$access_key" "$secret_key" >/dev/null

    local bucket
    for bucket in "$bucket_avatar" "$bucket_group" "$bucket_attach"; do
      log "Mirroring MinIO bucket $bucket..."
      mc mirror --overwrite "$alias_name/$bucket" "$out_dir/$bucket" || fail "MinIO mirror failed for bucket $bucket."
      (cd "$APP_ROOT/VOID0000-api" && node --import tsx scripts/backup/minioObjectMetadata.ts capture "$bucket" "$out_dir/$bucket" "$out_dir/metadata/$bucket.json") || fail "MinIO metadata capture failed for bucket $bucket."
    done

    mc alias remove "$alias_name" >/dev/null 2>&1 || true
    MINIO_STATUS="complete"
    return
  fi

  fail "mc command not found. MinIO backup must preserve object metadata."
}

valkey_cli() {
  if have_cmd valkey-cli; then
    printf 'valkey-cli'
    return
  fi

  if have_cmd redis-cli; then
    printf 'redis-cli'
    return
  fi
}

backup_valkey() {
  if [ "${VOIDAPP_BACKUP_SKIP_VALKEY:-0}" = "1" ]; then
    VALKEY_STATUS="skipped"
    warn "Skipping Valkey backup because VOIDAPP_BACKUP_SKIP_VALKEY=1."
    return
  fi

  local cli
  cli="$(valkey_cli || true)"
  if [ -z "$cli" ]; then
    VALKEY_STATUS="unavailable"
    warn "valkey-cli/redis-cli not found. Valkey backup skipped."
    return
  fi

  local out_dir="$BACKUP_DIR/valkey"
  mkdir -p "$out_dir"

  local host="${VALKEY_HOST:-127.0.0.1}"
  local port="${VALKEY_PORT:-6379}"

  log "Capturing Valkey metadata..."
  "$cli" -h "$host" -p "$port" INFO > "$out_dir/info.txt" || warn "Could not capture Valkey INFO."
  "$cli" -h "$host" -p "$port" CONFIG GET '*' > "$out_dir/config.txt" || warn "Could not capture Valkey CONFIG."

  if "$cli" --help 2>&1 | grep -q -- '--rdb'; then
    log "Requesting Valkey RDB stream backup..."
    "$cli" -h "$host" -p "$port" --rdb "$out_dir/dump.rdb" || warn "Valkey --rdb backup failed."
  else
    warn "$cli does not advertise --rdb support. Valkey data file was not copied."
  fi
  VALKEY_STATUS="best-effort"
}

create_archive() {
  if [ "$NO_ARCHIVE" -eq 1 ]; then
    log "Skipping archive because --no-archive was provided."
    return
  fi

  local archive="$BACKUP_ROOT/$BACKUP_NAME.tar.gz"
  log "Creating archive $archive..."
  tar -C "$BACKUP_ROOT" -czf "$archive" "$BACKUP_NAME"
  sha256sum "$archive" > "$archive.sha256"
}

source_env_file

: "${PGHOST:=127.0.0.1}"
: "${PGPORT:=5432}"
: "${PGUSER:=postgres}"
: "${PGDATABASE:=void-app}"
: "${SCYLLA_HOST:=127.0.0.1}"
: "${SCYLLA_PORT:=9042}"
: "${SCYLLA_KEYSPACE:=voidapp}"
: "${MINIO_ENDPOINT:=127.0.0.1}"
: "${MINIO_PORT:=9000}"
: "${VALKEY_HOST:=127.0.0.1}"
: "${VALKEY_PORT:=6379}"

quiesce_writers
write_manifest
backup_postgres
backup_scylla
backup_minio
backup_valkey
write_manifest
create_archive

log "Backup directory: $BACKUP_DIR"
if [ "$NO_ARCHIVE" -eq 0 ]; then
  log "Backup archive:   $BACKUP_ROOT/$BACKUP_NAME.tar.gz"
fi

if [ "$COMPLETE" -ne 1 ]; then
  log "INCOMPLETE backup created; it is not valid for full disaster recovery."
elif [ -s "$WARNINGS_FILE" ]; then
  log "Backup completed with warnings. Read: $WARNINGS_FILE"
else
  rm -f "$WARNINGS_FILE"
  log "Backup completed without warnings."
fi
