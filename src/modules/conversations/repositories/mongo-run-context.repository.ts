/**
 * MongoDB run-context repository (P3) — the persistence port for authorized
 * run context assembly (`McpAuthorityService.getAuthorizedRunContext`,
 * §5.5).
 *
 * `assembleRunContext` owns its transaction: run + pinned snapshot reads,
 * history window, newest covering compaction summary, scoped approved
 * memories and knowledge retrieval via the injected hooks (the durable
 * retrieval event is written in the SAME unit — FL-2.9), catalog-resolved
 * tool descriptors with blocked/disabled tools withheld, budgets, guardrail
 * policy, brand voice.
 *
 * The model-catalog read is a root/platform-plane read (documented posture)
 * and degrades to empty on failure — advisory data never fails context
 * assembly.
 *
 * Retrieval itself is NOT a repository concern: the service injects the two
 * retrieval legs as `ContextRetrievalHooks` (backed by `RetrievalService`,
 * knowledge module), so this port has no cross-module service dependency.
 */
import { createHash } from 'crypto';
import { Logger } from '@nestjs/common';
import { MongoServerError } from 'mongodb';
import type { Binary, ClientSession, Db, Document, WithId } from 'mongodb';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { nowIso, uuidToBinary } from '../../../common/infra/db/mongo/mongo-tx';
import { nextSequence } from '../../../common/infra/db/mongo/concurrency/counters';
import { TenantScopedCollection } from '../../../common/infra/db/mongo/concurrency/tenant-guard';
import { ApiError } from '../../../common/http/api-error';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { spotlight, redactPii } from '../../../common/guardrails';
import { qualifyModelAliases } from '../../../common/model-aliases';
import { BUILT_IN_TOOL_DESCRIPTORS } from './mongo-tool-authority.repository';
import type { RunContextManifest } from './run-context-types';
import type {
  ApprovedMemoryRow,
  ContextRetrievalHooks,
  IRunContextRepository,
  KnowledgeHitRow,
} from './run-context.repository';
import { composeSystemPrompt, resolvedPinVersionIds } from './run-context.repository';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `runs` document — only the fields this repository reads. */
interface RunDoc extends Document {
  id: Binary;
  organization_id: Binary;
  conversation_id: Binary;
  input_message_id: Binary;
  assistant_version_id: Binary;
  policy_snapshot_id: Binary;
}

/** `policy_snapshots` document — only the fields this repository reads. */
interface PolicySnapshotDoc extends Document {
  id: Binary;
  organization_id: Binary;
  instructions: string | null;
  brand: string | null;
  tool_policy: {
    tools?: Array<{ name: string; access?: string; approval?: string }>;
  } | null;
  context_policy: {
    history_limit?: number;
    knowledge_sources?: string[];
    memory_scope?: string;
  } | null;
  knowledge_policy: {
    retrieval_enabled?: boolean;
    max_results?: number;
  } | null;
  guardrail_policy: {
    input_policy?: string;
    output_policy?: string;
    pii_redaction?: boolean;
    execution_mode?: string;
  } | null;
  model_params: {
    temperature?: number;
    max_output_tokens?: number;
    top_p?: number;
    reasoning_effort?: string;
    output_schema?: string;
  } | null;
  model_policy: {
    allowed_models?: string[];
  } | null;
  budget_policy: {
    max_total_tokens?: number;
    max_cost_micros?: number;
    wall_clock_seconds?: number;
    max_tool_calls?: number;
    max_model_calls?: number;
  } | null;
  knowledge_pins: unknown;
  assistant_version_id: string | null;
}

/** `messages` document — only the fields this repository reads. */
interface MessageDoc extends Document {
  id: Binary;
  organization_id: Binary;
  conversation_id: Binary;
  sequence: number;
  role: string;
  content: { text?: unknown } | null;
  created_by: string | null;
}

