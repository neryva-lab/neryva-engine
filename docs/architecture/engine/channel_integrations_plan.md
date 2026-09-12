# Channel Integrations Plan — Messenger, WhatsApp, Telegram, Website Widget

> **Status:** plan (not yet implemented). Extends the Engine's conversation plane to external
> messaging channels so a customer's assistant can be deployed "anywhere" — Facebook Messenger,
> WhatsApp, Telegram, or any website — with the Engine remaining the system of record
> (invariant 1) and every channel message entering through the **same start-message transaction**
> (`ConversationsService.acceptMessage`, ledger 4.7) that the console API uses.
>
> Placement: this is a new ledger-style workstream **Phase C** (C0–C6), phased like Phases 3–9.
> It must not weaken any of the 12 non-weakening decisions (`engine_architecture.md:570-584`);
> in particular tenant isolation (3), idempotency (4), outbox-in-TX (7), and claim-check (10)
> apply to every channel path below.

---

## 1. Architecture — one conversation plane, many transports

```
                   ┌── Meta webhook (Messenger/WhatsApp)  X-Hub-Signature-256
   channel  ─────► │── Telegram webhook                   X-Telegram-Bot-Api-Secret-Token
   platform        │── Website widget (public key)        session token + Origin allowlist
                   └────────────────┬─────────────────────
                                    ▼
            [1] WebhookController (public, per-channel guard)
                verify signature over RAW body → resolve channel_account → 200 fast
                                    ▼
            [2] channel_events durable ingest  (dedup BEFORE any side effect)
                unique (channel_account_id, platform, external_event_id)
                + outbox row `channel.message.received` in the SAME TX   (invariant 7)
                                    ▼
            [3] channel-ingest consumer (worker)
                normalize platform payload → canonical content
                resolve/create channel_identities + conversation (channel_binding)
                call ConversationsService.acceptMessage (idempotency, pin, run)  (ledger 4.7)
                                    ▼
            [4] run lifecycle (dispatch → Studio → MCP authority → commitRunResult)
                                    ▼
            [5] channel-outbound consumer (worker)
                consumes run.completed / run.failed outbox events
                → messaging-window policy → per-platform sender (rate-limited)
                → delivery states (sent/delivered/read/failed) → channel_message_links
```

Key reuse (do **not** reinvent):
- `ConversationsService.acceptMessage` — the only message-entry point (idempotency tier, run pinning,
  one-active-turn, outbox-in-TX are already correct there).
- `recordOutboxEvent` + dispatcher + consumer contract + inbox dedup (Phase 6) — every channel
  side effect is durable and replay-safe.
- Billing webhook inbox pattern (`BillingReconciliationService.ingestWebhook`,
  `(provider, provider_event_id)` dedup **before** handling) — generalized into `channel_events`.
- Envelope encryption (`common/infra/crypto/envelope.ts`, `ENGINE_ENCRYPTION_KEY`) — channel
  credentials (page tokens, app secrets, bot tokens) are sealed at rest, never logged.
- `StorageService` + artifacts claim-check (Phase 7) — all media (inbound downloads, outbound
  attachments) go through tenant-bound `org/{orgId}/...` keys.
- `common/http/rate-limit.ts` + quota reservations (Phase 8) — public widget abuse control and
  per-account send-rate limiting.
- SSE run-event stream (Phase 4.10) — the website widget consumes a session-scoped variant.
- Audit service — every channel account mutation and every signature-failure pattern is audited.

---

## 2. Platform mechanics (verified against vendor docs)

### 2.1 Meta (Messenger + WhatsApp share one webhook contract)
- **Endpoint verification (one-time):** Meta sends `GET ...?hub.mode=subscribe&hub.verify_token=T&hub.challenge=C`.
  Echo `hub.challenge` verbatim iff `T` equals the account's stored verify token — constant-time compare; 403 otherwise.
- **Payload authenticity (every POST):** header `X-Hub-Signature-256: sha256=<hex>` =
  HMAC-SHA256(**raw request body**, app_secret). Must hash the **raw, unmodified** body — the Engine
  already preserves it (`request.rawBody`, `main.ts` JSON parser). Compare with `timingSafeEqual`.
  Failed verification → 401 + `channel_webhook_signature_failures_total` metric + (after a threshold)
  audit and temporary 403 of the account.
