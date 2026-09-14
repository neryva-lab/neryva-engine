# Runbook — Secret & key rotation

**Detection:** scheduled rotation (Phase 10.3 drill cadence), a staff security report, a suspected leak (`mcp-capability-incident.md`, `cross-tenant-incident.md`), or vendor expiry. Principle: every secret below is boot-fail-closed in production (`src/common/config/env.ts`) — a rotation that leaves the engine unable to boot is a detected failure, not a silent one.

## Rotation procedures

### `IDENTITY_JWT_SIGNING_KEY_FILE` (L1 sessions)
1. Generate the new key file next to the old one; set `IDENTITY_JWT_SIGNING_KEY_PREVIOUS_FILE` to the OLD key so outstanding access tokens verify during the overlap window.
2. Rolling restart. Verify logins + an existing session still validate.
3. After `IDENTITY_ACCESS_TTL_SECONDS` passes (every old access token expired), remove the previous key. Refresh tokens re-key on their next rotation.

### `IDENTITY_COOKIE_KEYS` (session cookies)
Array-ordered: prepend the NEW key, keep the old one second (old cookies still verify, new cookies are sealed with the first). Rolling restart; drop the old key after the refresh TTL window.

### `ENGINE_ENCRYPTION_KEY` (envelope `enc:v1:` material — channel + provider credentials)
AES-256-GCM key for EVERY `enc:v1:` value at rest. Rotation requires **re-sealing**, not just swapping:
1. Boot with both keys available on a maintenance window (deploy the re-seal path); for each sealed column (`channel_accounts.credentials_sealed`, `verify_token_sealed`, `provider_credentials.secret_sealed`), decrypt with the old key and re-encrypt with the new one — in idempotent, resumable batches.
2. Zero rows left readable by the old key (`select count(*) where ...` per sealed column) before decommissioning it.
3. Verification: channel `verify` probes succeed; the MCP `GetToolCredential` path discloses correctly.

### `MCP_CAPABILITY_SIGNING_KEY` (run-scoped capability tokens)
Rotation invalidates every outstanding token — brief run-delivery outage. See `mcp-capability-incident.md` for the blast-radius details: schedule it, restart, confirm new runs issue/validate, let the accepted-run sweep re-drive disrupted runs.

### `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`
Rotate in Stripe first, then update the engine env and restart. Old-signature webhooks in flight will 400 for one window — Stripe retries them after the secret matches; verify the inbox drains (`billing-webhook-reconciliation.md`).

### S3 keys, channel credentials, `IDENTITY_AGENT_RUNTIME_SECRET`, `BOOTSTRAP_API_KEY`
- S3: create the new key pair, deploy, then revoke the old one (order matters — the engine must never hold only a dead key).
- Channel credentials: per-account rotation WITHOUT downtime is documented in `channel-operations.md`.
- The break-glass bootstrap key: rotate like an incident — audit every use first (`audit_events`).

## Evidence to capture

Per secret: the change window, restart timestamps, the verification probe that passed, and (for the envelope key) the re-seal batch counts with zero-remaining proof. The Phase 10.3 drill is one full pass of this runbook against staging — record it.
