# FL-3 Frontier — implementation decisions & seams

Status: 2026-09-13. Phase FL-3 executed after FL-2 stabilization; this doc is
the design-first record (mission rule 8) and the ledger of explicit seams.
Every item is IMPLEMENTED unless the note records a residual external seam.
DB-backed exit gates join the first full CI/DB run (statuses are
CODE_COMPLETE / GATES_PENDING, never DONE without CI evidence).

| ID | Item | Status | Notes |
|---|---|---|---|
| FL-3.1 | Voice (speech-to-speech, WebRTC) | IMPLEMENTED (realtime v2v = documented seam) | Store-and-forward voice notes end-to-end: platform media id → bounded download (10 MiB) → ASR port (`CHANNELS__VOICE_ASR_URL`) → the ONE acceptMessage entry with `voice.transcribed` provenance; outbound TTS port (`HARNESS__TTS_URL`) renders WhatsApp voice notes via the media sender with a deterministic claim anchor. Realtime speech-to-speech (~800ms bar) needs a hosted vendor + WebRTC transport — deployment seam, unchanged. |
| FL-3.2 | Image generation output | IMPLEMENTED (no first-party image model = documented seam) | `generate_image` builtin (READ_ONLY) → hosted endpoint (`HARNESS__IMAGE_GEN_URL`) → PutRunArtifact GENERATED_MEDIA (image media allowlist, 5 MiB) → contract v1.2 `EVENT_TYPE_MEDIA` + `MediaBody` run event → commit pins bounded `generated_media` refs + `artifact_refs` on the assistant message → channel plane delivers via presigned GET + media senders. |
| FL-3.3 | Regenerate / edit-and-resend with branching | IMPLEMENTED | Migration 0042: `messages.superseded_by` (set-once) + `branched_from`, `runs.regenerated_message_id`, `conversations.branched_from_message_id`, partial active-branch index. Messages stay immutable — regeneration/edit APPEND a replacement and move the pointer; `CommitRunResult` supersedes in the SAME TX as the new reply. APIs: POST regenerate / edit (idempotent), `include_superseded` reads serve branch history. |
| FL-3.4 | Share links, pinned messages, follow-ups | IMPLEMENTED (share UI = consumer) | `conversation_shares` (RLS, sha256 token at rest, TTL + revocation, uniform 404) with a redacted public read projection; `messages.pinned_at/pinned_by` + pin API; contract v1.2 `CommitRunResult.suggested_followups` (max 4×200) recorded with the terminal commit and surfaced on messages/widget/SDK/OpenAPI. |
| FL-3.5 | Built-in web search tool | IMPLEMENTED | `web_search` builtin in the tool catalog (READ_ONLY, egress `limited`) executed through the HTTP binding pattern (FL-2.10) against `HARNESS__WEB_SEARCH_URL`. |
| FL-3.6 | Thinking/reasoning display events | IMPLEMENTED | Contract `EVENT_TYPE.THINKING` (additive enum), Studio `AssistantThinking` domain event, SSE `thinking` named event. |
| FL-3.7 | Query rewriting (multi-query/HyDE) | IMPLEMENTED | `QueryRewriteService` port (`HARNESS__QUERY_REWRITE_URL`, identity default, degrade-on-failure). Hybrid retrieval fans out per-variant FTS legs (bounded vector legs ≤3) and fuses ALL legs with RRF; ACL predicates ride every leg. |
| FL-3.8 | Retrieval eval sets (recall@k dashboards) | IMPLEMENTED | `expected.document_ids` on eval cases; `evaluateRetrieval` runs the LIVE ACL-before-scoring retrieval per case and scores recall@k (k=1..20) + mean recall — `GET console/org/:orgId/eval/datasets/:id/recall`. On-demand (no materialization); dashboard rendering is a consumer concern. |
| FL-3.9 | Temporal memory metadata | IMPLEMENTED | `memory_items.valid_from / invalid_at / supersedes` (migration 0041) + validity predicates in retrieval. |
| FL-3.10 | Auto memory-extraction proposer | IMPLEMENTED | Flag-gated outbox consumer over `run.completed` proposing through the EXISTING memory-proposal pipeline (never durable truth by itself). |
| FL-3.11 | Pre-built tool template directory | IMPLEMENTED | Curated `TOOL_TEMPLATES` registry in code (Slack/GitHub/Zendesk/HubSpot/generic-GET/weather) + `GET tools/templates` + `POST tools/from-template` instantiating a real catalog row with the org's endpoint + sealed credential. |
| FL-3.12 | A/B / canary version rollout | IMPLEMENTED | Migration 0042 `assistant_rollouts` (RLS, one ACTIVE per assistant, weights sum 100, published-version validation). Sticky per-conversation assignment (sha256 hash on the weight axis) resolved at run-acceptance pinning — every run still PINS its version + snapshot. CRUD: `console/org/:orgId/assistants/:id/rollout`. |
| FL-3.13 | Online LLM-as-judge on sampled runs | IMPLEMENTED | `llm-judge` outbox consumer over `run.completed`: deterministic per-run sampling (`HARNESS__LLM_JUDGE_SAMPLE_PCT`), bounded input/output excerpt POSTed to the judge port, verdict in `run_judgments` (RLS, unique per run, scores only — transcripts re-read via claim-check). Judge endpoint = deployment seam. |
| FL-3.14 | OTel GenAI agent spans completion | IMPLEMENTED | `gen_ai.*` model spans at the gateway boundary in the inline executor (provider/model/turn attrs, usage input/output tokens at span end, error paths on cancel/budget abort) riding the existing OTel SDK with the pinned semconv mapping. |
| FL-3.15 | TS/Python SDKs + published OpenAPI | IMPLEMENTED | `products/sdk/typescript` (`@neryva/sdk`, dependency-free, SSE async iterator) + `products/sdk/python` (`neryva`, stdlib-only, typed, py.typed) + published OpenAPI 3.1 for the L2 surface at `engine/docs/public/openapi.l2.yaml`. |
| FL-3.16 | Quickstart templates / sample apps | IMPLEMENTED | `products/samples/quickstart-node` + `quickstart-python`: conversation → message → durable event stream → transcript with follow-ups. Standalone (not in build graphs). |
| FL-3.17 | New channels (Instagram, X, email) | IMPLEMENTED (OAuth apps + email provider = documented seams) | Platform vocabulary widened (additive CHECK widening, migration 0042): Instagram rides the Meta Graph contract (verify + X-Hub-Signature-256 + 24h window), X uses CRC + HMAC-SHA256 webhook + API v2 DMs, email uses inbound-parse webhooks (X-Webhook-Secret) + generic HTTP send seam (`CHANNELS__EMAIL_API_URL`). Provider OAuth apps and the hosted email API are per-deployment seams. |
| FL-3.18 | Interactive messages + template management | IMPLEMENTED (management UI = consumer) | WhatsApp interactive buttons sender (deterministic reply ids, bounded) + `channel_message_templates` (RLS) CRUD for provider-approved templates; the reply path treats button responses as plain bounded user text. Management UI is a consumer concern. |
| FL-3.19 | Inbound typing/read receipts | IMPLEMENTED | `message_receipts` (RLS, unique per message×account×state) upserted from Meta status events and the widget read marker; widget `typing` endpoint is EPHEMERAL by design (invariant 8) — 204 signal, nothing persisted. |
| FL-3.20 | Prompt/response snapshots to audit | IMPLEMENTED (seam noted) | Model I/O is claim-checked (`PutRunArtifact` TOOL_RESULT/CHECKPOINT purposes + ModelCallCompleted artifactRef); retention-classed storage. Full transcript snapshotting deliberately off by default (privacy). |
| FL-3.21 | End-user chat export (PDF/Markdown) | IMPLEMENTED | Markdown export route (org-scoped, audited); PDF rendering is a consumer-side concern. |

## Residual external seams (ops/vendor decisions, none block code)

1. Realtime voice vendor (OpenAI Realtime-class + LiveKit/Daily) — FL-3.1 v2v.
2. Image-generation endpoint deployment (`HARNESS__IMAGE_GEN_URL`) — any hosted or self-hosted model.
3. ASR/TTS endpoints (`CHANNELS__VOICE_ASR_URL`, `HARNESS__TTS_URL`) — Whisper-class / TTS-class services.
4. LLM-as-judge endpoint (`HARNESS__LLM_JUDGE_URL`) + rubric per deployment.
5. Query-rewrite endpoint (`HARNESS__QUERY_REWRITE_URL`) — a model-backed service.
6. X / Instagram / Meta OAuth apps + webhook registration per customer deployment.
7. Email provider (`CHANNELS__EMAIL_API_URL`) + inbound-parse subscription.
8. Sandbox backend deploy (FL-2.11, unchanged).
