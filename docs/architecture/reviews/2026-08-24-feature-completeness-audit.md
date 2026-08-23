# Feature-Completeness Audit — 2026-08-24

**Scope:** every module under `src/modules/**` + cross-cutting planes (events, env, queues,
migrations, routes, metrics), audited after the corporate-v2, config-publish-v2 and
satellites-dense waves. Method: five independent sweeps (billing/payments ·
identity/keys/orgs · deployment/studio/console · satellites/config-publish/corporate/
webhooks/notifications/staff · cross-cutting), every finding verified against code with
file:line evidence; the BLOCKER/HIGH findings were independently re-verified by a second
pass before inclusion. **Process items are banned from this document** — uncommitted trees,
missing installs, absent tests and CI are tracked elsewhere; every item below is a
functional feature gap.

Severity key: **BLOCKER** = a promised surface is unreachable or a running system breaks.
**HIGH** = a documented duty/decision has no working implementation. **MEDIUM** = the
feature exists but is functionally incomplete or wrong end-to-end. **LOW** = fidelity/
ergonomics gap against the module's own contract.

---

## BLOCKERS

| # | Feature | Evidence | Impact |
|---|---|---|---|
| **B-1** | **The billing money layer (eng-0014) is unwired — and it breaks module boot** | `billing.module.ts:32-34` registers neither `BillingExtensionController` (imported at line 9) nor `BillingCreditsService`/`BillingCycleService` (imported at lines 7-8) in controllers/providers; `BillingWorker` (billing.worker.ts:29-33) injects both plus `NotificationsService`, none resolvable inside `BillingModule` (NotificationsModule not imported) | With `MODULES__BILLING_ENABLED` the module cannot instantiate. Even once registered: credit grants/budgets/adjustments/exports endpoints unreachable today, month-end auto-invoicing and hourly budget-eval jobs can never run |
| **B-2** | **Cost-anomaly alert reaches no recipient — payload shape mismatch** | `anomaly.service.ts:118` emits `('billing.cost_anomaly', { anomalies })` — orgId only exists per-element; the notifications subscriber (`notifications.service.ts:40-42`) reads a top-level `event.orgId` that is `undefined`; the webhook bridge (`webhooks.service.ts:64-68`) drops the event (`if (orgId)` fails) | The B-5 gate is met only in the audit log: no in-app notification, no email, and orgs subscribed to `billing.cost_anomaly` webhooks never receive a delivery |

## HIGH

| # | Feature | Evidence | Impact |
|---|---|---|---|
| **H-1** | **No payment-provider integration (recorded Stripe decision has zero code)** | `grep -ri stripe src/` → two comments only; no PaymentIntent creation, payment webhook endpoint, signature verification, or dunning anywhere; the sole path to `paid` is the manual `POST .../invoices/:id/pay` (billing.controller.ts:75-79) which the README itself says must be replaced by webhook confirmation | Money can never actually be collected or externally confirmed — invoices are records without a payment rail |
| **H-2** | **Console audit surface: compile error + duplicate route pair** | `console-platform.controller.ts:122` passes an undeclared `before` identifier (no `@Query('before')` param, no import — TS2304); the same file also re-registers `GET console/org/:orgId/audit` and `.../audit/export` already served by `org-audit.controller.ts:22,51` — identical method+path twice | The audit endpoint cannot compile as written; after fixing, the duplicate pair means one query contract (`actor_id`/`offset`) silently never serves, or Fastify route-conflict at boot depending on order |
| **H-3** | **Trials never expire** | `entitlement.guard.ts:48-56` denies only `none`/`expired`; `periodEnd` never consulted for `trial` state; the only writer of `expired` in the codebase is org deletion (`org-lifecycle.service.ts:94`); no worker sweeps `period_end` | A 14-day studio or 30-day deployment trial stays fully entitled forever — plan clocks are display-only |
| **H-4** | **No plan-change / upgrade / renewal surface for any product** | The only `entitlements.transition` callers are the two trial starts (`studio.controller.ts:87`, `deployment.controller.ts:97`) and org deletion; `billing.controller.ts:15-16` defers purchases to "the entitlement plane" — where no endpoint exists | There is no API path to become a paying customer: trial→active, studio-team→enterprise and deployment-usage→pro upgrades are all impossible; pro plans are dead catalog entries |
| **H-5** | **Login-time MFA challenge missing** | `login-interaction.controller.ts:183-209` (`finishLogin`) issues the session straight after password/email-code verification; zero `mfa|totp` matches in the login controller or OIDC factory; `mfaLevel` is read only by status surfaces | A user who enrolled TOTP gets no protection at login — TOTP is a step-up token mint, not authentication MFA; a stolen password still yields a full L1 session |
| **H-6** | **Account deletion (GDPR right-to-erasure) absent** | proof-of-absence: no `DELETE /auth/me`, no anonymize/disable endpoint anywhere in identity (only FK cascade declarations) | No self-service account deletion — a compliance blocker for EU-facing operation; personal data orphans indefinitely |
| **H-7** | **Account email change absent** | `PATCH /auth/me` accepts only `display_name` (`account.controller.ts:93-101`); email is the sole identity key | A user who loses a mailbox can never migrate their account |
| **H-8** | **Career attachments are a dead field** | `dto.ts:81-84` documents `file_ref` as "presigned upload result"; grep across src for `presign|multipart|FileInterceptor|signedUrl|s3` matches only that comment; stored raw (`careers.service.ts:203`) and echoed back (:231) | Applicants can never actually attach a resume — the field persists an arbitrary client string nothing issues, serves, or validates |