/** `conversation_summaries` document — only the fields this repository reads. */
interface ConversationSummaryDoc extends Document {
  organization_id: Binary;
  conversation_id: Binary;
  source_sequence: number;
  summary: string;
}

/** `assistant_versions` document — only the assistant-id lookup. */
interface AssistantVersionDoc extends Document {
  id: Binary;
  organization_id: Binary;
  assistant_id: string;
}

/** `tool_catalog` document — only the fields this repository reads. */
interface ToolCatalogDoc extends Document {
  id: Binary;
  organization_id: Binary;
  name: string;
  enabled: boolean;
  effect_class: string;
  approval_requirement: string;
  description: string | null;
  input_schema: Record<string, unknown>;
  annotations: {
    read_only?: boolean;
    destructive?: boolean;
    idempotent?: boolean;
    open_world?: boolean;
  } | null;
  http_binding: {
    url: string;
    method: string;
    timeout_ms: number;
    header_name: string;
  } | null;
}

/** `control_blocks` document — only the fields this repository reads. */
interface ControlBlockDoc extends Document {
  organization_id: Binary;
  target_type: string;
  target_name: string;
  expires_at: string | null;
}

/** `model_catalog_entries` document — platform plane (root read). */
interface ModelCatalogDoc extends Document {
  provider: string;
  model_id: string;
  context_window_tokens: number | null;
  status: string;
}

/** `run_events` document — only the fields the retrieval event writes. */
interface RunEventDoc extends Document {
  id: Binary;
  organization_id: Binary;
  run_id: Binary;
  event_id: string;
  event_type: string;
  schema_version: number;
  producer_identity: string;
  payload: Record<string, unknown>;
  engine_sequence: number;
  artifact_id: Binary | null;
  created_at: string;
}

type TxSession = { session: ClientSession };

function resolveModelWindows(
  aliases: string[],
  rows: Array<{ provider: string; modelId: string; window: number | null }>,
): Record<string, number | null> {
  const windows: Record<string, number | null> = {};
  for (const alias of aliases) {
    windows[alias] = null;
  }
  const byQualified = new Map(rows.map((r) => [`${r.provider}/${r.modelId}`, r.window]));
  for (const alias of aliases) {
    if (byQualified.has(alias)) {
      windows[alias] = byQualified.get(alias) ?? null;
    }
  }
  return windows;
}

export class MongoRunContextRepository implements IRunContextRepository {
  private static readonly logger = new Logger(MongoRunContextRepository.name);

  constructor(private readonly mongo: MongoDbService) {}

  private sessionOpt(ctx: MongoTxContext): TxSession {
    return { session: ctx.session };
  }

  private tenantOrgId(ctx: MongoTxContext): string {
    const orgId = ctx.orgId;
    if (!orgId) {
      throw new Error(
        'MongoRunContextRepository: tenant context required (unreachable under withOrg)',
      );
    }
    return orgId;
  }

  /**
   * Platform-plane model catalog read (root, no tenant session) — advisory
   * data, degrades to empty on failure, exactly like the pg lane's
   * `db.root` read.
   */
  private async activeModelCatalogRows(): Promise<
    Array<{ provider: string; modelId: string; window: number | null }>
  > {
    try {
      const rows = await this.mongo.root
        .collection<ModelCatalogDoc>('model_catalog_entries')
        .find({ status: 'active' })
        .project({ provider: 1, model_id: 1, context_window_tokens: 1 })
        .toArray();
      return rows.map((r) => ({
        provider: r.provider,
        modelId: r.model_id,
        window: r.context_window_tokens ?? null,
      }));
    } catch (err) {
      MongoRunContextRepository.logger.warn(
        `model catalog unavailable, aliases unresolved: ${(err as Error).message}`,
      );
      return [];
    }
  }

