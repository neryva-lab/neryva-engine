#!/usr/bin/env bash
#
# mongo-backup.sh — logical backup of a MongoDB database via mongodump.
#
# Usage:
#   MONGO_URL='mongodb://user:pass@host:27017/dbname?replicaSet=rs0' ./mongo-backup.sh
#
# Environment:
#   MONGO_URL   (required) MongoDB connection URI. MONGODB_URI is accepted as
#               a fallback (the engine's canonical env name).
#   BACKUP_DIR  (optional) Directory for dump dirs. Default: ./backups
#
# Output:
#   $BACKUP_DIR/mongo-<dbname>-<UTC timestamp>/   (mongodump output)
#   $BACKUP_DIR/mongo-<dbname>-<UTC timestamp>.manifest.json
#
# Verification: every .bson file must be non-empty, and a manifest of
# collection -> document count is written (via mongosh when available,
# otherwise by counting BSON documents with bsondump).
#
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: MONGO_URL='mongodb://user:pass@host:27017/dbname?replicaSet=rs0' ./mongo-backup.sh

Environment:
  MONGO_URL   (required) MongoDB connection URI. Falls back to MONGODB_URI.
  BACKUP_DIR  (optional) Directory for dump dirs. Default: ./backups

Example:
  MONGO_URL='mongodb://127.0.0.1:27017/neryva?replicaSet=rs0' \
    BACKUP_DIR=/var/backups/neryva ./mongo-backup.sh
EOF
}

for cmd in mongodump; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "error: required command '$cmd' not found on PATH" >&2
    exit 1
  fi
done

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

MONGO_URL="${MONGO_URL:-${MONGODB_URI:-}}"
if [[ -z "$MONGO_URL" ]]; then
  echo "error: MONGO_URL (or MONGODB_URI) is required" >&2
  echo "       e.g. mongodb://user:pass@host:27017/neryva?replicaSet=rs0" >&2
  exit 1
fi
BACKUP_DIR="${BACKUP_DIR:-./backups}"

# Extract the database name from the URI path (strip query string).
DB_NAME="$(printf '%s' "$MONGO_URL" | sed -E 's#^[^/]+//[^/]+/([^?]+)(\?.*)?$#\1#')"
if [[ -z "$DB_NAME" || "$DB_NAME" == "$MONGO_URL" ]]; then
  echo "error: could not parse a database name out of the MongoDB URI" >&2
  echo "       the URI must include a database path, e.g. mongodb://host:27017/neryva" >&2
  exit 1
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"
DUMP_DIR="${BACKUP_DIR}/mongo-${DB_NAME}-${STAMP}"
MANIFEST="${DUMP_DIR}.manifest.json"

echo "==> mongodump of database '${DB_NAME}' -> ${DUMP_DIR}"
mongodump --uri="$MONGO_URL" --out="$DUMP_DIR"

# Verify: at least one .bson file, all non-empty.
mapfile -t BSON_FILES < <(find "$DUMP_DIR" -name '*.bson' | sort)
if [[ "${#BSON_FILES[@]}" -eq 0 ]]; then
  echo "error: mongodump produced no .bson files under ${DUMP_DIR}" >&2
  exit 1
fi
for f in "${BSON_FILES[@]}"; do
  if [[ ! -s "$f" ]]; then
    echo "error: empty .bson file in dump: $f" >&2
    echo "       refusing to treat this as a valid backup" >&2
    exit 1
  fi
done
echo "==> verified ${#BSON_FILES[@]} .bson files, all non-empty"

# Manifest: collection -> document count.
echo "==> writing manifest ${MANIFEST}"
{
  echo "{"
  echo "  \"database\": \"${DB_NAME}\","
  echo "  \"taken_at_utc\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
  echo "  \"collections\": {"
  first=1
  for f in "${BSON_FILES[@]}"; do
    coll="$(basename "$f" .bson)"
    if command -v mongosh >/dev/null 2>&1; then
      count="$(mongosh --quiet "$MONGO_URL" --eval "db.getCollection('${coll}').countDocuments({})" 2>/dev/null | tr -d '[:space:]')"
    else
      # Fallback: count BSON documents in the dump file itself.
      count="$(bsondump --quiet "$f" 2>/dev/null | grep -c '^{' || true)"
    fi
    if [[ -z "${count:-}" || ! "$count" =~ ^[0-9]+$ ]]; then
      count="\"unknown\""
    fi
    if [[ "$first" -eq 1 ]]; then first=0; else echo ","; fi
    printf '    "%s": %s' "$coll" "$count"
  done
  echo ""
  echo "  }"
  echo "}"
} > "$MANIFEST"

echo "==> manifest written: ${MANIFEST}"
echo "==> file:   ${DUMP_DIR}"
