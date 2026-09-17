# C08. Memory — SPEC (STATUS: NOT STARTED)

> Design position: Safety/Memory node. Depends on: C01. BLOCKED on its open question — resolve before designing.

## Engine binds (verified 2026-09-17)

- Per-agent (version payload): `memory_scope` enum user|organization|conversation|none, engine default `user` (`validation.ts:63-66`); `history_limit` 1–100, default 30; `summary_enabled` default true (`validation.ts:60-61`).
- **Org-level (NOT per-agent): `org_settings.preferences.memory_pii_scrubbing` (off|redact|block) and `memory_ttl_default_seconds` (3600–315360000, floored) (`org-settings.service.ts:356-377`).** Scrub runs before embed on both write paths; purge is `POST .../memories/purge`. The builder shows these as read-only org defaults + route to Admin › Settings — never as per-agent controls.
- Row shape (`knowledge/schema.ts:205-237`): scope_type organization|conversation|assistant|user; visibility (default `organization` — NOT retrieval_acl); expires_at/deleted_at; valid_from/invalid_at/supersedes (temporal); confidence/provenance/source_ref.
- Placement (locked): **Libraries → Memory**, scope-aware (organization/user/assistant browsable; conversation-scoped on the conversation/trace or nowhere in v1, stated). Policy defaults + DSR entry in Admin › Settings. Builder inspector owns scope/history/summary (`agent`), shows in-scope items read-only, routes purge/TTL/ACL to the library (`governance`).
- Memory proposals: approve/reject queue (surfaced in the ONE Approvals queue with kind filter), nothing auto-accepts. Soft-delete with copy.

## Design (fill in the C08 pass — AFTER the open question)

- [ ] Scope control with plain-words consequences per scope.
- [ ] History stepper (1–100) + summarization toggle.
- [ ] Org-default scrub/TTL read-only rows + settings route + purge entry point.

## Open questions

- **RESOLVE FIRST: `user` scope.** Engine default and valid enum value is `user`; older consumer docs say omit it. Check the console mapping module + Studio contract, then record the exact 3-or-4 scope options and their consequences here. No scope control ships until this line is answered.

## Exit gate

- Per `../README.md` component gate. Flip status to SIGNED OFF with date.