- **Messenger:** send via `POST /{page-id}/messages` with page access token; 24-hour standard
  messaging window opens on the user's last message; outside it only **utility messages**
  (the July 2025 replacement for ACCOUNT_UPDATE / POST_PURCHASE_UPDATE / CONFIRMED_EVENT_UPDATE tags),
  or opt-in recurring notifications. Sender identity is page-scoped id (`psid`).
- **WhatsApp Cloud API:** send via `POST /{phone_number_id}/messages`; the **24-hour customer
  service window** opens on each inbound user message; outside it only pre-approved **templates**
  (categories: utility / marketing / authentication; template name + language + named params).
  Sender identity is `wa_id` (phone). Delivery statuses arrive as `statuses` webhook events
  (sent/delivered/read/failed with provider error codes) — used to drive `delivery_state`.
- **Messaging windows are enforced Engine-side** before any send: `channel_identities.window_expires_at`
  (bumped on every inbound); outside the window the outbound consumer either (a) sends the configured
  WhatsApp template / Messenger utility message, or (b) parks the reply and surfaces
  `channel_window_denied_total` — never a raw API error storm.

### 2.2 Telegram
- `setWebhook` is called **by the Engine** at account activation with `secret_token`
  (1–256 chars, `A-Za-z0-9_-`), `allowed_updates` limited to `message` (+ `callback_query` later),
  and the Engine's public URL. Every update carries `X-Telegram-Bot-Api-Secret-Token`; compare
  constant-time against the account's stored secret → 403 on mismatch. There is no HMAC — the
  secret token **is** the authenticity control, so it is generated per account (32 chars),
  stored sealed, and rotated on demand.
- Webhook handlers must return 200 **fast**; all work is async via the durable ingest (§1).
- Rate limits: ~1 msg/sec per chat, ~30 msg/sec global, ~20 msg/min per group; HTTP 429 carries
  `retry_after` → map to outbox `RETRY_WAIT` with that delay (never hammer the API).

### 2.3 Website widget (embed anywhere)
Public, unauthenticated surface — the threat model differs from server-to-server webhooks
(anyone can open the page). Controls:
- **Public key only** in the widget bundle: `nk_live_<24 chars>` identifies the `channel_account`
  (platform `web`). No secret, no token in the bundle.
- **Session minting:** `POST /public/channels/:publicKey/session` → server checks the **Origin**
  header against the account's domain allowlist, optionally a Turnstile token (reuse
  `common/http/turnstile.ts`), then mints a session: 32-byte random token returned ONCE to the
  browser; **sha256 hash** stored in `channel_sessions` (leak of DB ≠ leak of sessions).
  TTL 12h sliding; one active conversation per session.
- **Every widget request** carries the session token (header `X-Neryva-Session`); resolved by hash;
  revoked/expired → 401 with a re-mint hint. Messages additionally go through
  `UsageLedgerService.reserve` (public quota dimension, e.g. `web_messages` per account) so a
  flood cannot run up LLM cost — deterministic rejection, no billing-provider call (8.9).
- **CORS:** reflect the Origin **only when it matches the account allowlist** (never `*`),
  `Vary: Origin`; rate-limit middleware runs before CORS finalization so 429s are readable.
- **Streaming:** `GET /public/channels/:publicKey/stream` — session-scoped SSE that replays the
  conversation's `run_events` (same engine_sequence cursor semantics as the console stream) and
  terminates with the run. Sessions never see other conversations (single-conversation binding).
- **Widget script** served from the Engine domain with immutable cache (`/public/widget/v1/neryva.js`),
  strict CSP on the serving response; customers embed `<script src=... data-key="nk_live_...">`.

---

## 3. Data model (migration `0030_channels.sql` — all tables RLS ENABLE+FORCE, USING+WITH CHECK)