  /**
   * FL-2.9 — the retrieval leg is a durable run event; CommitRunResult reads
   * it in the SAME TX as the terminal commit and pins bounded citations onto
   * the assistant message. Deterministic event id; duplicate
   * (run_id, event_id) is ignored.
   */
  private async recordRetrievalEvent(
    db: Db,
    s: TxSession,
    orgId: string,
    runId: string,
    query: string,
    hits: KnowledgeHitRow[],
  ): Promise<void> {
    const citations = hits.slice(0, 10).map((h) => ({
      document_id: h.documentId,
      chunk_id: h.chunkId,
      source_range_start: h.sourceRange.byteStart,
      source_range_end: h.sourceRange.byteEnd,
    }));
    if (citations.length === 0) {
      return;
    }
    const eventId = `retr-${createHash('sha256')
      .update(`${runId}:${query}`)
      .digest('hex')
      .slice(0, 56)}`;
    const runEvents = new TenantScopedCollection<RunEventDoc>(db.collection('run_events'));
    const doc: RunEventDoc = {
      id: uuidToBinary(uuidv7()),
      organization_id: uuidToBinary(orgId),
      run_id: uuidToBinary(runId),
      event_id: eventId,
      event_type: '5',
      schema_version: 1,
      producer_identity: 'engine:mcp-authority',
      payload: { case: 'retrieval', value: { citations }, redaction: 'NONE' } as unknown as Record<
        string,
        unknown
      >,
      engine_sequence: await nextSequence(db, `run_events:${runId}`, s),
      artifact_id: null,
      created_at: nowIso(),
    };
    try {
      await runEvents.insertOne(orgId, doc, s);
    } catch (err) {
      // onConflictDoNothing on (run_id, event_id): a retried assembly with
      // the same query replays silently.
      if (!(err instanceof MongoServerError) || err.code !== 11000) throw err;
    }
  }

