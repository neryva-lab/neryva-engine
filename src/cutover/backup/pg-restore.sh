#!/usr/bin/env bash
#
# pg-restore.sh — restore a pg_dump custom-format file into a target database.
#
# Usage:
#   PG_URL='postgresql://user:pass@host:5432/targetdb' ./pg-restore.sh /path/to/pg-db-20240101T000000Z.dump [--i-know-what-i-am-doing]
#
# Environment:
#   PG_URL  (required) PostgreSQL connection URL of the RESTORE TARGET.
#
# SAFETY:
#   - Refuses to restore into a database literally named `neryva` (the live
#     production database name) unless --i-know-what-i-am-doing is passed.
#   - Otherwise requires an explicit interactive confirmation (type the target
#     database name). Non-interactive runs must pass --yes.
#
# Options:
#   --i-know-what-i-am-doing   bypass the production-name guard
#                             (still requires --yes for non-interactive use)
#   --yes                      answer the confirmation prompt affirmatively
#   -h, --help                 print usage
#
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: PG_URL='postgresql://user:pass@host:5432/targetdb' ./pg-restore.sh DUMP_FILE [--i-know-what-i-am-doing] [--yes]

Restores a pg_dump custom-format dump into the database named by PG_URL.

Environment:
  PG_URL  (required) PostgreSQL connection URL of the RESTORE TARGET.

Safety:
  Refuses to restore into a database named exactly `neryva` unless
  --i-know-what-i-am-doing is passed. Otherwise requires interactive
  confirmation (or --yes).

Example:
  PG_URL='postgresql://neryva_app:secret@127.0.0.1:5432/neryva_restore' \
    ./pg-restore.sh ./backups/pg-neryva-20240101T000000Z.dump
EOF
}

FORCE=""
ASSUME_YES=""
DUMP_FILE=""

for arg in "$@"; do
  case "$arg" in
    -h|--help) usage; exit 0 ;;
    --i-know-what-i-am-doing) FORCE="1" ;;
    --yes) ASSUME_YES="1" ;;
    *) if [[ -z "$DUMP_FILE" ]]; then DUMP_FILE="$arg"; else echo "error: unexpected argument: $arg" >&2; usage; exit 1; fi ;;
  esac
done

if ! command -v pg_restore >/dev/null 2>&1; then
  echo "error: required command 'pg_restore' not found on PATH" >&2
  exit 1
fi

if [[ -z "$DUMP_FILE" ]]; then
  echo "error: DUMP_FILE is required" >&2
  usage
  exit 1
fi
if [[ ! -f "$DUMP_FILE" ]]; then
  echo "error: dump file not found: ${DUMP_FILE}" >&2
  exit 1
fi
: "${PG_URL:?error: PG_URL is required (the RESTORE TARGET, e.g. postgresql://user:pass@host:5432/neryva_restore)}"

TARGET_DB="$(printf '%s' "$PG_URL" | sed -E 's#.*/([^/?]+)(\?.*)?$#\1#')"
if [[ -z "$TARGET_DB" ]]; then
  echo "error: could not parse a database name out of PG_URL" >&2
  exit 1
fi

# --- production guard -------------------------------------------------------
if [[ "$TARGET_DB" == "neryva" && -z "$FORCE" ]]; then
  echo "error: refusing to restore into the live production database 'neryva'" >&2
  echo "       pass --i-know-what-i-am-doing if you truly intend to overwrite production" >&2
  exit 1
fi

# --- confirmation -----------------------------------------------------------
if [[ -z "$ASSUME_YES" ]]; then
  echo "About to restore:"
  echo "  dump:   ${DUMP_FILE}"
  echo "  target: ${TARGET_DB}  (${PG_URL%%\?*})"
  echo ""
  echo "This will OVERWRITE data in '${TARGET_DB}'."
  read -r -p "Type the target database name to confirm: " answer
  if [[ "$answer" != "$TARGET_DB" ]]; then
    echo "confirmation did not match — aborting" >&2
    exit 1
  fi
else
  echo "==> --yes given: restoring ${DUMP_FILE} into '${TARGET_DB}'"
fi

pg_restore --no-owner --clean --if-exists --dbname="$PG_URL" "$DUMP_FILE"

echo "==> restore complete into '${TARGET_DB}'"