```
channel_accounts     id uuidv7 pk, organization_id fk+RLS, platform enum
                     ('whatsapp'|'messenger'|'telegram'|'web') CHECK,
                     display_name, public_key varchar unique null (platform='web'),
                     credentials_sealed jsonb (envelope-encrypted:
                       app_secret / access_token / bot_token / webhook_secret),
                     verify_token_sealed text null,
                     config jsonb (default_assistant_id fk assistants,
                       allowed_domains text[] null, greeting, window_policy),
                     status enum pending|active|suspended, health jsonb,
                     created_by, created_at/updated_at, retention_class
channel_identities   id, organization_id, channel_account_id fk, platform,
                     external_user_id varchar (psid|wa_id|chat_id|visitor ref),
                     display_name, locale, last_inbound_at, window_expires_at,
                     UNIQUE (channel_account_id, external_user_id)
channel_sessions     id, organization_id, channel_account_id, identity_id,
                     token_hash varchar(64) unique, status active|expired|revoked,
                     expires_at, created_ip_hash, user_agent_hash, last_active_at
channel_message_links id, organization_id, conversation_id fk, message_id fk,
                     channel_account_id, direction inbound|outbound, platform,
                     external_message_id varchar null, external_event_id varchar null,
                     delivery_state enum pending|sent|delivered|read|failed,
                     provider_error jsonb, created_at, updated_at,
                     UNIQUE (channel_account_id, external_message_id) WHERE inbound
channel_events       id, organization_id, channel_account_id, platform,
                     external_event_id varchar, payload jsonb (raw, bounded 256KB),
                     signature_ok bool, received_at, processed_at, status
                     received|processed|quarantined,
                     UNIQUE (channel_account_id, external_event_id)   ← dedup authority
```

Notes:
- `conversations.channel_binding` (exists, jsonb) carries `{platform, channel_account_id,
  channel_identity_id}`; `conversation_participants` gains `participant_type='channel'` rows
  (already supported by `0002`/`0022`).
- `channel_message_links` is the outbound dedup + delivery-tracking anchor: the outbound consumer
  claims `(message_id)` before sending (inbox contract) so outbox redelivery can never double-send
  (Phase 4/6 gates apply unchanged).
- Retention: `channel_events.raw payload` is hot data — default retention 30d via
  `retention_policies`; links/identities follow the org's retention classes.

---

## 4. API surface

Console (L1, `OrgRolesGuard`, `@Idempotent`, entitlement-gated `channels.max_accounts`):
```
POST   /console/org/:orgId/channels                      create + seal credentials
GET    /console/org/:orgId/channels                      list (credentials never returned)
GET    /console/org/:orgId/channels/:id                  detail + health + window state
PATCH  /console/org/:orgId/channels/:id                  config (domains, assistant, greeting)
DELETE /console/org/:orgId/channels/:id                  deactivate (tombstone-friendly)
POST   /console/org/:orgId/channels/:id/verify           test credentials against platform API
POST   /console/org/:orgId/channels/:id/rotate           re-seal credentials / rotate webhook secret
POST   /console/org/:orgId/channels/:id/webhook-url      returns the Engine webhook URL + verify token
```

Public webhook plane (deny-by-default custom guards; per-URL account routing):
```
GET/POST /webhooks/whatsapp/:channelAccountId      hub.challenge + signed events
GET/POST /webhooks/messenger/:channelAccountId     hub.challenge + signed events
POST     /webhooks/telegram/:channelAccountId      secret-token header check
```

Public widget plane:
```
POST /public/channels/:publicKey/session           Origin(+Turnstile) → session token
POST /public/channels/:publicKey/messages          session-scoped acceptMessage
GET  /public/channels/:publicKey/stream            session-scoped SSE (Last-Event-ID)
GET  /public/widget/v1/neryva.js                   immutable embed script
```

Bijection: the widget plane rides the existing `/public` platform prefix (`route-bijection.service.ts`,
already allowed for corporate forms). The webhook plane follows the Stripe pattern
(`/webhooks/stripe` is a registered platform prefix): add `/webhooks/channels` as one platform
prefix in the same PR, with controllers `@Controller('webhooks/channels/:platform/:channelAccountId')`.
Public webhook/widget controllers are `@Public()` + per-channel verification guards, exactly like
`stripe.controller.ts` (deliberately public, HMAC-authenticated).

---

## 5. Inbound pipeline (worker `channel-ingest.consumer`)

