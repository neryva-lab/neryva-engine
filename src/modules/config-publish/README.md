# config-publish (`src/modules/config-publish`)

**Purpose:** engine side of handover A-4 — the engine is the single
decision point for policy sets, guardrail profiles, quota profiles, and
model catalogs per org; satellites enforce. THE ENGINE DECIDES; THE
SATELLITE ENFORCES (ADR-006 D2, contract part 3). The runtime's local
editing routes froze read-only at A-4; the console surface here is where
those edits moved TO.

## Lifecycle

```
draft ──validate──▶ publish ──▶ immutable version ──▶ fanout ledger ──▶ satellite ACK
  ▲                   ▲                                          │
  └── edited freely   └── rollback = NEW version restoring       └── re-notify /
                      an older payload (never edits a row)         delivery view
```

- **Drafts** (`config_drafts`, eng-0016): one mutable draft per
  (org × scope × product). Every save runs the strict per-scope payload
  schema and stores the verdict WITH the draft — an invalid draft persists
  (with its issue list) so operators iterate in place, but cannot publish.
- **Publish**: validated → product tag checked against the manifest
  registry → byte-identical republish of the live version rejected (409)
  → next monotonic version under a per-key advisory lock → audit →
  `config.published` engine event (org webhooks fan out) → notification
  ledger rows for every active satellite serving the product.
- **Rollback**: a NEW version whose payload restores an older version
  (`rollback_of` lineage) — history is append-only, always.
- **Retention** (`config:` worker, daily 03:40 UTC): per key only the
  newest `CONFIG_VERSION_RETENTION` versions survive (the live version is
  never eligible); ACKed notification rows age out after
  `CONFIG_NOTIFICATION_RETENTION_DAYS`. Unacked-drift detection is NOT
  here — the satellites sweeper owns `config_drift` incidents (one
  authority per fact).

## Payload validation (`payload-schemas.ts`)

Closed vocabulary per scope, mirroring what the agent-runtime actually
consumes (its policy editor input, `TenantConfig` guardrail fields,
`budgets.py` quota ladder, `model_catalog` table):

| scope | shape highlights |
| --- | --- |
| `policy_set` | `name` + `rules[]` (kind: input/output/tool/topic/safety; action: block/flag/redact/escalate; severity enum; pattern REQUIRED for pattern-driven kinds; unique rule names; ≤200 rules) |
| `guardrail_profile` | `guardrail_config` (closed key set — the 7 rails), `guardrail_thresholds` (classifier/jailbreak/pii, 0..1), `shadow_mode`, `stream_moderation_window_chars` |
| `quota_profile` | `budgets` (max_redact_iterations/max_graph_steps/max_duration_s) + `quotas` (platform/tenant/surface/end_user USD; 0 = unlimited) |
| `model_catalog` | `models[]` (unique provider/model pairs, enabled, cost ceiling, fallback order) + defaults that must reference an entry |

All schemas `.strict()` (unknown fields rejected), wire-capped at 256 KiB.
**Invalid configs cannot publish** — the same gate the runtime ran locally
(tenant_config_versions P5-2), moved to the engine side.

## Routes

**Satellite pull zone** (`config-pull.controller.ts`, L3 `engine:config:pull`
or L2 carrying it; quarantined/retired satellites refused; every pull
bumps the activity counters):

- `GET /internal/config/:orgId/bootstrap` — cold start: every key's live
  version + a ready-made cursor map (one request syncs the whole cache).
- `GET /internal/config/:orgId/latest?scope=&product=` — cache revalidate
  with HTTP conditional semantics: the ETag is the payload digest, so an
  unchanged config is a 304 with no body.
- `GET /internal/config/:orgId?scope=&product=&since=&limit=` — versioned
  catch-up; capped at 100 with `nextSince` + `hasMore` so a large catch-up
  is never silently truncated.
- `GET /internal/config/notifications/pending` — this satellite's work
  queue (its unacked ledger rows).
- `POST /internal/config/notifications/:configId/ack` — applied.

**Console zone** (`config-publish.controller.ts`, L1 + org role; live
effects additionally step-up):

- `GET /console/org/:orgId/config` — the overview: every key with live
  version, draft state, and unacked fanout count.
- `GET .../latest|history|version/:version|diff?a=&b=` — reads (reader+).
  Diff refs are versions or the literal `draft` ("preview against live").
- `GET/PUT/DELETE .../draft`, `GET .../drafts`, `POST .../draft/validate` —
  the editing loop (owner/admin; validate is developer+).
- `POST .../publish` (step-up) — inline payload or `from_draft: true`.
- `POST .../rollback` (step-up) — `{to_version}`.
- `GET .../delivery?scope=&product=&version=` — per-satellite ACK view
  with the registry's authoritative `liveness`.
- `POST .../delivery/re-notify` — re-run fanout (catches satellites
  activated after publish; ACKed targets untouched).

## Digest contract

`payload_hash` = sha256 over canonical JSON (recursively sorted keys) —
the audit chain's canonical form. Satellites verify cache integrity by
recomputing it; the `latest` ETag is exactly this value.

## Tables (engine-owned)

- `published_configs` (eng-0007, RLS org-scoped; notes + `rollback_of`
  lineage eng-0016) — append-only versioned documents per
  (org × scope × product); monotonic versions under a per-key advisory
  lock.
- `config_drafts` (eng-0016, RLS org-scoped) — the mutable draft layer;
  validation verdict stored with the payload.
- `config_notifications` (eng-0007) — the durable fanout ledger;
  `(satellite_key, acked_at)` index eng-0016 (pending scans + GC).

**Flag:** `MODULES__CONFIG_PUBLISH_ENABLED` (requires organizations +
satellites + console).

**Public interface:** `ConfigPublishService`.
