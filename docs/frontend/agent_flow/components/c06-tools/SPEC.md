# C06. Tools — SPEC (STATUS: SIGNED OFF 2026-09-17)

> Design position: behavior section (model + tools + advanced). Depends on: C01. Builder invents no tools — catalog attach only.

## Engine binds (verified 2026-09-17)

- Entries: **max 32** (contract; engine 50 — 32 wins). Per entry: name min 2 max 64 `^[a-z0-9_]+$`; access read|write; approval required|optional (default optional); schema_hash 64hex optional; execution_mode live|shadow (default live) (`validation.ts:68-87` + contract).
- Approval vocabulary mapping is CENTRAL (one module, never per view): consumer never→optional/none, on_effect|always→required (+ catalog REQUIRED).
- Effect class lives on the catalog row, never on the entry. Schema drift (mutated/absent) rejects publish → re-pin flow.
- **Perimeter (P4), first-class on every row**: execution_environment in_process|sandboxed_microvm|external_gateway (default in_process); allowed_egress_domains 1–32 hostnames, must cover the binding host; in_process must NOT declare egress (`tool-catalog.service.ts:104-160`, `manifest-resolution.service.ts:61-64,220-301`).
- **Shadow bindings**: simulated result, executes nothing; authorize path denies on perimeter drift (`mcp-authority.service.ts:1376-1382`).
- Tool writes: upsert/from-template = owner,admin,developer; enabled-toggle = owner,admin. Credential shown never.

## Design (built 2026-09-17 — PLAN.md FINAL, all traces verified)

- [x] Catalog drawer rows: name, effect class, approval requirement, enabled, credential, schema-pin state, environment, egress, shadow badge.
- [x] Tool chips on the map with approval/effect/shadow/drift states.
- [x] Drift → review-change → re-pin flow. Approval-required → request/approve inline (display + Approvals deep link — no pre-approve endpoint exists).
- [x] Remove = unpin only (microcopy).
- [x] Entry-name rule resolved: catalog `^[a-z][a-z0-9_]{1,63}$`, entries contract `^[a-z0-9_]+$` min 2, never leading-letter.
- [x] Perimeter default corrected: catalog `external_gateway` (built-ins `in_process`); effective environment shown, never default-claimed.
- [x] Console `execution_mode` gap closed (type + both mappings + tests); `effectiveApproval` understated cell fixed.
- [x] Builder satellite grading (ready/attention/info) + read-only detail panel + Tools library keep-and-extend (filters, drawer, edit, per-row pending, rate validation, perimeter).

## Open questions

- ~~**Tool-name leading-letter rule UNVERIFIED** (README correction 12). Do not enforce `^[a-z]…` until proven; contract regex governs.~~
  RESOLVED 2026-09-17: catalog names REQUIRE leading letter (`tool-catalog.service.ts:47,434`,
  console `TOOL_NAME_PATTERN` mirrors it); consumer entry names contract-only (`^[a-z0-9_]+$`,
  min 2 — engine min 1, no regex). Two objects, two rules. README correction 12 stands (never
  enforce leading-letter on entries).

## Exit gate

- Per `../README.md` component gate. Flip status to SIGNED OFF with date.
