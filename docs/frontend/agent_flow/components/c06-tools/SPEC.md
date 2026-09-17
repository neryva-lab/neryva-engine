# C06. Tools — SPEC (STATUS: NOT STARTED)

> Design position: Behavior ("Hands"). Depends on: C01. Builder invents no tools — catalog attach only.

## Engine binds (verified 2026-09-17)

- Entries: **max 32** (contract; engine 50 — 32 wins). Per entry: name min 2 max 64 `^[a-z0-9_]+$`; access read|write; approval required|optional (default optional); schema_hash 64hex optional; execution_mode live|shadow (default live) (`validation.ts:68-87` + contract).
- Approval vocabulary mapping is CENTRAL (one module, never per view): consumer never→optional/none, on_effect|always→required (+ catalog REQUIRED).
- Effect class lives on the catalog row, never on the entry. Schema drift (mutated/absent) rejects publish → re-pin flow.
- **Perimeter (P4), first-class on every row**: execution_environment in_process|sandboxed_microvm|external_gateway (default in_process); allowed_egress_domains 1–32 hostnames, must cover the binding host; in_process must NOT declare egress (`tool-catalog.service.ts:104-160`, `manifest-resolution.service.ts:61-64,220-301`).
- **Shadow bindings**: simulated result, executes nothing; authorize path denies on perimeter drift (`mcp-authority.service.ts:1376-1382`).
- Tool writes: upsert/from-template = owner,admin,developer; enabled-toggle = owner,admin. Credential shown never.

## Design (fill in the C06 pass)

- [ ] Catalog drawer rows: name, effect class, approval requirement, enabled, credential, schema-pin state, environment, egress, shadow badge.
- [ ] Tool chips on the map with approval/effect/shadow/drift states.
- [ ] Drift → review-change → re-pin flow. Approval-required → request/approve inline.
- [ ] Remove = unpin only (microcopy).

## Open questions

- **Tool-name leading-letter rule UNVERIFIED** (README correction 12). Do not enforce `^[a-z]…` until proven; contract regex governs.

## Exit gate

- Per `../README.md` component gate. Flip status to SIGNED OFF with date.
