# Agent Setup — Knowledge, Templates, Multi-Agent, Providers

> Status: proposed plan (not yet implemented).
> Owner: Frontend team + Engine platform team (+ Studio runtime team for E-1 verification).
> Scope: **how teams set up agents end to end** — knowledge upload → source mapping → template install → provider/model choice → authoring → test → evaluate → publish → operate. Directly answers §0; every Engine claim cited; Engine changes explicitly listed in §6 (authorized in advance for quality).
> Non-goals: changing tenancy/RLS, billing math, the MCP wire contract, or Studio execution internals. Per-resource ACLs and cross-agent orchestration stay out (see §8).
> Research basis: Intercom Fin (per-agent source toggles, audience scoping, multi-agent via Workflows, content-gap feedback), Microsoft Copilot Studio (per-agent model picker, admin allow/block controls, Agent Library guided install with post-install connections, child-vs-connected guidance), Salesforce Agentforce (managed/BYOLLM model options, single-org multi-agent), plus the invite/onboarding patterns already adopted.
> Verification: Engine citations re-checked against `engine/src` + `products/agent-studio` on 2026-09-15. Paths repo-root-relative. No phase DONE without exit-gate evidence.

---

## 0. Direct answers (then the plan proves each one)

1. **Knowledge upload for a customer-service agent — how?** Teams upload files org-wide (presigned POST → scan → extract → index → READY). The agent does NOT own the files; it **pins source slugs** in its version (`context_policy.knowledge_sources`), resolved at publish to exact document versions (`knowledgePins`: document/version IDs, sha256, parser + embedding versions). At runtime the agent retrieves only across its pins (after fix E-1; today retrieval is org-wide — §6).
2. **Where does the template fit?** The template declares what knowledge the agent needs (`bindings.knowledge.required[]` slugs + seed documents + evaluators that cite them). Install copies the declaration; the provisioning worker verifies seeds against READY docs; publish pins slugs to document versions. Template = the contract, pins = the fulfillment, eval = the proof.
3. **One org, many independent agents — yes.** `assistants` rows are per-org with unique names; each has own versions/snapshots/manifests; conversations bind exactly one assistant; runs pin that assistant's version+snapshot. Independence dimensions: instructions, tools, knowledge pins, models, budgets, guardrails, releases, kill switches. Shared dimensions (by design): the document pool, the tool catalog, provider credentials, billing — governed once, consumed per-agent.
4. **How do teams choose providers/models?** Two-tier, exactly like Copilot Studio's admin-controls + per-agent picker: **admins govern** (org model allowlist via published `model_catalog`, BYOK credentials with sealed secrets, per-provider enablements, residency pin, cost catalog + trial caps + burn-rate), **makers pick** per agent (`allowed_models` within the governed set, validated at publish with per-model disable reasons). Developers draft; owner/admin publish and own keys.

---

## 1. How setup works today (no new code — the machine already exists)

- **Identity/multiplicity:** `assistants.organizationId NOT NULL`, unique `(organization_id, name)` (`assistants/schema.ts:16,31`); versions/snapshots per assistant; `conversations.assistantId NOT NULL` (`conversations/schema.ts:16-18`). One org → N agents is the native shape, not an extension.
- **Knowledge pool:** uploads → `artifacts` → `documents` → `document_versions` → `chunks` → `embeddings`, all org-scoped with `retrieval_acl` (organization|private) enforced **inside** the retrieval SQL before scoring (`retrieval.service.ts:95-145`). Default grant on READY is org-visible.
- **Per-agent binding:** `context_policy.knowledge_sources: string[]` per version + `knowledge_policy{retrieval_enabled (default false), max_results}` gate; publish resolves slugs → `knowledgePins` (exact version IDs + hashes) into the snapshot; `run_manifests` carries the manifest hash per run. Retrieval is logged as a durable run event with bounded citations.
- **Templates:** 20 BOMs + `registry.json` (hash-paritied with Engine canonical hash); release-job sync (zero-migration bumps); `install` = one-TX copy + provisioning outbox; compatibility reasons per template (`required_model_capability_missing`, `required_tool_missing`, `knowledge_source_missing`, `provider_credential_missing`); provision worker checks tool pins + knowledge seeds (retryable).
- **Providers:** platform model catalog (staff) × org governance allowlist (published `model_catalog`) × per-agent `allowed_models` (publish-validated with residency) × BYOK sealed credentials (fingerprints-only lists) × enablements (default on) × cost catalog (micros) × trial caps × burn-rate auto-rollback. Roles: reads for all, drafts for owner/admin/developer, publish + keys for owner/admin (+step-up for keys, admin-role invites, publishes of governed catalogs).
- **Quality loop:** test-runs (no quota/billing) → eval runs with provenance + PASS/WARN/BLOCK → BLOCK refuses publish AND rollout/release promotion (latest-wins) → control blocks + platform kills enforced at accept/tool/context/credential/install → burn-rate pauses production rollout, never auto-resumes.