## MEDIUM

| # | Feature | Evidence | Impact |
|---|---|---|---|
| **M-1** | Quota reservations are never released or reconciled | `quota.service.ts` is INCR-only (`checkAndReserve`); no release/refund; deployment reserves per run with no release on failure; no reconciliation against `billing.spend_events` | Redis month counters monotonically overcount — legitimate usage gets falsely capped as the month progresses |
| **M-2** | Voiding an invoice permanently destroys applied credit | `returnCreditFromInvoice` (billing-credits.service.ts:129-140) has zero callers; `invoices.service.ts:139-145` voids without touching credits despite the service's own reversibility contract | A voided invoice silently burns the customer's granted credit |
| **M-3** | Entitlement seats never gate joining | `invites.service.ts:84-92` checks only the pending cap; `memberships.service.ts:241-249` checks only `ORG_MAX_MEMBERS` ("seats are billing's" per its own comment); `product_entitlements.seats` surfaced but never consulted | An org on a 5-seat paid plan can invite up to the platform-wide cap — purchased seats don't gate membership |
| **M-4** | Satellite lifecycle events have zero consumers | 10 events (`SatelliteQuarantined/Draining/Retired/LivenessLost/ConfigDrift/...`) emitted (`satellite-registry.service.ts`, `satellite-sweeper.worker.ts:138,195`); no `events.on` subscriber exists — the "status center, notifications" consumers named in `event-bus.ts:81` don't exist | Satellite outages, quarantines and config drift never reach any notification or webhook fan-out — the signal path is dead code |
| **M-5** | Org membership/invite events have zero consumers | 11 events (`OrgMemberAdded/Removed/Suspended`, `OrgInviteCreated/Accepted/Revoked`, `OrgSettingsUpdated`, `ServiceAccountTokenRotated`, `OrgPurged`, `OrgDeletionCancelled`) emitted, none subscribed; event-bus comments claim "notifications subscribe" | Members/invitees get no in-app or email notice from the event path; `ServiceAccountTokenRotated` and `OrgPurged` — security-relevant and destructive — fan out to nobody |
| **M-6** | Deployment success/rollback produce no in-app notification | `notifications.service.ts:88` subscribes `DeploymentFailed` only; its own docstring (:24) promises `deployment.failed/rolled_back`; `DeploymentRolledBack` emitted at `deployment.workflow.ts:459` | A nighttime auto-rollback is invisible in-console unless the org configured a webhook |
| **M-7** | Notification preferences / opt-out absent | Only list/read/read-all routes exist; no preference model anywhere; rows force-written to every matching role with automatic warn/error email | Recipients cannot mute kinds or decline email fan-out |
| **M-8** | Webhook replay/redelivery absent | Route set ends at test/deliveries; dead is terminal after 5 attempts (`webhooks.service.ts:37-38,276-293`) | An endpoint that was down during a real event permanently loses it — the only operator action is a synthetic ping |
| **M-9** | Announcements history unreadable after resolve | `status.service.ts:57-75` queries only the active window; `resolveAnnouncement` sets `activeUntil=now`, dropping the row from every read | "The incident history IS the status page" is not consumable — no API retrieves a resolved incident |
| **M-10** | Contact/careers GDPR export/erasure absent | Newsletter has both (`inbox.controller.ts:169-182`); contact and career surfaces expose neither | Staff cannot fulfill access/erasure requests for the highest-PII public forms |
| **M-11** | Campaign test-send absent | Campaign routes are create/update/schedule/cancel/detail only; no seed/preview recipient path | The only way to see a rendered campaign is to send it to the entire list |
| **M-12** | Project budgets evaluate the wrong spend | `billing.worker.ts:55-64` — the spend closure ignores `_projectId`; SQL filters org (+product) only; `billing_budgets.project_id` stored but never used | A project-scoped budget alerts on org-wide totals — thresholds fire at the wrong time or never |
| **M-13** | Manual console invoice draft is a bare invoice | `invoices.service.ts:91-109` inserts only the period total; lines/adjustments/credits exist only in the (unwired) cycle service | Two draft paths produce inconsistent documents; the same period bills differently depending on who drafted |
| **M-14** | Invoice pay/issue/void lack step-up while a $5 credit grant requires it | grep `StepUp` in billing.controller.ts → 0 hits; extension controller demands proof for grants | Marking a $100k invoice paid is guarded more weakly than every other money-mutating act |
| **M-15** | Usage export silently truncates at 10,000 rows | `billing-extension.controller.ts:172-182` — raw cap, no continuation, no truncation flag; invoice lists unpaginated | A high-volume month's chargeback export silently drops data |
| **M-16** | Key usage telemetry not recorded on the satellite validation seam | `keys.service.ts:179-213` (`validateByHash`) is read-only; `usage_count`/`last_used_at` bump only on engine-authenticated use; service accounts DO bump theirs | Keys exercised only via the runtime/`/internal/keys/validate` look unused forever — the K-3 "what is this key doing" view lies |
| **M-17** | Login success/failure events computed then dropped | `LoginSuccess`/`LoginFailure` emitted 7× (login controller, social controller), zero subscribers | The auth-visibility event-bus half is dead code (metric half works) |

