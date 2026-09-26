#!/usr/bin/env bash
#
# pg-backup.sh — logical backup of a PostgreSQL database (custom format).
#
# Usage:
#   PG_URL='postgresql://user:pass@host:5432/dbname' ./pg-backup.sh
#
# Environment:
#   PG_URL      (required) PostgreSQL connection URL of the database to back up.
#   BACKUP_DIR  (optional) Directory for dump files. Default: ./backups
#
# Output:
#   $BACKUP_DIR/pg-<dbname>-<UTC timestamp>.dump
#
# The dump is verified with `pg_restore --list` (fails if the table of
# contents is empty) and its SHA-256 is printed for the cutover log.
#
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: PG_URL='postgresql://user:pass@host:5432/dbname' ./pg-backup.sh

Environment:
  PG_URL      (required) PostgreSQL connection URL of the database to back up.
  BACKUP_DIR  (optional) Directory for dump files. Default: ./backups

Example:
  PG_URL='postgresql://neryva_app:secret@127.0.0.1:5432/neryva' \
    BACKUP_DIR=/var/backups/neryva ./pg-backup.sh
EOF
}

for cmd in pg_dump pg_restore sha256sum; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "error: required command '$cmd' not found on PATH" >&2
    exit 1
  fi
done

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

: "${PG_URL:?error: PG_URL is required (e.g. postgresql://user:pass@host:5432/neryva)}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"

# Extract the database name from the URL for the filename (strip query string).
DB_NAME="$(printf '%s' "$PG_URL" | sed -E 's#.*/([^/?]+)(\?.*)?$#\1#')"
if [[ -z "$DB_NAME" ]]; then
  echo "error: could not parse a database name out of PG_URL" >&2
  exit 1
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"
DUMP_FILE="${BACKUP_DIR}/pg-${DB_NAME}-${STAMP}.dump"

echo "==> pg_dump of database '${DB_NAME}' -> ${DUMP_FILE}"
pg_dump --format=custom --no-owner --file="$DUMP_FILE" "$PG_URL"

if [[ ! -s "$DUMP_FILE" ]]; then
  echo "error: dump file is empty: ${DUMP_FILE}" >&2
  exit 1
fi

# Verify: the table of contents must be non-empty.
TOC_LINES="$(pg_restore --list "$DUMP_FILE" | grep -c . || true)"
if [[ "$TOC_LINES" -eq 0 ]]; then
  echo "error: pg_restore --list returned an empty table of contents for ${DUMP_FILE}" >&2
  echo "       refusing to treat this as a valid backup" >&2
  exit 1
fi

SHA="$(sha256sum "$DUMP_FILE" | awk '{print $1}')"
SIZE="$(du -h "$DUMP_FILE" | cut -f1)"

echo "==> backup verified: ${TOC_LINES} TOC entries, size ${SIZE}"
echo "==> sha256: ${SHA}"
echo "==> file:   ${DUMP_FILE}"
