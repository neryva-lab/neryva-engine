# Runbook — Channel plane operations (Messenger / WhatsApp / Telegram / web widget)

Covers the channel plane (`docs/architecture/engine/channel_integrations_plan.md`,
module `src/modules/channels`, migration `drizzle/0030_channels.sql`).

## 1. Platform credential / token rotation

**Symptoms:** outbound sends failing with 401/`PermanentSendError`; Meta Graph errors
`190` (access token expired); Telegram 401 on `sendMessage`.

**Procedure (no downtime):**
1. Console → Channels → rotate credentials (`POST /console/org/:orgId/channels/:id/credentials/rotate`)
   with the new token. Rotation re-seals the envelope, resets status to `pending`, and
   generates a NEW Meta verify token for Meta platforms.
2. Re-run verify (`POST .../verify`) — flips the account back to `active` on success.
3. Meta platforms: update the webhook configuration in the Meta App dashboard if the
   verify token changed (the new token is shown once by `POST .../webhook-setup`).
4. Telegram: re-run `POST .../webhook-setup` (re-registers `setWebhook` with the sealed
   secret token — rotation preserves the webhook secret unless credentials change).
5. In-flight outbox retries recover automatically; check `outbox_events` for
   `run.completed` rows in `RETRY_WAIT` — they drain once sends succeed.

## 2. Signature-failure spike (possible forgery or leaked secret)

**Symptoms:** `channel_webhook_signature_failures_total` climbing; 401s in access logs
for `/webhooks/channels/*`.

**Procedure:**
1. Confirm in Meta App dashboard → Webhooks → recent delivery attempts (Meta retries on
   non-200; a secret mismatch after rotation is the most common cause).
2. If rotation-related: the old signature failures stop within Meta's retry window —
   no action.
3. If unexplained: treat as an active forgery attempt — suspend the account
   (`PATCH .../channels/:id { "status": "suspended" }`), audit scope, rotate credentials,
   then re-activate. All stored webhook events carry `signature_ok=false` → quarantined
   automatically (never processed).

## 3. Platform outage / degraded sends

**Symptoms:** `channel_outbound_send_total{result="retryable_error"}` climbing; 5xx/429
from graph.facebook.com or api.telegram.org; outbox age growing.

**Procedure:** the outbox retry machine (exp backoff + full jitter, dead-letter after
`OUTBOX_MAX_ATTEMPTS`) absorbs the outage. Do NOT disable the dispatcher. For extended
outages: watch `outbox_dead_letter_total`; after recovery replay dead letters via the
operator-authorized path (`OutboxDispatcherWorker.replayDeadLetter`). Telegram 429s carry
`retry_after` — the jittered backoff (≥1s) plus the provider limiter is the contract.

## 4. Widget abuse (flooding / session spam)

**Symptoms:** `channel_window_denied_total` irrelevant; widget 429s (`session message
limit reached`), high `chan:msg:*` Redis counters.

**Procedure:** per-session hourly caps and per-IP mint caps are automatic and
deterministic. For a targeted flood: suspend the widget account (kills all sessions via
revocation on deactivate) or narrow `config.allowed_domains`. Sessions are stored
hash-at-rest — a DB leak never yields usable tokens.

## 5. Data model notes for incident queries

- Delivery forensics: `channel_message_links` (`delivery_state`, `provider_error`).
- Inbound replay: `channel_events` (`payload.raw`, `signature_ok`, `status`).
- Window state: `channel_identities.window_expires_at` (Meta 24h customer-service window).
- All tables are org-scoped (RLS); queries during incidents use `withOrg`/console views —
  no direct prod SQL.
