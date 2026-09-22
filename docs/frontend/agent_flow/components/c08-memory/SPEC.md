# C08. Memory — SPEC (STATUS: SIGNED OFF 2026-09-18)

> Design position: Safety/Memory node. Depends on: C01. BLOCKED on its open question — resolve before designing.

## Engine binds (verified 2026-09-17)

- Per-agent (version payload): `memory_scope` enum user|organization|conversation|none, engine default `user` (`validation.ts:63-66`); `history_limit` 1–100, default 30; `summary_enabled` default true (`validation.ts:60-61`).
- **Org-level (NOT per-agent): `org_settings.preferences.memory_pii_scrubbing` (off|redact|block) and `memory_ttl_default_seconds` (3600–315360000, floored) (`org-settings.service.ts:356-377`).** Scrub runs before embed on both write paths; purge is `POST .../memories/purge`. The builder shows these as read-only org defaults + route to Admin › Settings — never as per-agent controls.
- Row shape (`knowledge/schema.ts:205-237`): scope_type organization|conversation|assistant|user; visibility (default `organization` — NOT retrieval_acl); expires_at/deleted_at; valid_from/invalid_at/supersedes (temporal); confidence/provenance/source_ref.
- Placement (locked): **Libraries → Memory**, scope-aware (organization/user/assistant browsable; conversation-scoped on the conversation/trace or nowhere in v1, stated). Policy defaults + DSR entry in Admin › Settings. Builder inspector owns scope/history/summary (`agent`), shows in-scope items read-only, routes purge/TTL/ACL to the library (`governance`).
- Memory proposals: approve/reject queue (surfaced via the Approvals destination — aggregate-if-proven-non-empty, never an empty filter), nothing auto-accepts. Soft-delete with copy.

## Design (built 2026-09-18 — PLAN.md FINAL, all traces verified)

- [x] Scope control with plain-words consequences per scope.
  4 pills (user default first, never omitted) with FL-1.5 consequences.
- [x] History stepper (1–100) + summarization toggle.
  Stepper ships WITH the served-20 whisper (validation accepts 100, runs serve 20).
  Toggle does NOT ship: `summary_enabled` is stored but read nowhere engine-side —
  a toggle would invent control; compaction stated read-only.
- [x] Org-default scrub/TTL read-only rows + settings route + purge entry point.
  Policy strip in library + read-only rows in builder/panel; purge entry is real
  (POST memories/purge, owner/admin, 3–128, tombstone, hash-audit). Policy authoring
  has no console editor — read-only + links, logged.
- [x] Library posture: scope filter (organization/user/assistant) + assistant-scoped deep-links to their agent; explicit decision on user-scoped CONTENT vs metadata readability (`visibility` defaults to `organization` — DSR-relevant, not display detail); proposals queue names its approver role.
  Scope filter + `?scope=assistant&scope_id=` deep-link built; user content shown
  (list endpoint returns it to reader roles — subtitle warns it is shared); NO
  proposals queue exists to name a role for — no list endpoint anywhere, Approvals
  aggregation declined, stated once in the footer.

## Open questions

- ~~**RESOLVE FIRST: `user` scope.**~~ RESOLVED 2026-09-18: 4 scopes ship, `user`
  default and offered (engine `validation.ts:63-66`; contract `v1.schema.json:104-109`;
  runtime `mcp-authority.service.ts:2036-2144`). The "omit user" guidance is stale.
  Console repairs: `MEMORY_SCOPES += 'user'`, false caps issue deleted,
  `defaultConsumer` → `'user'`, parse garbage → `'user'`.

## Exit gate

- Per `../README.md` component gate. Flip status to SIGNED OFF with date.