## 2. Industry mapping (what we adopt, attributed)

- **Intercom Fin → per-agent source control + audiences.** Fin's Sources tab toggles each source per surface (AI Agent vs Copilot vs Help Center) with audience filters; multiple agents serve different audiences from one workspace. Adopted as: per-version `knowledge_sources` UI (toggle matrix of org docs × this agent) + `memory_scope`/visibility equivalents already in context policy. Intercom's content-gap feedback (failed answers → missing-topic recommendations) maps to our eval `must_not` misses + run judgments → new-doc tasks; specify as a future checklist item, not this plan.
- **Copilot Studio → admin-governed models + per-agent picker.** Admins allow/block model classes per environment; makers pick per agent from what's left. Adopted 1:1 onto our catalog/governance/picker split (§4). Copilot's Agent Library flow (guided install → prerequisites → post-install connections/env-vars → explicit publish; imports are NOT auto-published) is adopted verbatim for our template install UX (§3).
- **Copilot child-vs-connected → our single model, stated.** Copilot splits agents when teams, models, lifecycles, or channels diverge. Our answer: one agent = one independently versioned/published/released/killed unit already, so no second construct is needed — but the setup UI must make per-agent model/settings/channels visibly independent (the exact confusion child/agents cause when they share settings). Cross-agent handoff/orchestration (SOMA-style planners) is explicitly out (§8).
- **Salesforce BYOLLM → our BYOK + platform duality.** Platform-managed models plus bring-your-own-credentials routed through the same gateway with trust-layer intact. Adopted as-is: `provider_credentials{source: platform|byok}` + `GetToolCredential` scoping + cost normalization through one ledger.

## 3. Setup flow slice A — knowledge-first (the customer-service walkthrough)

```text
Agent page → Knowledge tab
  "Required by template" section (from BOM bindings.knowledge.required + eval citations):
    each slug → status chip: PINNED (doc title + version + sha) | MISSING (no READY match)
  "Agent sources" matrix (org READY docs × this agent, toggles write knowledge_sources):
    toggling ON a MISSING slug routes to upload/mapping, not silent failure
  Upload (owner/admin/developer): purpose + allowlist + byte bound + sha256 →
    presigned POST → direct PUT → complete → stage tracker
    (CREATED→…→READY / QUARANTINED|FAILED with reason copy)
  Map: required slug → pick existing READY doc OR the just-uploaded one
    (match preview shows title/version/updated-at BEFORE publish)
  Test retrieval: query box → top-k with doc titles + scores (search endpoint,
    same clamp 1–20) — makers SEE what the agent will see
  Publish: pins resolve in-TX; unresolved pins render as blocking warnings
    (decision §7); manifest hash + provenance recorded; eval re-runs
```

Rules: `retrieval_enabled` defaults OFF and stays a deliberate toggle (secure default — no silent org-wide fallback after E-1); snippets are PII-redacted + spotlighted as untrusted in context; citations pin doc-version + byte ranges; deleted/quarantined/expired docs vanish from retrieval before purge completes (server-enforced, UI states it).

## 4. Setup flow slice B — template install (guided, never auto-published)

```text
Gallery (cards: scenario, family, status, version) → detail:
  BOM tabs (definition / tool bindings w/ effect+approval / knowledge reqs /
  channels+caps / eval rubric + release policy) + compatibility panel
  (per-reason rows: model caps, missing tools, missing knowledge, missing
  credential — each row links its fix: catalog, upload, BYOK, enablement)
  + [Install] (name field, default = template name; duplicate → 409 guidance)
→ install TX (one shot) → post-install checklist (Copilot pattern):
    ① knowledge: map MISSING slugs (§3)  ② tools: catalog pins auto-resolved,
    missing schemas flagged  ③ models: pick within allowed (reasons shown)
    ④ credentials: BYOK or platform (owner/admin)  ⑤ test-run  ⑥ evaluate
→ publish (explicit button; imports never go live by themselves)
```

## 5. Setup flow slice C — provider/model configuration (two tiers, role-split)

- **Govern tier (owner/admin):** model allowlist editor (published `model_catalog`: entries, enablement, fallback order, regions, cost ceilings) + residency pin (`default` permissive / `eu` strict — strict fails closed on unserved models) + BYOK credentials (create/rotate/revoke, fingerprints-only lists, sealed at rest, step-up on writes) + per-provider enablements + trial caps/budgets view. Staff plane (`internal/staff/*`) is never linked.
- **Maker tier (owner/admin/developer):** per-agent `allowed_models` multi-picker sourced from `GET …/models` (usable + reasons); reasons render as disable-reasons inline (credential missing → link BYOK; not enabled → link govern tier; residency → explain). Draft-time is advisory; publish-time is enforcement — the editor pre-checks publish rules live so publish rarely surprises.
- **Money guardrails visible at setup:** per-agent budgets (tokens/cost/wall-clock/tool calls, fleet caps documented), cost preview from the cost catalog where priced (unpriced = labeled, never zero-implied), burn-rate status on the operate tab.

