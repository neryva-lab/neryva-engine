#!/usr/bin/env bash
# REL-8.6 — red-team drill harness (Phase 10.4). Authored, NOT executed: run
# against staging with a real L2 key + a live assistant; every case asserts a
# DENY. References: ops/e2e/fixtures/injection-corpus.json (prompt-injection
# corpus), docs/architecture/engine/asvs-mapping.md, threat-model.md.
set -uo pipefail

BASE="${NERYVA_E2E_BASE_URL:-http://localhost:3001}"
L2="${NERYVA_L2_KEY:?nrv_live_ key required}"
ORG="${NERYVA_ORG_ID:?org id required}"

case_outcome() { printf '  [%s] %s\n' "$2" "$1"; }

echo "=== T1. webhook signature forgery (channels) ==="
# Meta-style signature over a tampered body must 401 BEFORE side effects.
body='{"object":"whatsapp_business_account"}'
sig="sha256=$(printf '%s' "$body" | openssl dgst -sha256 -hmac 'wrong-secret' | cut -d' ' -f2)"
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  "$BASE/webhooks/channels/whatsapp/test-account" -H "X-Hub-Signature-256: $sig" \
  -H 'content-type: application/json' -d "$body" | grep -q '^401' \
  && case_outcome "forged Meta signature rejected 401" PASS || case_outcome "forged signature NOT rejected" FAIL

echo "=== T2. cross-tenant reads (org B credentials, org A resources) ==="
# Every console read of a foreign-org resource must 404 (uniform, no leak).
for path in "conversations/00000000-0000-4000-a000-00000000000a" "runs/00000000-0000-4000-a000-00000000000a"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/console/org/$ORG/$path" -H "Authorization: Bearer $L2")
  case_outcode="got $code for $path"
  [ "$code" = "404" ] && case_outcome "$case_outcode" PASS || case_outcome "$case_outcode (expected 404)" FAIL
done

echo "=== T3. widget cross-origin session creation ==="
# The session route is POST /public/channels/:publicKey/session
# (widget.controller.ts) — an unknown public key or a foreign Origin must
# be refused before any session row exists.
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/public/channels/nk_live_invalid/session" \
  -H 'Origin: https://evil.example' -H 'content-type: application/json' -d '{}')
[ "$code" = "401" ] || [ "$code" = "403" ] || [ "$code" = "404" ] \
  && case_outcode="invalid public key / foreign origin rejected ($code)" && case_outcome "$case_outcode" PASS \
  || case_outcome "unexpected $code" FAIL

echo "=== T4. capability token misuse (expired/foreign run) ==="
# A capability minted for run A must not operate run B: the transport binds
# runId from the token scope — a mismatched request is a 403.
case_outcome "covered by transport assertCapability scope checks — exercise with a real token pair (manual step; needs two live runs)" MANUAL

echo "=== T5. prompt-injection corpus through the agent surface ==="
# Drive ops/e2e/fixtures/injection-corpus.json cases through the widget or
# test-run surface; every case's blocked_or_resisted expectation must hold
# (moderation stub on :4010 flags GUARDRAIL_BLOCK_ME — see fixtures/).
case_outcome "run each corpus case through POST :assistantId/versions/:versionId/test-runs and diff responses against blocked_or_resisted" MANUAL

echo "=== T6. secrets-in-surface sweep ==="
# Responses, SSE frames, and engine logs must never contain sealed material
# fragments: grep staging logs for 'enc:v1:' occurrences (0 expected).
if docker compose -f ops/engine/docker-compose.yml logs engine 2>/dev/null | grep -q 'enc:v1:'; then
  case_outcome "sealed material fragment found in logs" FAIL
else
  case_outcome "no sealed material in engine logs" PASS
fi

cat <<'EOS'
Archive: the per-case transcript + ASVS mapping row (docs/architecture/engine/asvs-mapping.md)
for each finding. Any FAIL becomes a ledger gap with the case id.
EOS
