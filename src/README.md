# engine/src — the TypeScript core

The Neryva engine core (ADR-005/006): identity, organizations, corporate
(email + public forms + content), the console control plane, billing &
metering, the agent-studio product furniture, and the deployment product —
on the shared kernel. Phase order:
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
pnpm migrate                  # applies drizzle/ (eng-0001…eng-0006)
pnpm dev                      # tsx watch
```

Flags: `MODULES__{CORPORATE,IDENTITY,ORGANIZATIONS,CONSOLE,BILLING,
AGENT_STUDIO,DEPLOYMENT}_ENABLED`. The boot-time flag matrix refuses invalid
combinations (identity requires corporate; organizations requires identity;
console requires organizations; billing requires console + organizations;
agent-studio and deployment each require console + billing).

## Contract composition (C-2')

```bash
npx tsx scripts/export-openapi.ts var/engine-openapi.json
npx tsx scripts/compose-contract.ts \
  --runtime ../contracts/openapi/openapi.v1.json \
  --engine var/engine-openapi.json \
  --out ../contracts/openapi/openapi.composed.v1.json
```

The composed contract carries `x-neryva-owner` on every path and fails on
unowned paths, collisions, or missing routes of stage-ga manifests.

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
- Public-form DTOs rely on `class-validator`/`class-transformer` being
  installed for the global ValidationPipe (they are in package.json).
