# Enterprise Platform Gap Plan — Salesforce-grade, without the gaps

> Status: proposed plan (not yet implemented).
> Owner: Engine platform team (+ Studio runtime team where noted).
> Scope: **every enterprise agent-platform capability audited against `engine/src` on 2026-09-15** — verdict PRESENT/PARTIAL/ABSENT each with a direct citation, then a P0/P1/P2 build order with concrete Engine work items. Companion to `agent-setup.md` (the setup funnel) and `release_readiness/release_gap_report.md` (the release register).
> Non-goals: marketing-site work, pricing-page decisions, compliance certifications themselves (SOC 2/ISO/HIPAA are process artifacts — the plan covers only the technical controls auditors inspect).
> Research basis: Salesforce Agentforce (model options incl. BYOLLM, SOMA multi-agent, Agent Gateway governance), Intercom Fin (per-agent sources, audiences, Copilot, content gaps), Microsoft Copilot Studio (model picker, admin controls, Agent Library, child-vs-connected), Sierra (Agent Studio traces, evals/regression, knowledge gaps, Horizon proactive, voice-first omnichannel), Decagon (AOPs, Watchtower, per-conversation/per-resolution pricing), Kore.ai (27 channels, Search AI + permission-aware connectors, ABL/delegation, observability), Moveworks (source permission mirroring), plus support-agent teardown literature (audit depth, unified human+AI view, billable-unit definitions).
> Rule: no item moves to DONE without code + migration + test + evidence, same ledger discipline as everything else.
>
> Implementation status (2026-09-15 — code complete, DB-backed exit gates pending the first full CI/DB run):
> E-1 pin enforcement + E-2 source_slug + P0-3 briefed handoff + P0-2 per-assistant analytics + P0-1 connectors (OAuth framework, Drive/SharePoint/Confluence/Notion/Zendesk/Slack adapters, permission sync, delete propagation) all landed under `drizzle/0057_enterprise_knowledge_p0.sql`. Migration is ordered/reviewed with journal + ownership-map entries; unit suites green; typecheck/lint clean. Integration proofs (live-provider syncs, permission-mirror drill, EXPLAIN plans, restore/replay) remain open and are tracked per-item below.

---

## 0. Where we already meet or exceed the category

Stated once so the plan spends its budget on gaps, not anxiety:

- **Versioning beats the category.** Immutable assistant versions with run pinning, deterministic export/import, advisory-locked publish, and latest-wins BLOCK eval gates are the GitHub-Workspaces-grade version control Sierra sells as a feature — ours is structural, not a tab.
- **Isolation beats the category.** RLS `ENABLE+FORCE` on every tenant table + app predicates + tenant-bound object keys + ACL-before-scoring retrieval is a stronger default than the post-filtering several vendors were cited for.
- **Kill switches beat the category.** Five-level control blocks + platform template kills + assistant kill flags enforced at accept/tool/context/credential/install, plus burn-rate auto-rollback, exceed the "guardrails as configuration" posture — including the class of misconfigured-guardrail incident that made press in 2025.
- **Money truth beats the category.** Immutable usage ledger with compensating corrections (never rewrites) answers the "who defines resolved?" billing Cornell both Sierra and Decagon get pressed on — once per-agent outcome analytics (GAP-5) feed it.
- **Approval-gated tools, idempotent everything, human escalation with queues** already exist (`authorizeToolCall` + scoped capabilities, tiered idempotency + outbox/inbox, escalations WAITING→CLAIMED→RESOLVED).

## 1. Gap register (strict audit — ABSENT means no code, not "thin")