  async assembleRunContext(
    input: { orgId: string; runId: string },
    hooks: ContextRetrievalHooks,
  ): Promise<RunContextManifest> {
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const db = this.mongo.root;
      const s = this.sessionOpt(ctx);
      const orgId = this.tenantOrgId(ctx);

      const runs = new TenantScopedCollection<RunDoc>(db.collection('runs'));
      const runRow = await runs.findOne(orgId, { id: uuidToBinary(input.runId) }, s);
      if (!runRow) {
        throw ApiError.notFound('run');
      }
      const run = {
        id: runRow.id.toUUID().toString(),
        conversationId: runRow.conversation_id.toUUID().toString(),
        inputMessageId: runRow.input_message_id.toUUID().toString(),
        assistantVersionId: runRow.assistant_version_id.toUUID().toString(),
        policySnapshotId: runRow.policy_snapshot_id.toUUID().toString(),
      };

      const snapshots = new TenantScopedCollection<PolicySnapshotDoc>(
        db.collection('policy_snapshots'),
      );
      const snapshot: WithId<PolicySnapshotDoc> | null = await snapshots.findOne(
        orgId,
        { id: runRow.policy_snapshot_id },
        s,
      );
      const toolPolicy = snapshot?.tool_policy ?? { tools: [] };
      const pinnedTools = toolPolicy.tools ?? [];
      const contextPolicy = snapshot?.context_policy ?? {};
      const knowledgePolicy = snapshot?.knowledge_policy ?? {};
      const guardrailPolicy = snapshot?.guardrail_policy ?? {};
      const piiOff = guardrailPolicy.pii_redaction === false;
      // P3: legacy snapshots predate the field — resolve blocking (their
      // historical behavior), never undefined.
      const executionMode =
        guardrailPolicy.execution_mode === 'logging' ? ('logging' as const) : ('blocking' as const);
      const modelParams = snapshot?.model_params ?? null;
      const modelPolicy = snapshot?.model_policy ?? {};
      const allowedModels = Array.isArray(modelPolicy.allowed_models)
        ? modelPolicy.allowed_models.slice(0, 16)
        : [];
      // Model identity: the manifest contract requires provider/model
      // references (context.proto). Bare aliases pinned in the snapshot are
      // qualified here via the platform catalog; unresolvable ones pass
      // through and fail loudly in Studio (fail-closed, never guessed).
      // The same qualified references key modelWindows, so Studio's
      // pre-call overflow check reads them with the identical key.
      const modelCatalogRows = await this.activeModelCatalogRows();
      const qualifiedModels = qualifyModelAliases(allowedModels, modelCatalogRows);
      const modelWindows = resolveModelWindows(qualifiedModels, modelCatalogRows);
      const budgetPolicy = snapshot?.budget_policy ?? {};

      // FL-1.5 — the pinned memory_scope decides WHICH memory surfaces the
      // manifest carries. Undefined keeps the legacy default (organization +
      // conversation rows) for pre-FL-1.5 snapshots; 'none' excludes the
      // surface entirely; 'user' resolves the run actor's account via the
      // trigger message — user-scoped rows are NEVER visible across accounts;
      // 'assistant' (A4-23) resolves this run's assistant via the pinned
      // snapshot → version — assistant-scoped rows are the agent's own
      // memory, visible only to its own runs.
      const memoryScopeRaw =
        typeof contextPolicy.memory_scope === 'string' ? contextPolicy.memory_scope : undefined;
      const memoryScope =
        memoryScopeRaw === 'user' ||
        memoryScopeRaw === 'organization' ||
        memoryScopeRaw === 'conversation' ||
        memoryScopeRaw === 'assistant' ||
        memoryScopeRaw === 'none'
          ? memoryScopeRaw
          : undefined;
      // Run actor: the trigger message author when it is an account id.
      // Drives user-scoped memory AND source-ACL identity (P0-1) — the two
      // concerns share one lookup but diverge after: memory keeps the legacy
      // scope default, source matching always uses the actor when known.
      const messages = new TenantScopedCollection<MessageDoc>(db.collection('messages'));
      const triggerRows = await messages.findOne(
        orgId,
        { id: runRow.input_message_id },
        { ...s, projection: { created_by: 1 } },
      );
      const triggerAuthor = triggerRows?.created_by ?? null;
      const runActorAccountId =
        triggerAuthor !== null && UUID_RE.test(triggerAuthor) ? triggerAuthor : null;
      const userAccountId = memoryScope === 'user' ? runActorAccountId : null;

      // A4-23: the assistant identity behind this run's pinned snapshot.
      // Resolved snapshot → version → assistant; unresolvable (deleted
      // version/assistant) yields NO assistant scopes — fail closed, never
      // a widening to another scope (same posture as the user branch).
      let runAssistantId: string | null = null;
      if (memoryScope === 'assistant' && snapshot?.assistant_version_id) {
        const versions = new TenantScopedCollection<AssistantVersionDoc>(
          db.collection('assistant_versions'),
        );
        const versionRows = await versions.findOne(
          orgId,
          { id: uuidToBinary(snapshot.assistant_version_id) },
          { ...s, projection: { assistant_id: 1 } },
        );
        runAssistantId = versionRows?.assistant_id ?? null;
      }

      // History — bounded by the pinned context policy (contract caps 20).
      const historyLimit = Math.min(Math.max(1, contextPolicy.history_limit ?? 20), 20);
      const recentDesc = await messages
        .find(
          orgId,
          { conversation_id: runRow.conversation_id },
          { ...s, sort: { sequence: -1 }, limit: historyLimit },
        )
        .toArray();
      const orderedRecent = [...recentDesc].reverse();
      const oldestIncludedSequence =
        orderedRecent.length > 0 ? orderedRecent[0].sequence : Number.MAX_SAFE_INTEGER;

      // Compaction — newest summary that covers material OUTSIDE the included
      // history window (source_sequence < oldest included message).
      let summaryText = '';
      if (orderedRecent.length > 0) {
        const summaries = new TenantScopedCollection<ConversationSummaryDoc>(
          db.collection('conversation_summaries'),
        );
        const summaryRow = await summaries.findOne(
          orgId,
          {
            conversation_id: runRow.conversation_id,
            source_sequence: { $lte: oldestIncludedSequence - 1 },
          },
          { ...s, sort: { source_sequence: -1 }, projection: { summary: 1 } },
        );
        summaryText = summaryRow?.summary ?? '';
      }

      // Approved memories — scoped rows WITH content, selected by the pinned
      // memory_scope (FL-1.5). FL-2.4: selection is SEMANTIC — the trigger
      // message is the query; RetrievalService orders by cosine similarity
      // with the scope OR-list inside the ranking statement (ACL-before-
      // scoring) and degrades to recency for zero signal / pre-0038 rows.
      // Proposals never surface here (Phase 7.8). Content is untrusted →
      // spotlight (+PII redact).
      const triggerText = [...orderedRecent].reverse().find((m) => m.role === 'user');
      const triggerQuery = String(triggerText?.content?.text ?? '');
      let memoryRows: ApprovedMemoryRow[] = [];
      if (memoryScope !== 'none') {
        const scopes: Array<{
          scopeType: 'organization' | 'conversation' | 'user' | 'assistant';
          scopeId?: string;
        }> =
          memoryScope === undefined
            ? // Legacy default: organization + conversation surfaces.
              [{ scopeType: 'organization' }, { scopeType: 'conversation', scopeId: run.conversationId }]
            : memoryScope === 'conversation'
              ? [{ scopeType: 'conversation', scopeId: run.conversationId }]
              : memoryScope === 'organization'
                ? [{ scopeType: 'organization' }]
                : memoryScope === 'assistant'
                  ? // A4-23: assistant scope without a resolvable assistant
                    // (deleted version/assistant) yields NO scopes — zero
                    // assistant memories, never a widening to another scope.
                    runAssistantId !== null
                    ? [{ scopeType: 'assistant', scopeId: runAssistantId }]
                    : []
                  : // user scope without a resolvable account (service/channel
                    // trigger) yields NO scopes — zero user memories, never a
                    // widening to another scope.
                    userAccountId !== null
                    ? [{ scopeType: 'user', scopeId: userAccountId }]
                    : [];
        memoryRows = await hooks.searchApprovedMemories({
          orgId: input.orgId,
          query: triggerQuery,
          scopes,
          limit: 20,
        });
      }

      // Knowledge — retrieval over the newest user message when the pinned
      // policy enables it. ACL-before-scoring happens inside RetrievalService
      // (the authorization predicates live in the retrieval query itself).
      let knowledgeRefs: RunContextManifest['knowledgeRefs'] = [];
      if (knowledgePolicy.retrieval_enabled && triggerText) {
        const query = String(triggerText.content?.text ?? '').slice(0, 512);
        if (query.trim().length > 0) {
          const hits = await hooks.searchKnowledge({
            orgId: input.orgId,
            query,
            limit: Math.min(Math.max(1, knowledgePolicy.max_results ?? 5), 20),
            // E-1: constrain to the snapshot's resolved pins (undefined =
            // unpinned legacy versions keep the org-wide posture).
            allowedDocumentVersionIds: resolvedPinVersionIds(
              snapshot ? { knowledgePins: snapshot.knowledge_pins } : null,
            ),
            callerAccountId: runActorAccountId ?? undefined,
          });
          // FL-2.9 — the retrieval leg is a durable run event; CommitRunResult
          // reads it in the SAME TX as the terminal commit and pins bounded
          // citations onto the assistant message.
          await this.recordRetrievalEvent(db, s, orgId, input.runId, query, hits);
          knowledgeRefs = hits.map((h) => {
            const snippet = piiOff ? h.text : redactPii(h.text).redacted;
            return {
              documentId: h.documentId,
              chunkId: h.chunkId,
              snippet: spotlight({ source: 'knowledge', content: snippet.slice(0, 4096) }),
              title: h.title ?? undefined,
              score: h.score,
              sourceRangeStart: h.sourceRange.byteStart,
              sourceRangeEnd: h.sourceRange.byteEnd,
            };
          });
        }
      }

      // Tools — resolve pinned tool policy entries against the org catalog;
      // entries missing from the catalog degrade to name-only descriptors so
      // a legacy definition still runs (the model sees no schema for them and
      // AuthorizeToolCall still gates execution).
      const catalog = new TenantScopedCollection<ToolCatalogDoc>(
        db.collection('tool_catalog'),
      );
      const catalogRows =
        pinnedTools.length > 0 ? await catalog.find(orgId, {}, s).toArray() : [];
      const catalogByName = new Map(catalogRows.map((r) => [r.name, r]));
      // TPL-6.3 — disabled or operator-blocked tools are withheld from the
      // served descriptors: the model is never offered what authorize would
      // deny. Silent on this read path by design (documented); authorize
      // denies loudly with audit — the decision point, not the read path.
      const blocks = new TenantScopedCollection<ControlBlockDoc>(
        db.collection('control_blocks'),
      );
      const blockRows = await blocks
        .find(
          orgId,
          {
            target_type: 'tool',
            $or: [{ expires_at: null }, { expires_at: { $gt: nowIso() } }],
          },
          { ...s, projection: { target_name: 1 } },
        )
        .toArray();
      const blockedNames = new Set(blockRows.map((r) => r.target_name));
      const visibleTools = pinnedTools.filter((t) => {
        if (blockedNames.has(t.name)) return false;
        const entry = catalogByName.get(t.name);
        if (entry && !entry.enabled) return false;
        return true;
      });
      const tools: RunContextManifest['tools'] = visibleTools.map((t) => {
        const entry = catalogByName.get(t.name);
        // Built-in tools (e.g. request_human_handoff) resolve without a
        // catalog row - the platform implements them (FL-1.7c).
        const builtin = BUILT_IN_TOOL_DESCRIPTORS.get(t.name);
        const annotations = entry?.annotations ?? {};
        return {
          name: t.name,
          effectClass:
            entry?.effect_class ??
            builtin?.effectClass ??
            (t.access === 'read' ? 'READ_ONLY' : 'MUTATING'),
          approvalRequirement:
            entry?.approval_requirement ??
            builtin?.approvalRequirement ??
            (t.approval === 'required' ? 'REQUIRED' : 'NONE'),
          description: entry?.description ?? builtin?.description ?? undefined,
          inputSchemaJson: entry
            ? JSON.stringify(entry.input_schema)
            : builtin
              ? JSON.stringify(builtin.inputSchema)
              : undefined,
          httpBinding: entry ? (entry.http_binding ?? null) : undefined,
          annotations: entry
            ? {
                readOnly: annotations.read_only ?? entry.effect_class === 'READ_ONLY',
                destructive: annotations.destructive ?? entry.effect_class === 'DESTRUCTIVE',
                idempotent: annotations.idempotent ?? false,
                openWorld: annotations.open_world ?? false,
              }
            : undefined,
        };
      });

      return {
        assistantVersionId: run.assistantVersionId,
        policyVersion: run.policySnapshotId,
        runUserId: runActorAccountId,
        conversationSummary: summaryText,
        recentMessages: orderedRecent.map((m) => ({
          messageId: m.id.toUUID().toString(),
          role: m.role,
          text: String(m.content?.text ?? '').slice(0, 8192),
        })),
        memories: memoryRows.map((m) => {
          const content = piiOff ? m.content : redactPii(m.content).redacted;
          return {
            memoryId: m.id,
            scope: m.scopeType,
            scopeId: m.scopeId ?? undefined,
            provenance: m.provenance ?? '',
            content: spotlight({ source: 'memory', content: content.slice(0, 2048) }),
            contentMediaType: 'text/plain',
          };
        }),
        knowledgeRefs,
        tools,
        artifactRefs: [],
        instructions: composeSystemPrompt(snapshot?.instructions ?? null, snapshot?.brand ?? null),
        brandVoice: snapshot?.brand ?? undefined,
        allowedModels: qualifiedModels,
        modelWindows,
        modelParams: modelParams
          ? {
              temperature: modelParams.temperature,
              maxOutputTokens: modelParams.max_output_tokens,
              topP: modelParams.top_p,
              reasoningEffort: modelParams.reasoning_effort,
              outputSchema: modelParams.output_schema,
            }
          : undefined,
        budgets: {
          maxToolCalls: budgetPolicy.max_tool_calls ?? 8,
          maxModelCalls: budgetPolicy.max_model_calls ?? 16,
          maxOutputBytes: 262144n,
          maxTotalTokens: BigInt(budgetPolicy.max_total_tokens ?? 200_000),
          maxCostMicros: BigInt(budgetPolicy.max_cost_micros ?? 0),
          wallClockSeconds: budgetPolicy.wall_clock_seconds ?? 0,
        },
        guardrailPolicy: {
          inputPolicy: guardrailPolicy.input_policy ?? 'default',
          outputPolicy: guardrailPolicy.output_policy ?? 'default',
          piiRedaction: !piiOff,
          executionMode,
        },
      };
    });
  }

  /**
   * E-1 — run-scoped pin lookup for the agentic SearchKnowledge path.
   * Returns undefined when the snapshot declares no pins (legacy org-wide
   * posture preserved); otherwise the resolved document_version ids.
   */
  async pinnedVersionIdsForRun(orgId: string, runId: string): Promise<string[] | undefined> {
    return this.mongo.withOrg(orgId, async (ctx) => {
      const org = this.tenantOrgId(ctx);
      const s = this.sessionOpt(ctx);
      const runs = new TenantScopedCollection<RunDoc>(this.mongo.root.collection('runs'));
      const runRow = await runs.findOne(
        org,
        { id: uuidToBinary(runId) },
        { ...s, projection: { policy_snapshot_id: 1 } },
      );
      const snapshotId = runRow?.policy_snapshot_id ?? null;
      if (!snapshotId) {
        return undefined;
      }
      const snapshots = new TenantScopedCollection<PolicySnapshotDoc>(
        this.mongo.root.collection('policy_snapshots'),
      );
      const snapshotRow = await snapshots.findOne(
        org,
        { id: snapshotId },
        { ...s, projection: { knowledge_pins: 1 } },
      );
      return resolvedPinVersionIds(
        snapshotRow ? { knowledgePins: snapshotRow.knowledge_pins } : null,
      );
    });
  }

  /**
   * P0-1 — run actor account for source-ACL matching: the trigger (input)
   * message author, iff it is an account id.
   */
  async runActorAccountId(orgId: string, runId: string): Promise<string | null> {
    return this.mongo.withOrg(orgId, async (ctx) => {
      const org = this.tenantOrgId(ctx);
      const s = this.sessionOpt(ctx);
      const runs = new TenantScopedCollection<RunDoc>(this.mongo.root.collection('runs'));
      const runRow = await runs.findOne(
        org,
        { id: uuidToBinary(runId) },
        { ...s, projection: { input_message_id: 1 } },
      );
      const messageId = runRow?.input_message_id ?? null;
      if (!messageId) {
        return null;
      }
      const messages = new TenantScopedCollection<MessageDoc>(
        this.mongo.root.collection('messages'),
      );
      const trigger = await messages.findOne(
        org,
        { id: messageId },
        { ...s, projection: { created_by: 1 } },
      );
      const createdBy = trigger?.created_by ?? null;
      return createdBy !== null && UUID_RE.test(createdBy) ? createdBy : null;
    });
  }
}