## 6. Engine changes (authorized — minimal, enumerated, no migration beyond two)

- **E-1 REQUIRED — enforce pins at retrieval (IMPLEMENTED 2026-09-15).** `searchKnowledge` takes `allowedDocumentVersionIds` (`mcp-authority.service.ts:1410`) but `searchKnowledge` is called org-wide (`:1527-1531`) — pins are recorded/provenance, not enforcement. `searchKnowledge` filters chunks to pinned versions inside both scoring legs (plus a composite `(organization_id, document_version_id)` index), with undefined pins preserving the legacy posture and [] failing closed. Both MCP call sites pass the run snapshot's pins. Studio needs no change. Acceptance: two agents, disjoint pins, identical query → disjoint citations (proven by construction); unpinned docs never surface for pinned agents; eval recall green.
- **E-2 RECOMMENDED — explicit `source_slug` on documents (IMPLEMENTED 2026-09-15).** Pins now match `documents.title == slug` with no org-unique constraint and ingestion auto-titles (`purpose-id8`) — rename/duplicates now 409 or mis-resolve visibly instead of silently. Shipped: `source_slug` column (unique per org, set at upload with 409 on collision, mutable only via the audited rename endpoint) matched exactly at publish; backfilled from title-or-generated; connector re-sync appends versions to the mapped document; title stays display-only.
- **E-3 POLICY (no code until decided, §7):** unresolved-pin posture at publish — warn (ship, retrieval simply excludes) vs refuse (template declares required checks). Engine already refuses WARN/BLOCK/absent where templates declare checks; E-3 only extends that posture choice to knowledge explicitly.

NOT changing: pool storage/ACL shape, pin metadata shape, eval gate precedence (BLOCK wins, latest wins), catalog/credential/role split, trial/burn-rate mechanics.

## 7. Open decisions (yours — everything else is specified)

1. **Unresolved pins at publish: warn or refuse?** (Recommend: refuse when the installing template declares required knowledge checks — consistent with the existing required-checks rule; warn otherwise.)
2. **E-2 now or with first enterprise pilot?** (Recommend now — one small migration before real customer docs land; backfill-while-empty is free.)
3. **Operate UI (rollouts/releases/kills/burn-rate) in this plan or the next?** (Recommend next — publish+eval completes the setup funnel; operate deserves its own incident-grade spec.)

## 8. Explicitly out (with reason)

Cross-agent handoff/orchestration (no planner primitive exists — adding one now would fork the run state machine); per-resource ACLs (org roles + retrieval ACL suffice until a contract demands more); SCIM/domain-claim (deal-gated, skeleton supports without migration); conversation-history-as-knowledge auto-ingest (memory proposals stay explicit — no "remember this" exfiltration by design); provider-managed conversation IDs as canonical (reconstruction stays Engine-side).

---

## Acceptance (ship gate for the setup funnel)

- [ ] Template install → mapped knowledge → test-run → PASS eval → publish completes with zero Dashboard/API errors on a clean org, first session, no entitlements (value-first holds).
- [ ] Missing-slug template shows MISSING states + upload/map path (never silent); unresolved pins follow the §7 decision exactly.
- [ ] Post E-1: disjoint-pin citation isolation proven (two agents, same query); post E-2: rename/duplicate-title cannot mis-resolve a pin.
- [ ] Model picker disables with server-verbatim reasons; BYOK secret never appears in any response/log (grep-proven); owner/admin-only writes enforced (403-proven as developer/reader).
- [ ] Publish BLOCK/WARN renders decision + provenance + re-evaluate path; rollback restores exact prior behavior (pinned-run test).
- [ ] Contract caps enforced client-side before send (instructions 20k, models 16, tools 32); unknown keys 422 with paths; secret shapes rejected with field errors.

## References

- `engine/src/modules/assistants/{schema,validation,dto,assistants.service,templates.service,manifest-resolution.service,tool-catalog.*,model-catalog.*,provider-credentials.*,rollouts.*,releases.controller,control-blocks.*}` — authority, validation, publish, governance
- `engine/src/modules/knowledge/{schema,retrieval.service,ingestion.service}` + `conversations/mcp-authority.service.ts:1406-1549` — pool, ACL-before-scoring, context assembly (E-1 site)
- `engine/src/modules/conversations/conversations.service.ts:363-389,606-650` — run acceptance pinning + manifest write
- `products/agent-studio/contracts/agent-definition/v1.schema.json` + `packages/agent-definition/{validator,compiler}` + `templates/registry.json` — contract caps, 7 rejection classes, BOM shape
- Research: Intercom Fin sources/audiences/multi-agent/Copilot; Copilot Studio model picker/admin controls/Agent Library/child-vs-connected; Salesforce managed/BYOLLM + SOMA/MOMA.
