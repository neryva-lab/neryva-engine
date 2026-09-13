# ADR-014: Conversational End-Users Stay Out of the `accounts` Registry

- Date: 2026-09-13
- Status: accepted
- Deciders: Engine platform team
- Scope: `auth_plan.md` (D6, §2 F9), `auth_ledger.md` (AUTH-5.1), `src/modules/conversations/schema.ts`, `src/modules/channels/`

## Context

The platform has several user classes and exactly one human credential store:

- **Console humans** (customer org members and Neryva platform staff) authenticate to the control plane. They live in `accounts` (`src/modules/identity/schema.ts`) — the platform-plane, engine-only-writer registry — and get authority from binding rows at the edges (`org_memberships`, `platform_staff`), never from columns on the account.
- **Conversational end-users** — people chatting with a deployed assistant over the website widget or a channel (WhatsApp/Messenger/Telegram/Instagram/X/email) — never authenticate to the control plane. They are `conversation_participants` rows (`participant_type = account | service | channel`, `external_ref` for channel senders, `src/modules/conversations/schema.ts:39`) and ephemeral channel senders. Widget sessions are hash-at-rest with `nk_live_` public keys; channel senders are platform ids.

Nothing prevents a team from slowly merging these populations — an FK from participants into `accounts` here, an auto-provisioned account on first WhatsApp message there — which is the failure mode this ADR forecloses.

## Decision

**Conversational end-users are not identities.** They stay in `conversation_participants` and channel-sender surfaces, permanently excluded from `accounts`:

1. No foreign key from any participant, sender, or widget-session surface into `accounts`.
2. No auto-provisioning of `accounts` rows from channel or widget identities — an inbound message never creates an account.
3. No reuse of `accounts` rows as end-user profiles (display names, avatars, preferences).
4. If a consumer-facing account product ever becomes real (end-users logging into a portal), that is a **new audience dimension on the registry** designed by a new ADR at that time — not a gradual blurring of this boundary.

The rationale is the same isolation logic that keeps `accounts` platform-plane: the credential store holds only principals that authenticate to the control plane. Pulling millions of ephemeral channel participants into it would bloat the credential store, drag end-user data into the account-deletion/purge workflows (retention, exports, legal holds), and couple channel-spam dynamics to the identity lifecycle.

## Consequences

- Widget/channel session and sender keys remain scoped to their own surfaces (widget: hash-at-rest sessions, Origin allowlist, per-session caps; channels: platform sender ids on `channel_message_links`/`message_receipts`).
- Cross-referencing stays by opaque ids + conversation-scoped rows (invariant 3's tenant-bound key discipline), never by identity joins.
- End-user PII in conversations is already governed by the conversation-plane retention/redaction machinery (guardrails spotlighting, message retention); it does NOT inherit account lifecycle (account deletion, email change) because no such link exists.

## Alternatives Considered

- **Auto-provision an `accounts` row per channel sender** (the "identity per phone number" model some chat vendors use) — rejected: couples the credential store to channel spam dynamics, drags end-user rows into purge/retention/legal-hold workflows, and buys nothing the participant row doesn't already carry.
- **A second registry for end-users** — rejected: no product requires end-user login; a second registry before the requirement is speculative schema.
- **An `audience` column on `accounts` admitting both populations** — rejected for v1: same coupling as auto-provisioning with extra columns. Revisit via a new ADR only when a consumer account product is real.

## Related decisions in the same wave (auth_plan.md, 2026-09-13)

- **D1 — platform staff subsystem:** the staff axis is a *binding* on the same registry (`platform_staff`, drizzle/0043), resolved per request through `PlatformStaffDirectoryPort` (kernel-level; the JWT `platform_role` claim is an optimization). The kernel provider list gains the directory — justified here per `kernel.module.ts`'s locked-list rule.
- **D2 — exactly-one-owner:** enforced by the partial unique index `uq_one_active_owner_per_org` (drizzle/0044) with demote-then-promote single-transaction transfer. A deferred constraint trigger enforcing *exactly one* owner at COMMIT was rejected: it would break the org purge (all memberships deleted ⇒ count 0 ⇒ commit exception). `DEFERRABLE` is not valid on `CREATE INDEX` (PostgreSQL grammar) and is unnecessary with demote-first ordering.
- **D3 — team-org creation:** `POST /console/org` reuses the documented `tenants` INSERT seam atomically with the owner membership and an eager `org_settings.kind='team'` row; personal orgs remain the ADR-001 default.
- **D4 — credential consolidation:** `account_credentials` is the single factor registry (drizzle/0046 expand, 0047 contract drops `accounts.password_hash`); uniqueness via partial unique indexes (version-independent; a composite `UNIQUE(account_id, kind, credential_id)` would lose password uniqueness to NULL-distinctness without PG15+ `NULLS NOT DISTINCT`).
- **D5 — seat wall:** enforced at membership grant inside the granting transaction, serialized by `FOR UPDATE` on the seat-bearing entitlement rows (drizzle 0046 note: no DDL needed).

## References

- `auth_plan.md` (design authority), `auth_ledger.md` (AUTH-1.1 … AUTH-5.2)
- `adr-001-modular-monolith-roles.md` (personal-org autocreation), `adr-002-tenant-model-rls.md`, `adr-008-identity-provider-integration.md`
- `kernel.module.ts` (locked provider list — directory addition justified above)
