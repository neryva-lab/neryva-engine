# Console Access Model — Who Sees and May Do What

**Status:** Plan of record · **Date:** 2026-08-23 · **Bound by:** [ADR-001](../decisions/ADR-001-account-model.md) (contexts), [ADR-002](../decisions/ADR-002-product-taxonomy.md) (register), final_analysis 06 §7 + 07 Δ4/Δ5 (roles, step-up)

## The three authorization axes (composed, never merged)

1. **Membership role** (org axis): `owner | admin | billing | developer | reader` — the converged benchmark set (final_analysis 07 pattern #3).
2. **Entitlement state** (product axis): `none | trial | active | past_due | suspended | expired` — per (org × product), platform-owned state machine.
3. **Product scopes** (capability axis): each product's manifest scopes (e.g. `deployment:operate`); API keys and sessions carry only the scopes their product grants.

A request succeeds only if all three axes pass: right role → org has the product in a usable state → principal holds the scope. Platform RBAC (`super_admin/tenant_admin/operator/auditor`) remains the separate **Neryva-staff** overlay; it never appears in customer orgs.

## The org-level permission matrix

| Capability | owner | admin | billing | developer | reader |
|---|---|---|---|---|---|
| View console home + product cards (owned) | ✓ | ✓ | ✓ | ✓ | ✓ |
| View product console pages | ✓ | ✓ | ✓ | ✓ | ✓ (read-only) |
| Manage product resources (agents, pipelines, policies…) | ✓ | ✓ | — | ✓ | — |
| Create/rotate API keys, manage projects | ✓ | ✓ | — | ✓ | — |
| Invite members / assign roles | ✓ | ✓ | — | — | — |
| Assign owner/admin roles | ✓ **UI-only + MFA proof** (Δ5) | — | — | — | — |
| Start trial / change plan / purchase | ✓ | — | ✓ | — | — |
| View billing & invoices | ✓ | ✓ | ✓ | — | — |
| View audit log | ✓ | ✓ | ✓ | ✓ | — |
| Delete org / transfer ownership | ✓ (MFA proof) | — | — | — | — |

Billing is deliberately separated from admin (benchmark pattern): finance people manage money, not pipelines; admins manage people and products, not payment methods.

## Entitlement-state rendering (what "not bought yet" means in the UI)

| State | Product card | Product pages | API/runtime |
|---|---|---|---|
| `none` | Brief + **[Start trial]** (owner/billing) or "Ask your admin" (others) | Marketing brief + docs link | 403 `entitlement_required` |
| `trial` | Summary + days-left banner | Full access + trial banner | Allowed; usage capped by trial limits |
| `active` | Full summary | Full access | Allowed |
| `past_due` | Summary + payment alert banner | Read-only + billing CTA | Read-only; writes 402 |
| `suspended` | Summary + suspended banner | Read-only | Read-only |
| `expired` | Brief + **[Renew]** | Read-only export view | 403 |

Rules: **every registered product is always visible** (discovery is the growth loop); nothing ever dead-ends (read-only + CTA, never 404); runtime denials carry machine-readable codes so products' SDKs can render upgrade prompts.

## Cross-product and consumer boundaries

- **No cross-product calls** between product modules (ADR-003 enforcement); if Agent Studio wants deployment info (e.g. "this agent is deployed to production"), it reads the *public contract* as any customer program would, with an L3 service token — audit trail shows the acting product.
- **Consumer context never sees org data** (ADR-001): chat sessions, personal workspaces; org entitlements are invisible there. Conversely the console never shows consumer-chat content (support staff use the support tooling, not the console, to inspect consumer conversations — and only through the governance/policy path).
- **Enterprise tenants** additionally gate console access behind their IdP: SSO-required orgs reject password logins; SCIM removal revokes sessions + org keys within a bounded window (07 Δ8).

## Step-up (MFA proof) triggers — the privileged-act list

Owner/admin role assignment · ownership transfer · org deletion · plan purchase/change · key creation with `*` scopes · policy publish (already live). Implementation: the existing `require_mfa_proof` dependency (06 §7); the list above is configuration, not new machinery.

## Anonymous and end-user traffic — out of scope by design

Nothing in this file applies to L4 end-user tokens or L5 agent identities — those authorize against surfaces and narrow machine scopes respectively (final_analysis 06 §6). The console is exclusively an L1 surface. This separation is what keeps one permission model from slowly absorbing another.
