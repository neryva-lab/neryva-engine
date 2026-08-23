# engine/src — the TypeScript core

The Neryva engine core (ADR-005/006): identity, organizations, corporate
(email seed), and the shared kernel. Console, agent-studio furniture,
billing, and deployment land in later phases per
[`docs/dev/ENGINE-EXECUTION-PLAN.md`](../docs/dev/ENGINE-EXECUTION-PLAN.md).

## Layout

See [`docs/technology/structure.md`](../docs/technology/structure.md) for the
full module map. Kernel (`src/common`) imports no module; modules bind the
kernel's ports (`SESSION_REGISTRY_PORT`, `SERVICE_CLIENT_PORT`,
`ORG_ACCESS_PORT`).

## Boot

```bash
cp .env.example .env          # fill DATABASE_URL, REDIS_URL, secrets
pnpm install
pnpm migrate                  # applies drizzle/ (eng-0001, eng-0002)
pnpm dev                      # tsx watch
```

Flags: `MODULES__{CORPORATE,IDENTITY,ORGANIZATIONS}_ENABLED`. The boot-time
flag matrix refuses invalid combinations (identity requires corporate;
organizations requires identity).

## Generate the OP signing key (development)

```bash
mkdir -p secrets
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out secrets/oidc-signing.pem
openssl rand -base64 48 > secrets/mfa-proof.key
# .env: IDENTITY_ALLOW_DEV_KEYS=true  (or set the file path directly)
```

Production: `IDENTITY_JWT_SIGNING_KEY_FILE` + `IDENTITY_COOKIE_KEYS` are
required — the OP refuses auto-generated keys.

## Notes for the first build (owner will fix on install)

- `oidc-provider` option names follow v8/v9; if the installed major renamed
  `issueJWTAccessToken` or the `pkce.required` signature, adjust only
  `oidc-provider.factory.ts` (single configuration point).
- drizzle `meta/` snapshot files were not hand-authored; if
  `drizzle-kit generate` complains, regenerate snapshots against the same
  schemas — the SQL in `drizzle/` is the applied truth.
- The migrations touch ONLY engine-owned tables (verify against
  `ownership-map.json`).