| # | Capability (why enterprise buyers demand it) | Verdict | Evidence |
|---|---|---|---|
| GAP-1 | Real knowledge connectors (Drive/Notion/Confluence OAuth + delta sync) | PARTIAL | `connectors.controller.ts:17` + `connector.port.ts:135-143` exist; only `SitemapConnector` is real, Drive/Notion/Confluence throw `CONNECTOR_OAUTH_REQUIRED` (`connector.port.ts:123-133`). Zero hits for SharePoint/Zendesk/Salesforce/Slack. |
| GAP-2 | Source permission sync (external ACLs enforced at retrieval) | ABSENT | ACL is internal `organization\|private` only (`knowledge/schema.ts:159-172`); sync maps no external principals (`connectors.service.ts:123-158`). Kore/Moveworks lead deals with this; regulated buyers block without it. |
| GAP-3 | Per-agent outcome analytics (containment/resolution/CSAT per assistant) | ABSENT | Rollups are org-level kinds (`csat_daily,conversation_outcomes,usage_daily`, `analytics-rollup.consumer.ts:15-19`); no per-`assistantId` breakdown, no containment/deflection definition. Raw material exists (`message_feedback`, `run_judgments`, run terminal reasons). |
| GAP-4 | Escalation with context summary | ABSENT | `escalate()` carries ids + reason only (`escalations.service.ts:35-143`); summaries exist but are compaction-only (`conversations/schema.ts:181-207`). Support agents need the human to arrive briefed. |
| GAP-5 | Interactive messages (buttons/quick-replies/cards) as canonical content | ABSENT | Content schema validates text-only (`conversations.service.ts:1938-1952`); only WhatsApp send-time interactive exists (`channels/senders.ts:172-200`), normalized back to plain text on receipt. |
| GAP-6 | Proactive/outbound + scheduled runs (+ consent/opt-out store) | ABSENT | Only corporate newsletter has campaigns; no agent-initiated proactive run, no consent store. (Sierra Horizon made this a category feature.) |
| GAP-7 | Voice, realtime | ABSENT (seam held) | Voice-notes via ASR/TTS ports only; realtime declared seam (`channels/voice.service.ts:7-19`); `voice` explicitly unmapped (`channels.service.ts:498-503`). |
| GAP-8 | Per-end-user tool credentials (act-as-user OAuth) | ABSENT | Credentials are org-sealed per tool (`tool-catalog.schema.ts:28-29`); `GetToolCredential` takes no user (`mcp-authority.service.ts:557-616`). Fine for service actions; blocks me-actions (mailbox, calendar, CRM-as-user). |
| GAP-9 | Assistant environments + promotion gates | ABSENT | Releases carry free-form env pointers (`rollouts.service.ts:62-77`, default `production/default`) — no env objects, no gates. (`product_deployment` envs belong to pipelines, not assistants.) |
| GAP-10 | Publish sign-off (multi-person approval) | ABSENT | Single-actor publish; gate is eval-content only (`release-gate.ts:27-96`). Regulated change management wants 4-eyes. |
| GAP-11 | Knowledge-gap detection ("missing topics") | ABSENT (material present) | Sierra/Intercom sell this; our eval `must_not` misses + low-score retrieval legs + run judgments contain the signal, but no surfaced "create this doc" loop. |
| GAP-12 | A/B + shadow/canary evaluation of agent variants | ABSENT | Eval runs + regression bound exist; no traffic-split, shadow-run, or canary-release primitive (rollout pause is the only lever). |
| GAP-13 | Public assistants-management API/SDK | ABSENT | Assistants/tools/versions/publish are `console/org/*` only; public `v1` is conversations-only (`conversations.public.controller.ts:18`). No developer-platform story. |
| GAP-14 | Data masking vault (beyond PII patterns) | ABSENT | Pattern redaction only (`common/guardrails/pii.ts:23-46`). PCI/PHI workloads need vault-transit/detokenize. |
| GAP-15 | Bulk operations (invites/publish/retire) | ABSENT | Single-item endpoints only (invite create, publish/retire per version). Operator toil at scale. |
| GAP-16 | Agent-to-agent delegation | ABSENT (deliberate) | Only human handoff exists. Held out pending a no-fork design (see §4). |

## 2. Build order — P0 (deal-blockers), P1 (scale), P2 (bets)

### P0-1. Enterprise knowledge: real connectors + permission-aware retrieval (GAP-1 + GAP-2)

The single biggest enterprise hole: customer knowledge lives in Drive/SharePoint/Confluence/Zendesk, not in uploads — and regulated buyers require source-permission enforcement, the exact feature Kore and Moveworks lead with.

- OAuth connection profiles per provider (admin-scoped, sealed like provider credentials; reuse the `enc:v1:` envelope + fingerprint list pattern).
- Adapters behind the existing `connector.port.ts` seam: Drive, SharePoint, Confluence, Notion-real, Zendesk, Salesforce (in that order — file-collaboration first, ticket systems second).
- Scheduled delta sync + manual full sync on the existing `connectors.worker.ts` sweep; per-object filters; sync cursors already in the model.
- **Permission sync:** external principal mapping table (`source principal → account/org scope`) + `retrieval_acl` extension carrying source ACLs; enforcement stays inside the retrieval SQL (same ACL-before-scoring invariant — never post-filter). Private stays exact; unknown principals default-deny.
- Acceptance: permission-mirror test (user loses source access → doc vanishes from their retrieval same sync); sync-status per connector; revocation propagation bounded and documented.

### P0-2. Outcome analytics per agent (GAP-3)

Buyers buy resolutions, not tokens. Compute from existing raw material — no new capture needed for v1:

- Definitions (locked, documented, contract-safe): `contained` (no escalation in conversation), `resolved` (terminal COMPLETED + positive/absent-negative feedback, no reopen in N hours), `CSAT` (existing thumbs), all sliced by `assistantId` (+ channel, + template).
- New rollup kinds alongside the org ones; dashboard reads per assistant; feeds the billing-explainability chain (run → ledger → invoice) so the billable unit is auditable — our structural answer to the category's definitional risk.
- Acceptance: numbers reproducible from canonical tables by support without vendor help (the audit-trail complaint both leaders carry).

### P0-3. Briefed handoff (GAP-4, small)

