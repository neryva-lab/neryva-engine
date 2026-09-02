#!/usr/bin/env bash
# Single release-job migration runner — Phase 1.2
# `drizzle-kit migrate` is never run per-replica on boot. The release job runs this script once,
# verifies the `_journal.json` order, applies to the managed database, and records evidence.
# Usage: DATABASE_URL=postgresql://... ops/migrate.sh [--dry-run]

set -euo pipefail

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required (managed HA primary). Refusing to run against a guessed URL." >&2
  exit 2
fi

# Verify journal order is monotonic — catches the duplicate 0009 drift before it reaches production.
echo "Verifying drizzle/meta/_journal.json order…"
node -e "
const j = require('./drizzle/meta/_journal.json');
let prev = -1;
for (const e of j.entries) {
  if (e.idx !== prev + 1) {
    console.error(\`journal idx gap: expected \${prev+1} got \${e.idx} (\${e.tag})\`);
    process.exit(1);
  }
  prev = e.idx;
}
console.log(\`journal ok: \${j.entries.length} entries, last \${j.entries[prev].tag}\`);
"

if [[ "$DRY_RUN" == "true" ]]; then
  echo "[dry-run] would run: drizzle-kit migrate"
  exit 0
fi

echo "Applying migrations (single release job)…"
npx drizzle-kit migrate
echo "Migration complete. Record the output as release evidence and tag the artifact."
