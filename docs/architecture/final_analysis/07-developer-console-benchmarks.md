# 07 — Developer-Console Benchmarks: How the Top Platforms Do Orgs, Users, and Login

**Date:** 2026-08-23
**Status:** Research findings + design addenda. Amends `06-identity-architecture.md` (the plan of record) — deltas listed in §5 and applied there.
**Question answered:** *"Anthropic has a dedicated platform — platform.claude.com (the Console) — where companies can add users. Do other top companies have the same thing? Their authentication process seems different. Research how they do it."*

**Short answer:** Yes — every serious AI platform runs a **developer console** separate from its consumer product: Anthropic Console ([platform.claude.com](https://platform.claude.com/login)), OpenAI Platform ([platform.openai.com](https://platform.openai.com/)), Google AI Studio / Vertex AI, Mistral La Plateforme, Groq Console, Z.ai/Zhipu BigModel. DeepSeek is the deliberate minimalist exception. The console is where **companies live**: orgs, invited users, roles, API keys, spend limits, and (at the enterprise tier) SSO + SCIM. Neryva Studio's admin console is exactly this artifact — the research below sharpens what it must grow into.

---

## 1. Company-by-company findings

### 1.1 Anthropic — the Claude Console (platform.claude.com)

- **Login: no passwords, at all.** The Console offers "Continue with email" (a one-time passcode to the inbox) and "Continue with SSO" — Anthropic states it is "not possible to create a dedicated password for your Console account" ([Log in to your Console account](https://support.claude.com/en/articles/13371040-log-in-to-your-console-account)). This is the most aggressive passwordless stance of any platform benchmarked.
- **Org model: Organization → Workspaces.** Workspaces group keys, spend/rate limits, and usage; one is auto-created for Claude Code ([Workspaces docs](https://platform.claude.com/docs/en/manage-claude/workspaces), [creating/managing workspaces](https://support.claude.com/en/articles/9796807-creating-and-managing-workspaces-in-the-claude-console)). Org-level roles act as a baseline; workspace roles can only *add* permissions.
- **Roles: seven, unusually granular.** Primary Owner, Admin, Billing, Developer, Limited Developer, Claude Code User, User — e.g. Billing manages payment but cannot touch the Claude Code workspace; Developer adds session traces/file download over Limited Developer's key management ([Console roles and permissions](https://support.claude.com/en/articles/10186004-claude-console-roles-and-permissions)).
- **Admin API:** members, workspaces, invites, and API keys are programmatically manageable with an Admin API key or `org:admin` OAuth token — but **owner/admin roles cannot be assigned via the API**, only in the Console UI ([User management](https://platform.claude.com/docs/en/manage-claude/user-management), [Admin API](https://platform.claude.com/docs/en/manage-claude/admin-api)). Privilege escalation is UI-only by design.
- **Enterprise tier:** SAML SSO, **SCIM 2.0 with automatic deprovisioning** when a user is removed from the IdP, JIT provisioning, domain capture, custom group-level roles ([SCIM/JIT setup](https://support.claude.com/en/articles/13133195-set-up-jit-or-scim-provisioning), [Team/Enterprise member management](https://support.claude.com/en/articles/13133750)).

### 1.2 OpenAI — the API platform (platform.openai.com)

- **Login: four methods + enterprise SSO.** Email/password, Google, Microsoft, Apple ([login page](https://platform.openai.com/login)), plus SAML SSO for Business/Enterprise workspaces. Identity binding is **one-way**: accounts created via social login or SSO can never switch to a password ([authentication methods](https://help.openai.com/en/articles/4936824-can-i-change-how-i-log-into-my-account-authentication-method), [troubleshooting auth](https://help.openai.com/en/articles/10489721-troubleshooting-authentication)).
- **Org model: Organization → Projects.** Org roles are owner/reader; project roles are owner/member; API keys are project-scoped; multi-org users select via `OpenAI-Organization` / `OpenAI-Project` headers ([managing projects](https://help.openai.com/en/articles/9186755-managing-projects-in-the-api-platform), [adding members](https://help.openai.com/en/articles/4936812-how-do-i-add-change-or-remove-members-on-my-openai-api-account)).
- **Enterprise:** SSO **with SCIM** — IdP-group membership auto-invites users to the workspace (`api.openai.com/scim/v2`); SCIM is Enterprise-gated ([identity & provisioning](https://help.openai.com/en/articles/9672121-getting-started-with-identity-and-provisioning-in-chatgpt-enterprise-edu-and-chatgpt-for-teachers)).

### 1.3 Google — the two-tier deliberate split

- **AI Studio / Gemini API:** consumer Google account + plain API keys — no orgs, no IAM ([comparison discussion](https://www.reddit.com/r/googlecloud/comments/1jfk2jb/confused_about_pricing_differences_between_vertex/), [partner guide](https://thecloudcollective.es/en/blog-entries/gemini-api-y-vertex-ai)). Prototype tier.
- **Vertex AI:** Google Cloud organization/project with **full IAM** — service accounts, fine-grained "who can do what," audit logging ([IAM-vs-keys distinction](https://note.com/uyuutosa/n/n8be20c78b5e3?hl=en)). Production tier. Google's lesson: the *same models*, two identity models, chosen by maturity of the customer.

### 1.4 DeepSeek — the deliberate minimalist

- Single-account console: sign up, top up balance, create keys ([api-docs.deepseek.com](https://api-docs.deepseek.com/), [platform](https://platform.deepseek.com/)). **No team/workspace/org features**; enterprise cooperation is "contact us" ([Terms of Service](https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html)). Proof that skipping orgs is a *strategy* (friction-minimal developer-first), not an oversight — viable only while the customer is an individual developer.

### 1.5 Z.ai / Zhipu — BigModel (bigmodel.cn) and z.ai

- Personal API keys plus **Team plans** with "flexible organization management controls" and enterprise data security; **team keys are separate from personal keys**, and team quota only flows through the dedicated team key ([Team plan benefits](https://docs.bigmodel.cn/cn/coding-plan/team), [quick start](https://docs.bigmodel.cn/cn/coding-plan/quick-start), [Z.ai docs](https://docs.z.ai/guides/overview/quick-start)). Team = billing/ownership boundary on top of personal accounts.

### 1.6 Mistral — La Plateforme

- **Org model mirrors Anthropic:** Organization → Workspaces/Teams with members, invitations, org roles, seats, groups, and user-scoped API keys — full org features gated to **Team/Enterprise plans** ([user management](https://docs.mistral.ai/admin/identity-access/user-management)).
- **SAML SSO is Enterprise-only**; accounts are provisioned at sign-in (JIT) ([SAML SSO docs](https://docs.mistral.ai/admin/set-up-organization/sign-in-method/saml-sso)).

### 1.7 Groq — the pragmatic middle

- Orgs with team settings; **Owner role configures org-level model permissions**; **spend limits are org-wide**, shared across members and org keys; **Projects** group applications/environments; login via Google, GitHub, SSO, or email ([team settings](https://console.groq.com/settings/team), [spend limits](https://console.groq.com/docs/spend-limits)). No SCIM found — the outlier weakness.

---

## 2. The comparison table

| | Anthropic Console | OpenAI Platform | Google (AI Studio / Vertex) | DeepSeek | Z.ai / BigModel | Mistral | Groq |
|---|---|---|---|---|---|---|---|
| **Login** | Email one-time code, SSO (**no passwords**) | Password, Google/Microsoft/Apple, SAML SSO | Google account (consumer vs Cloud IAM) | Email/password | Phone/email + team keys | Email, SAML SSO (Ent.) | Google, GitHub, email, SSO |
| **Org unit** | Org → **Workspaces** | Org → **Projects** | None / GCP org + IAM | **None** | Personal + **Team plan** | Org → Workspaces/Teams | Org → **Projects** |
| **Roles** | Owner, Admin, Billing, Developer, Limited Dev, CC User, User | Org: owner/reader; Project: owner/member (+Admin/Member conventionally) | IAM roles / none | none | Team roles | Org roles + seats | Owner, team roles |
| **Keys scoped to** | Workspace | Project | Project (GCP) / global (AI Studio) | Account | Team vs personal split | User / workspace | Project, org-wide limits |
| **Spend control** | Per-workspace limits | Per-project budgets | GCP quotas/billing | Prepaid balance | Team quota via team key | Per-org | Org-wide shared limit |
| **SSO / SCIM** | SAML + SCIM (Enterprise; JIT; auto-deprovision) | SAML + SCIM (Enterprise) | Cloud Identity (full) | none | enterprise via contact | SAML (Enterprise), JIT | SSO; no SCIM |
| **Admin API** | Members/invites/keys (`org:admin`); top roles **UI-only** | Members via platform + SCIM API | IAM API | none | partial | org APIs | partial |

## 3. The ten cross-cutting patterns (what "state of the art" means here)

1. **A developer console separate from the consumer product, always.** Console = orgs + keys + billing + usage; product = end-user experience. (Neryva's studio admin console already occupies this slot.)
2. **A sub-org grouping container exists at every serious platform** — workspaces (Anthropic, Mistral) or projects (OpenAI, Groq) — carrying **scoped keys, its own spend limit, and its own usage view**. DeepSeek's lack of one is its ceiling.
3. **The role set converges**: owner / admin / billing / developer / reader. Two structural rules repeat: **billing is a separate role** (financial control ≠ technical control), and the most privileged assignments are **made in the UI only** (Anthropic), never via API keys.
4. **Passwordless is proven at scale** — the most security-forward platform (Anthropic) ships a console with *no passwords*, just email codes + SSO. Where passwords exist, **social login** is standard (OpenAI ×3, Groq ×2).
5. **Identity binding is one-way** (OpenAI): a federated/social account never grows a password. No account merging ambiguity.
6. **SSO (SAML) is uniformly enterprise-tier-gated**; SCIM even more so (OpenAI, Anthropic, Mistral — yes; Groq — absent).
7. **SCIM's value is deprovisioning**: removing a user from the IdP removes them from the platform automatically. That, not the SSO login itself, is what enterprise security reviews ask for.
8. **An Admin/Org API exists** for members/invites/keys — because consoles must be automatable by customer IT.
9. **Spend/rate limits attach to the grouping unit** (workspace/project/org-wide), not just to the account — with grouped keys reporting usage per container.
10. **The tiering is deliberate**: free/individual → team → enterprise maps to *no-org → org+roles → SSO+SCIM+custom-roles*. Google makes the same split architecturally (AI Studio vs Vertex IAM) rather than by plan.

---

## 4. What Neryva already has vs. the benchmark

| Benchmark capability | Neryva today (verified in code) | Gap |
|---|---|---|
| Console artifact | Studio admin console (`frontend/` + admin routes) | none — exists |
| Org = tenant | `tenants` + RLS + `assert_tenant_access` | none — exists |
| Roles | platform RBAC (super_admin/tenant_admin/operator/auditor) | Org-membership roles (owner/admin/**billing**/developer) not yet separated from platform roles |
| API keys | hashed, scoped, tenant-bound, rate-limited, audited | **not project-scoped** |
| Sub-org container | `surfaces` (end-user deployments — a different concept) | **no developer project/workspace** |
| Step-up for privileged acts | `X-MFA-Proof` + `require_mfa_proof` (already used for policy publish) | none — exists, maps perfectly to the "UI-only privileged assignment" pattern |
| Invites | — | **no invite flow** |
| Admin (org) API | keys/policies/etc. via admin routes | members/invites API missing |
| Passwordless / social login | — | neither (design doc 06 had passwords first) |
| SSO/SCIM for customers | OIDC RP module (operator SSO) | inbound SAML/SCIM not built (planned I-4) |
| Spend per container | per-tenant quotas + spend events | per-project limits missing |

The striking result: Neryva's *platform* primitives (hashed keys, RLS, step-up MFA, audit chain, quotas) already match or exceed the benchmark's mechanics. The gaps are **organizational surface**: invites, membership roles, project-scoped keys/limits, and the login-method spectrum.

---

## 5. Design deltas applied to doc 06

These amend `06-identity-architecture.md` (edit locations noted):

- **Δ1 — Login-method spectrum (amends D2/§10.1–10.2).** Console login offers **email one-time code (passwordless) as the primary path**, password as secondary, and **federated social login (Google, GitHub) as inbound federation instances** on the existing OIDC RP module — phased after email infrastructure lands (open question Q1). Anthropic proves passwordless-first is the right default for a developer console; it also zeroes the credential-stuffing surface. Passkeys remain the endgame (unchanged). **Adopt the one-way binding rule** (no password is ever added to a federated account; account linking is explicit, not automatic).
- **Δ2 — Projects (extends §11 schema).** New `projects` table (org → projects), optional `project_id` on API keys, project tag on spend events, per-project spend/rate limits reusing the existing quota engine. Named *projects* (OpenAI/Groq) to avoid collision with our *surfaces* (end-user deployments). This is the single most valuable organizational gap to close — it is how every benchmark platform scopes keys, limits, and usage.
- **Δ3 — Invite flow (extends §11 schema).** `org_invites` (email, org_id, role, single-use hashed token, expiry, accepted_at, invited_by). Invitation-by-email is universal in the benchmark; it is also the only sanctioned path for a user to join an org (self-signup creates a personal org only).
- **Δ4 — Membership roles (refines §4/§11).** Org roles fixed to `owner | admin | billing | developer | reader` — matching the converged benchmark set; **billing is separate from admin** everywhere in the research. Platform RBAC (super_admin/tenant_admin/operator/auditor) remains the *platform-operations* axis; membership roles are the *customer-org* axis. They meet at entitlement checks, never merge.
- **Δ5 — UI-only privileged assignment (extends §7).** Assigning owner/admin membership roles and creating/removing org owners is a **console action requiring MFA proof** (the `require_mfa_proof` dependency already exists) — the code-level equivalent of Anthropic's "owner/admin not assignable via API." API keys and service tokens can never escalate org privileges.
- **Δ6 — Org Admin API (extends the public contract).** Members, invites, projects, and keys become first-class admin API resources (they largely are, for keys/policies) — scoped by org, so customer IT can automate against the same contract the console uses. Add to the missing-features register: *org admin API surface*.
- **Δ7 — Tiering made explicit (extends §7 entitlements).** The entitlement/plan lattice mirrors the benchmark's discovered tiers: **individual** (personal org, no seats) → **team** (org, seats, roles, projects) → **enterprise** (inbound SAML SSO, SCIM, custom roles, domain capture). SCIM/JIT/deprovisioning is enterprise-gated on day one — matching OpenAI/Anthropic/Mistral, and it keeps the I-4 build scoped to paying demand.
- **Δ8 — Deprovisioning semantics (extends I-4).** When SCIM lands, IdP removal must revoke sessions + keys of that user within a bounded window (Anthropic's auto-deprovisioning pattern) — specify now so `oauth_sessions`/`api_keys` carry the owner links that make it possible (already in Δ2/§11: `owner_account_id`).

## 6. The resulting Neryva console picture (one paragraph)

The studio admin console grows into the Neryva developer console exactly the way platform.claude.com relates to Claude: the product (widget/surfaces, and future products) serves end users; the console serves **customer organizations**. A customer signs up (email code → Neryva Account with a personal org), invites teammates (`org_invites`, roles owner/admin/billing/developer/reader), creates **projects** with project-scoped `nrv_live_` keys and per-project spend limits on the existing quota engine, and at the enterprise tier brings their own IdP (SAML SSO) with SCIM deprovisioning — all terminating at the platform identity plane per doc 06, with RLS and the audit chain underneath. Nothing in docs 05/06 changes structurally; this research confirms the plane model and fills in the console's organizational furniture.

---

## Sources

- Anthropic: [Console login](https://support.claude.com/en/articles/13371040-log-in-to-your-console-account) · [Console roles and permissions](https://support.claude.com/en/articles/10186004-claude-console-roles-and-permissions) · [Workspaces (platform docs)](https://platform.claude.com/docs/en/manage-claude/workspaces) · [Creating and managing workspaces](https://support.claude.com/en/articles/9796807-creating-and-managing-workspaces-in-the-claude-console) · [User management / Admin API](https://platform.claude.com/docs/en/manage-claude/user-management), [Admin API](https://platform.claude.com/docs/en/manage-claude/admin-api) · [SCIM/JIT provisioning](https://support.claude.com/en/articles/13133195-set-up-jit-or-scim-provisioning) · [Team/Enterprise members](https://support.claude.com/en/articles/13133750) · [Claude account login](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account)
- OpenAI: [Managing projects](https://help.openai.com/en/articles/9186755-managing-projects-in-the-api-platform) · [Adding members](https://help.openai.com/en/articles/4936812-how-do-i-add-change-or-remove-members-on-my-openai-api-account) · [Authentication methods](https://help.openai.com/en/articles/4936824-can-i-change-how-i-log-into-my-account-authentication-method) · [Troubleshooting auth](https://help.openai.com/en/articles/10489721-troubleshooting-authentication) · [Identity & provisioning (SSO+SCIM)](https://help.openai.com/en/articles/9672121-getting-started-with-identity-and-provisioning-in-chatgpt-enterprise-edu-and-chatgpt-for-teachers) · [Login page](https://platform.openai.com/login)
- Google: [Vertex vs AI Studio pricing/quota discussion](https://www.reddit.com/r/googlecloud/comments/1jfk2jb/confused_about_pricing_differences_between_vertex/) · [IAM vs API keys](https://note.com/uyuutosa/n/n8be20c78b5e3?hl=en) · [Partner comparison](https://thecloudcollective.es/en/blog-entries/gemini-api-y-vertex-ai)
- DeepSeek: [API docs](https://api-docs.deepseek.com/) · [Platform](https://platform.deepseek.com/) · [Terms of Service](https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html)
- Z.ai / Zhipu: [Team plan benefits](https://docs.bigmodel.cn/cn/coding-plan/team) · [Quick start (team keys)](https://docs.bigmodel.cn/cn/coding-plan/quick-start) · [Z.ai developer docs](https://docs.z.ai/guides/overview/quick-start) · [BigModel](https://bigmodel.cn/)
- Mistral: [User management](https://docs.mistral.ai/admin/identity-access/user-management) · [SAML SSO](https://docs.mistral.ai/admin/set-up-organization/sign-in-method/saml-sso)
- Groq: [Team settings](https://console.groq.com/settings/team) · [Spend limits](https://console.groq.com/docs/spend-limits)
