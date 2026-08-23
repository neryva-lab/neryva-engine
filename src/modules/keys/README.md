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