## LOW

| # | Feature | Evidence |
|---|---|---|
| **L-1** | MFA enabled/disabled emails never sent — templates registered, zero senders (`templates.ts:85,95`; mfa.service imports no mailer) | missing "was this you?" tripwire |
| **L-2** | `billing.cost_anomaly` uses a raw string, not the EngineEvents vocabulary (anomaly.service.ts:118; one-sided rename severs alerting) | |
| **L-3** | Dead `HEARTBEAT_TIMEOUT_SECONDS=120` constant duplicates `SATELLITE_HEARTBEAT_TIMEOUT_SECONDS` env (satellite.schema.ts:75, never imported) | |
| **L-4** | Apple social config read via raw `process.env` bypassing the validated env (idp-verify.ts:170-198) | |
| **L-5** | Hardcoded worker crons (keys/config/deployment/org-purge) while billing's is env-tunable | |
| **L-6** | Audit action filter documented as prefix match, implemented as exact (`org-audit.service.ts:51-53`) | |
| **L-7** | API-key project binding immutable post-issue — rebind forces revoke+reissue of a secret (UpdateKeyDto has no project field) | |
| **L-8** | Public blog list: no offset pagination (cap 100), no tag/category filter though tags are collected (`public.controller.ts:170-175`, `content.service.ts:260-268`) | |
| **L-9** | No newsletter subscriber import (export exists) — list migration before E-5 requires direct DB writes | |
| **L-10** | Notifications feed unpaginated (hard-coded limit 50) | |
| **L-11** | Staff: no account-by-email search; expired-impersonation sweep runs only at boot | |
| **L-12** | Satellites: no manual incident resolve/annotate endpoint (machine conditions only) | |
| **L-13** | Deployment manifest omits the `deployment-usage-pro` plan its catalog sells (`products_manifests/deployment.yaml:32` vs `deployment/plans.ts:36-49`) | |
| **L-14** | Studio `pointers` deep-link `/v1/conversations|evaluations|policies` — routes the engine doesn't serve (proxy is Caddy-side, not code here) (`studio.controller.ts:181-191`) | |
| **L-15** | `pipeline_stages.auto_promote` default drift: DB `0` vs drizzle `.default(1)` (0005 sql:45 vs schema.ts:92) — latent, sole insert passes it explicitly | |
| **L-16** | Price catalog accepts retroactive `effective_from` (backdates re-derived costs; no correction endpoint) (`price-catalog.service.ts:123-135`) | |
| **L-17** | Auto-drafted invoices bypass the per-invoice audit record the manual path writes (cycle service vs invoices.service.ts:111-120) | |
| **L-18** | Deployment status/events are polling-only — no SSE/streaming surface | |
| **L-19** | Studio plan limits ($250/50k) enforced cooperatively only (quota-check is opt-in for the satellite; ingest doesn't gate) — ledger concedes A-4 pending | |

---

## Verified complete (explicitly NOT gaps)

- **Identity core:** password reset + email verification end-to-end with enumeration
  resistance and session revocation; full TOTP surface exposed; step-up
  producer/consumer genuinely wired (`mintMfaProof` → `POST /auth/mfa/proof` →
  StepUpGuard); session registry; social login fully consuming declared env for
  Google/GitHub/Apple/Microsoft; rate limits on every auth route.
- **Keys (handover A-1 engine side):** full CRUD + Stripe-semantics rotation, the
  dual-write seam on Python's `api_keys` is real (issue/update/rotate/revoke),
  `/internal/keys/validate` + batch with L3/L2 scope gating, expiring-key worker.
- **Organizations:** invites end-to-end (hashed single-use tokens, caps, email
  binding, resend/extend), exactly-one-owner invariants with rollback, suspension,
  groups, service accounts (rotate/revoke/step-up), settings/branding, audit
  query/facets/export, entitlement state machine, personal-org autocreation,
  staged deletion + daily purge, ownership transfer.
- **Deployment:** every lifecycle edge reachable via real endpoints; fail-closed
  gates; approvals distinct-counted; canary with pause/resume/abort; rollback with
  live-state restore; envelope-encrypted secrets with L3-only decrypt + per-resolve
  audit; reconciler/retention/secrets-scan rhythms; real-KPI summary provider.
- **Config-publish (A-4 engine side):** full v2 verified — drafts/validate/publish/
  rollback/diff/history/delivery/re-notify/retention + bootstrap/ETag/since pulls
  with quarantine gate. (Remaining A-4 checkbox is runtime-side by design.)
- **Satellites (dense wave):** heartbeat lease protocol, directives, version-floor
  enforcement, full staff lifecycle, incident timeline, per-scope compliance
  counters, bounded history, revocation feed, minute sweeper.
- **Corporate E-1/E-2/E-3 core:** transport + templates + suppression + provider
  webhooks + RFC 8058; contact + careers pipelines; newsletter double opt-in +
  campaigns; CMS with revisions/schedule/preview + all four feeds.
- **Console C-1…C-4:** manifest registry with boot validation, manifest-driven
  home, real onboarding checks, status center on satellite liveness, quota-join
  limits, bijection boot check live in main.ts.
- **Cross-cutting:** queues↔workers fully consistent (8/8); migrations↔schema
  table-consistent (one default drift, L-15); all six metrics live; every env var
  consumed; route prefixes fully covered.

## Recommended fix order

1. **B-1 + B-2 + H-2** — three small wiring/shape defects that break running
   surfaces today (module boot, alert fan-out, audit endpoint compile).
2. **H-3 + H-4 + M-3 + M-14** — the monetization spine: trial expiry sweep,
   plan-change surface, seat enforcement, step-up on money acts.
3. **H-1** — Stripe payment rail (the recorded decision), replacing the manual
   pay path with webhook-confirmed truth.
4. **H-5 + H-6 + H-7** — account-surface security/compliance: login MFA
   challenge, deletion, email change.
5. **M-4 + M-5 + M-6 + M-17** — event-bus dead ends (subscribe the documented
   consumers) — cheap, high blast-radius fixes.
6. Remaining MEDIUMs and LOWs per-module.
