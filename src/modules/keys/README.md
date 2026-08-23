# keys (`src/modules/keys`)

**Purpose:** engine side of handover A-1 (key/token authority): the engine
becomes the issuer of `nrv_live_` org API keys while the Python runtime
keeps verifying them — the documented dual-write window on the Python-owned
`api_keys` table (ownership-map.json; the runtime's own writes retire at
the A-1 flip).

**Routes:**
- `GET/POST /console/org/:orgId/keys`, `POST .../keys/:keyId/revoke` — L1 +
  owner/admin/developer (billing may list); creation requires a step-up MFA
  proof (stricter than the matrix minimum, deliberately). The raw key is
  returned exactly once on issue; there is no read-back path.
- `POST /internal/keys/validate` — L3 (`engine:keys:validate`) or L2: the
  satellite posts the SHA-256 it computed; the answer carries
  `cache_ttl_seconds` (15 positive / 5 negative) — the revocation
  propagation bound. Only hashes cross this boundary, never key material.

**Tables:** none owned — writes the shared `api_keys` (Python TenantModel-
compatible column set; project-scoped keys ride the engine-owned
`studio_project_keys` binding, eng-0006, until Alembic 0017 adds the
columns).

**Flag:** `MODULES__KEYS_ENABLED` (requires organizations).

**Key format:** `nrv_live_` + 32 bytes base64url; SHA-256 at rest — byte-
compatible with the Python engine so both verifiers resolve the same rows.

**Public interface:** `KeysService`.

## Full key lifecycle (gap K-1…K-4, K-6 — the OpenAI/Stripe-grade surface)

- **Rotation (Stripe semantics):** `POST …/keys/:keyId/rotate` — the SAME key
  identity (id, name, scopes, project binding) gets a fresh secret; the old
  secret dies this instant (revocation feed spreads it; the 15s validation
  cache is the bound). Step-up gated; new key shown exactly once.
- **Update (K-1):** `PATCH …/keys/:keyId` — rename and/or rescope without
  revoke+reissue. Scope rules enforced (wildcard cannot mix); step-up gated.
- **Project binding at issue (K-2):** `POST …/keys` accepts `project_id` —
  one step instead of create-then-bind (rides the engine-owned binding
  table; the api_keys columns wait on Alembic 0017 per the ownership map).
- **Per-key detail (K-3):** `GET …/keys/:keyId` — the "what is this key
  doing" view: metadata, days-to-expiry, usage counters, project binding,
  and the key's full event trail from the audit chain (issued/updated/
  rotated/revoked, filtered by resource_id).
- **Expiring-key alerts (K-4):** a daily keys-namespace worker scans keys
  inside the 14-day horizon and notifies each org's owner/admin (severity
  escalates ≤3 days).
- **Key events to owners (K-6):** issue/revoke/rotate land in the org's
  notification center (owner/admin) via the notifications module —
  instant, not audit-archaeology.
- **Bulk validation:** `POST /internal/keys/validate-batch` (L3
  `engine:keys:validate`, ≤200 hashes) — satellite cache warm-up and
  startup reconciliation in one round-trip.