1. Controller verifies authenticity (§2), resolves `channel_accounts` by URL id, writes
   `channel_events` (dedup on `(channel_account_id, external_event_id)` via
   `onConflictDoNothing`) **and** an outbox `channel.message.received` row **in one TX** —
   responds 200/`challenge` immediately. Meta/Telegram SLAs are met because zero platform
   I/O happens on the webhook path.
2. Consumer (outbox, inbox-deduped): parse the platform envelope →
   `{ external_user_id, external_message_id, text|media|payload, timestamp }`.
3. Reject stale events (`timestamp` older than 7d → quarantined, counted).
4. Upsert `channel_identities` (tenant-scoped, `withOrg`) and bump `window_expires_at = now()+24h`.
5. Resolve conversation: last open conversation for the identity, else create with
   `channel_binding` + `participant_scope='channel'` + account's `default_assistant_id`.
   Archived/deleted → new conversation. Tombstoned → 410 path (Phase 9).
6. Call `acceptMessage` with `idempotencyKey = 'channel:{account}:{external_message_id}'`
   (DB idempotency tier), `principalId = channel:{account}`, `content = {text, channel_meta}`.
7. Write `channel_message_links` (inbound) in the same consumer TX as the accept result.
8. Unsupported content types (stickers, polls v1) → store artifact-less normalized marker,
   reply with the platform's standard fallback text.

Failure classes (implement first, ledger Phase 5 discipline):
- Redelivered webhook → dedup at `channel_events` (no user-visible duplicate).
- Consumer crash after accept before link write → redelivery re-runs; acceptMessage idempotency
  returns the same message/run; link upsert converges.
- Platform replay with same message id but different content → `channel_message_links` conflict →
  quarantined + audited (tamper signal).
- Signature failure flood per account → automatic `status='suspended'` + staff alert runbook.

---

## 6. Outbound pipeline (worker `channel-outbound.consumer`)

Consumes `run.completed` and `run.failed` (and, later, `run.awaiting_input`) outbox events:
1. Inbox-dedup → load the final assistant message (from payload `message_id`).
2. Load conversation `channel_binding` — no channel account → skip (console runs).
3. Window policy (§2): inside window → free-form send; outside → WhatsApp template /
   Messenger utility message if `config.out_of_window` configured, else park + metric.
4. Rate limiter per `(channel_account)`: token bucket honoring platform ceilings
   (Telegram 1/s/chat + 30/s global; Meta per-account throughput tier) — overflow waits, never 429s.
5. Sender port per platform (`senders/{whatsapp,messenger,telegram}.sender.ts`) →
   `POST .../messages` with the sealed token (decrypted in-memory only, never logged).
6. Record `channel_message_links` (outbound, `external_message_id`, `delivery_state='sent'`).
   Status webhook events (delivered/read/failed) update it via the same ingest pipeline
   (status events skip acceptMessage).
7. 429/5xx → throw retryable (outbox backoff); 4xx permanent (bad template, revoked token) →
   `PermanentConsumerError` → dead-letter + account `health.degraded` + console notification.

Media: outbound attachments upload to artifacts (`purpose='TOOL_RESULT'|'COVER'`) then send the
platform media id/link; inbound media is downloaded by the consumer (never the API process),
stored via claim-check, referenced with `ArtifactRef` (invariant 10).

---

## 7. Security & tenancy invariants (checklist)

- [ ] Signature/secret verification over **raw** body, constant-time, fail-closed; no skip flag in production.
- [ ] `channel_accounts.credentials_sealed` decrypted only in sender paths; denylist entries for
      `access_token`, `app_secret`, `bot_token` in the logger redaction filter; audit records carry
      ids, never material.
- [ ] Every downstream query `withOrg(channel_account.organization_id)`; `channel_identities` unique
      per account — two orgs can never see the same external user.
- [ ] Widget: Origin allowlist enforcement + hash-at-rest sessions + per-session quota reservation +
      session-scoped SSE (no conversation id ever accepted from the client).
- [ ] Public routes are explicitly `@Public()` + custom guard — deny-by-default otherwise;
      request-size limits on all public bodies (messages ≤ 4KB text).
