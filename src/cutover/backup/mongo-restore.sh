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

# --- source database --------------------------------------------------------
# mongodump --out writes <DUMP_DIR>/<sourcedb>/*.bson. mongorestore restores
# into the database names from the DUMP DIRECTORY STRUCTURE — the database
# in the URI is IGNORED for directory restores. Restoring without an
# explicit namespace remap would silently write back into the SOURCE
# database (potentially production). Derive the source DB from the dump
# structure and remap with --nsFrom/--nsTo when it differs from the target.
mapfile -t DB_DIRS < <(find "$DUMP_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort)
if [[ "${#DB_DIRS[@]}" -ne 1 ]]; then
  echo "error: expected exactly one database directory under ${DUMP_DIR}, found ${#DB_DIRS[@]}" >&2
  exit 1
fi
DUMP_SOURCE_DB="${DB_DIRS[0]}"
if [[ "$DUMP_SOURCE_DB" != "$TARGET_DB" ]]; then
  echo "warning: dump holds database '${DUMP_SOURCE_DB}' but target is '${TARGET_DB}'" >&2
  echo "         namespaces will be remapped ${DUMP_SOURCE_DB}.* -> ${TARGET_DB}.*" >&2
fi

# --- confirmation -----------------------------------------------------------
if [[ -z "$ASSUME_YES" ]]; then
  echo "About to restore:"
  echo "  dump dir: ${DUMP_DIR}  (source db: ${DUMP_SOURCE_DB})"
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

if [[ "$DUMP_SOURCE_DB" == "$TARGET_DB" ]]; then
  mongorestore --uri="$MONGO_URL" --drop "$DUMP_DIR"
else
  mongorestore --uri="$MONGO_URL" --drop \
    --nsFrom="${DUMP_SOURCE_DB}.*" --nsTo="${TARGET_DB}.*" \
    "$DUMP_DIR"
fi

echo "==> restore complete into '${TARGET_DB}'"
