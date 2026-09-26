#!/usr/bin/env bash
#
# mongo-restore.sh — restore a mongodump directory into a target MongoDB database.
#
# Usage:
#   MONGO_URL='mongodb://user:pass@host:27017/targetdb?replicaSet=rs0' ./mongo-restore.sh /path/to/mongo-db-20240101T000000Z [--i-know-what-i-am-doing] [--yes]
#
# Environment:
#   MONGO_URL   (required) MongoDB connection URI of the RESTORE TARGET.
#               The database name comes from the URI path. MONGODB_URI is
#               accepted as a fallback.
#   MONGO_PROD_DBS (optional) Comma-separated database names treated as
#               production (in addition to the built-in list). Default: ""
#
# SAFETY:
#   - Refuses to restore into well-known production database names
#     (neryva, neryva_prod, neryva_production, production, prod, plus any in
#     MONGO_PROD_DBS) unless --i-know-what-i-am-doing is passed.
#   - Otherwise requires an explicit interactive confirmation (type the target
#     database name). Non-interactive runs must pass --yes.
#
# Options:
#   --i-know-what-i-am-doing   bypass the production-name guard
#   --yes                      answer the confirmation prompt affirmatively
#   -h, --help                 print usage
#
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: MONGO_URL='mongodb://user:pass@host:27017/targetdb?replicaSet=rs0' ./mongo-restore.sh DUMP_DIR [--i-know-what-i-am-doing] [--yes]

Restores a mongodump directory into the database named in MONGO_URL's path.

Environment:
  MONGO_URL       (required) MongoDB connection URI of the RESTORE TARGET.
                             Falls back to MONGODB_URI.
  MONGO_PROD_DBS  (optional) Extra comma-separated DB names treated as
                             production. Default: ""

Safety:
  Refuses well-known production database names unless
  --i-know-what-i-am-doing is passed. Otherwise requires interactive
  confirmation (or --yes).

Example:
  MONGO_URL='mongodb://127.0.0.1:27017/neryva_restore?replicaSet=rs0' \
    ./mongo-restore.sh ./backups/mongo-neryva-20240101T000000Z
EOF
}

FORCE=""
ASSUME_YES=""
DUMP_DIR=""

for arg in "$@"; do
  case "$arg" in
    -h|--help) usage; exit 0 ;;
    --i-know-what-i-am-doing) FORCE="1" ;;
    --yes) ASSUME_YES="1" ;;
    *) if [[ -z "$DUMP_DIR" ]]; then DUMP_DIR="$arg"; else echo "error: unexpected argument: $arg" >&2; usage; exit 1; fi ;;
  esac
done

if ! command -v mongorestore >/dev/null 2>&1; then
  echo "error: required command 'mongorestore' not found on PATH" >&2
  exit 1
fi

if [[ -z "$DUMP_DIR" ]]; then
  echo "error: DUMP_DIR is required" >&2
  usage
  exit 1
fi
if [[ ! -d "$DUMP_DIR" ]]; then
  echo "error: dump directory not found: ${DUMP_DIR}" >&2
  exit 1
fi

MONGO_URL="${MONGO_URL:-${MONGODB_URI:-}}"
if [[ -z "$MONGO_URL" ]]; then
  echo "error: MONGO_URL (or MONGODB_URI) is required (the RESTORE TARGET)" >&2
  exit 1
fi

TARGET_DB="$(printf '%s' "$MONGO_URL" | sed -E 's#^[^/]+//[^/]+/([^?]+)(\?.*)?$#\1#')"
if [[ -z "$TARGET_DB" || "$TARGET_DB" == "$MONGO_URL" ]]; then
  echo "error: could not parse a database name out of the MongoDB URI" >&2
  echo "       the URI must include a database path, e.g. mongodb://host:27017/neryva_restore" >&2
  exit 1
fi

# --- production guard -------------------------------------------------------
BUILTIN_PROD="neryva,neryva_prod,neryva_production,production,prod"
EXTRA_PROD="${MONGO_PROD_DBS:-}"
PROD_LIST=",${BUILTIN_PROD},${EXTRA_PROD},"
if [[ "$PROD_LIST" == *",${TARGET_DB},"* && -z "$FORCE" ]]; then
  echo "error: refusing to restore into production database '${TARGET_DB}'" >&2
  echo "       pass --i-know-what-i-am-doing if you truly intend to overwrite production" >&2
  exit 1
fi

# Warn (but allow) when the dump dir name suggests a different source DB.
DUMP_BASENAME="$(basename "$DUMP_DIR")"
if [[ "$DUMP_BASENAME" == mongo-*-* ]]; then
  SOURCE_DB="$(printf '%s' "$DUMP_BASENAME" | sed -E 's#^mongo-(.+)-[0-9]{8}T[0-9]{6}Z$#\1#')"
  if [[ "$SOURCE_DB" != "$DUMP_BASENAME" && "$SOURCE_DB" != "$TARGET_DB" ]]; then
    echo "warning: dump dir suggests source database '${SOURCE_DB}' but target is '${TARGET_DB}'" >&2
  fi
fi

# --- confirmation -----------------------------------------------------------
if [[ -z "$ASSUME_YES" ]]; then
  echo "About to restore:"
  echo "  dump dir: ${DUMP_DIR}"
  echo "  target:   ${TARGET_DB}"
  echo ""
  echo "This will OVERWRITE data in '${TARGET_DB}' (--drop is used)."
  read -r -p "Type the target database name to confirm: " answer
  if [[ "$answer" != "$TARGET_DB" ]]; then
    echo "confirmation did not match — aborting" >&2
    exit 1
  fi
else
  echo "==> --yes given: restoring ${DUMP_DIR} into '${TARGET_DB}'"
fi

mongorestore --uri="$MONGO_URL" --drop "$DUMP_DIR"

echo "==> restore complete into '${TARGET_DB}'"