Attach the conversation's newest summary + open run state + citations to the escalation record at `escalate()` time (all three already exist separately). Agent reply view renders the brief first. Human agents arrive with context; the "handoff cliff" both leaders are dinged for disappears. No migration beyond a nullable brief column (or derived read — prefer derived first).

### P1 group (in priority order)

1. **Interactive messages (GAP-5):** canonical `parts` (button/quick-reply/card/carousel) in message content with per-channel renderers; WhatsApp sender already proves the pattern. Support bots need tap-targets, not just prose.
2. **Knowledge-gap loop (GAP-11):** aggregate eval misses + low-score retrieval legs + negative judgments into "missing topic → draft doc" tasks per agent. Mostly console over existing events; the highest-ROI analytics dollar after P0-2.
3. **Environments + promotion gates (GAP-9):** env objects under assistants (dev/staging/prod minimum), promotion = pointer move through gates (eval decision + approvals), reusing the releases pointer machinery.
4. **Publish sign-off (GAP-10):** optional per-org rule (e.g., production publish needs a second owner/admin approval) reusing the approvals primitive; default off so PLG motion stays frictionless.
5. **Per-user tool credentials (GAP-8):** OAuth connection per end user for me-actions, scoped down from org credentials, with the same sealed storage + disclosure path extended by user scope. Unlocks mailbox/calendar/CRM agents.
6. **A/B + shadow evaluation (GAP-12):** traffic split + shadow runs (no user-visible effect) + canary release pointers, reusing run pinning (a shadow run pins a non-active version — the model already supports it).
7. **Public assistants API (GAP-13):** `v1` read surface for assistants/versions (L2 keys) for the developer-platform story; publish stays console-only until demand proves otherwise.
8. **Bulk ops (GAP-15):** bulk invite (email list + role), bulk retire; each item independently idempotent, per-item results (never all-or-nothing).
9. **Proactive + consent (GAP-6):** scheduled/triggered runs with per-customer per-channel consent/opt-out store, suppression (in-progress/opted-out/stale), and full audit of what triggered each touch. Needs the consent model first — no proactive without it.

### P2 group (bets, deal-gated)

- **Voice realtime (GAP-7)** behind the documented ASR/TTS seam (telephony/SIP, barge-in, locale models) — only for voice-first buyers.
- **Masking vault (GAP-14)** for PCI/PHI workloads (format-preserving tokenize/detokenize around tool calls).
- **Delegation primitives (GAP-16):** parent-planner + specialist delegates inside one org with Engine-owned delegation records (SOMA-shaped) — only with a design that keeps ONE run state machine (the dual-durability ban from the Studio architecture stays non-negotiable).

## 3. What NOT to build (with reason)

- **In-house model stack** (Decagon's bet): we are provider-neutral by architecture; the catalog + BYOK + cost-normalization story is the differentiator, not training.
- **White-glove implementation as product**: templates + guided install + test-runs ARE the onboarding — keep time-to-value self-serve (our structural edge over 6-week deployments).
- **Outcome-based billing as default**: keep usage-ledger truth; *derive* resolution metrics for contracts that demand them. Never let billing definitions rewrite history.
- **Second runtime/state machine** for any of the above (orchestration included): Engine stays system of record; Studio stays execution; every P-item above respects that boundary or it doesn't ship.

## 4. Ship order across the next three builds

```text
Build A (close the deal-blockers): P0-1 connectors (Drive+SharePoint first) →
  P0-1 permission sync → P0-2 outcome analytics → P0-3 briefed handoff
Build B (scale the operation): GAP-5 interactive → GAP-11 gap loop →
  GAP-9 environments → GAP-10 sign-off → GAP-8 user credentials
Build C (grow the surface): GAP-12 A/B+shadow → GAP-13 public API →
  GAP-15 bulk → GAP-9…GAP-6 proactive+consent → P2 bets by contract
```

E-1 (pin enforcement) and E-2 (source_slug) from `agent-setup.md` stay first — they are the foundation P0-1's permission model rests on.

---

## References

- Audit evidence: `engine/src/modules/{knowledge/{connectors.*,retrieval.service,schema},conversations/{escalations.service,schema},channels/{senders,voice.service},assistants/{release-gate,rollouts.service},workers/analytics-rollup.consumer.ts}` — see §1 table
- `engine/docs/frontend/agent-setup.md` — setup funnel this plan extends (E-1/E-2 live there)
- Research: Agentforce model options/BYOLLM/SOMA/governance; Fin sources/audiences/Copilot/multi-agent; Copilot Studio picker/admin-controls/library/child-vs-connected; Sierra Studio/evals/knowledge-gaps/Horizon/voice/Experiments/Ghostwriter; Decagon AOPs/Watchtower/pricing; Kore.ai channels/connectors/permission-ACL/ABAC/delegation/observability; Moveworks permission mirroring; support-agent teardown literature (audit depth, unified view, billable-unit risk).