- [ ] Replay: signature + event timestamp floor + `(channel_account, external_event_id)` dedup.
- [ ] Isolation tests: cross-account webhook (valid signature, wrong account id) → 404;
      cross-origin widget session mint → 403; session token from another account → 401.
- [ ] Purge (Phase 9): conversation purge cascades `channel_message_links`; account deletion
      tombstones `public_key`; retention sweeps `channel_events`.

## 8. Entitlements, metering, limits

- Entitlement keys: `channels.max_accounts`, `channels.platforms` (list), `channels.web_widget`.
- Usage metering: usage_ledger entries `usage_kind='channel_message'` per accepted inbound/outbound
  with `source_type='channel'` (Phase 8 path; public widget sends go through quota reservations so
  rejection is deterministic during provider outage).
- Anomaly service (8.4) gains per-account send-rate anomaly detection (stolen bot token pattern:
  sudden outbound spike from a suspended-status account → auto-suspend + audit).

## 9. Observability & runbooks

Metrics: `channel_webhook_received_total{platform,account}` · `channel_webhook_signature_failures_total`
· `channel_ingest_lag_seconds` · `channel_outbound_send_total{platform,result}` ·
`channel_send_latency_seconds` · `channel_window_denied_total` · `channel_session_mint_total`.
Dashboards in `ops/dashboards/channels.json`. Runbooks: `channel-token-rotation`,
`platform-outage`, `signature-failure-spike`, `widget-abuse` (`ops/runbooks/`).

## 10. Phased delivery (ledger-style)

| Phase | Scope | Exit signal |
|---|---|---|
| **C0** | ADR + threat-model addendum (spoofed webhooks, widget abuse, token compromise, cross-tenant identity) + `dec-00X-channel-plane.md` | reviewed sign-off |
| **C1** | Migration 0030 + `channel_accounts` CRUD + envelope sealing + entitlements + bijection prefixes | console CRUD green; sealed creds never returned/logged |
| **C2** | Webhook plane (Meta verify + signature, Telegram secret) + `channel_events` durable ingest + normalizers → `acceptMessage` | duplicate delivery test idempotent; forged signature 401; lag < 2s p95 |
| **C3** | Outbound senders + windows + rate limiter + delivery states + health | outbox redelivery never double-sends; window denied path tested; 429 backoff verified |
| **C4** | Website widget plane (public keys, sessions, CORS, quotas, SSE, embed script) | cross-origin denied; session replay rejected; quota deterministic |
| **C5** | Media both directions via artifacts claim-check | oversize/mime tests; tenant-bound keys verified |
| **C6** | Chaos (kill during send/ingest), load (fan-out 10k ident), red team (replay, cross-account, token leak), runbooks + dashboards | evidence in ops/ |

Sequencing rule: C1 → C2 → C3 are the critical path (a channel that can receive but not reply is
not shippable); C4 can run parallel to C3 after C2 lands; C5 rides C3; C6 closes the phase.

## 11. Explicit non-goals (v1)

- Instagram DMs / X / email channels (same architecture, later accounts rows).
- Telegram group conversations (v1: 1:1 private chats only — group logic differs materially).
- Inbound interactive components beyond text/buttons mapping (WhatsApp interactive replies →
  normalized text; rich rendering is a widget-only feature).
- Platform-side catalog/payments integrations.

## References (vendor mechanics verified 2026-09)

- Meta webhook endpoint verification + `X-Hub-Signature-256`: developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint/
- WhatsApp 24h customer service window + template categories (utility/marketing/authentication): developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-categorization
- Messenger 24h policy + July 2025 utility-messages migration: developers.facebook.com/documentation/business-messaging/messenger-platform/policy · developers.facebook.com/blog/post/2025/07/29/simplify-customer-updates-with-utility-messages-on-messenger/
- Telegram `setWebhook secret_token` + `X-Telegram-Bot-Api-Secret-Token` (Bot API 6.1+): core.telegram.org/bots/api · Telegram FAQ (~30 msg/s global, ~1 msg/s per chat): core.telegram.org/bots/faq
- Widget session-token pattern (public key only, hash-at-rest, domain allowlist, per-session rate limits): see research notes in PR description.
