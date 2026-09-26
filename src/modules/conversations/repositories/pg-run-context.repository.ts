/**
 * PostgreSQL run-context repository (P3) — authorized run context assembly
 * (ledger §5.5, harness H0.3).
 *
 * Mechanical move of the `McpAuthorityService` context-supply-chain units:
 * `getAuthorizedRunContext` (exposed as `assembleRunContext`),
 * `activeModelCatalogRows`, `resolveModelWindows`, `recordRetrievalEvent`,
 * `pinnedVersionIdsForRun`, and `runActorAccountId`.
 *
 * `assembleRunContext` owns its transaction: run + pinned snapshot reads,
 * history window, newest covering compaction summary, scoped approved
 * memories and knowledge retrieval via the injected hooks (the durable
 * retrieval event is written in the SAME unit — FL-2.9), catalog-resolved
 * tool descriptors with blocked/disabled tools withheld, budgets, guardrail
 * policy, brand voice.
 *
 * Retrieval itself is NOT a repository concern: the service injects the two
 * retrieval legs as `ContextRetrievalHooks`, called with the SAME arguments
 * the current implementation passes to `RetrievalService`. The model-catalog
 * read is a root/platform-plane read (documented posture) and degrades to
 * empty on failure — advisory data never fails context assembly.
 *
 * Observability note: the service's `withSpan('run.context', …)` wrapper
 * (P1 §6a) stays in the service; the guardrail-policy span attributes are
 * derived from the returned manifest there.
 */
import { createHash } from 'node:crypto';
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { Logger } from '@nestjs/common';
import { DbService } from '../../../common/infra/db/db.service';
import { ApiError } from '../../../common/http/api-error';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { qualifyModelAliases } from '../../../common/model-aliases';
import { spotlight, redactPii } from '../../../common/guardrails';
import { runs, messages, conversationSummaries, runEvents } from '../schema';
import { policySnapshots, assistantVersions, controlBlocks } from '../../assistants/schema';
import { toolCatalog } from '../../assistants/tool-catalog.schema';
import { BUILT_IN_TOOLS } from '../../assistants/tool-catalog.service';
import { modelCatalogEntries } from '../../assistants/model-catalog.schema';
import type { RunContextManifest } from './run-context-types';
import {
  composeSystemPrompt,
  resolvedPinVersionIds,
  type ApprovedMemoryRow,
  type ContextRetrievalHooks,
  type IRunContextRepository,
  type KnowledgeHitRow,
} from './run-context.repository';

/** Transaction type carried by `DbService.withOrg`. */
type PgTx = Parameters<Parameters<DbService['withOrg']>[1]>[0];

/** messages.created_by is a free varchar; scope_id is a uuid column. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Per-alias context windows from the platform catalog. Keyed by the same
 * (qualified) references carried in `allowed_models`, so Studio's pre-call
 * overflow check reads them with the identical key. Aliases with no catalog
 * entry map to null (unknown, never zero — zero would look like a real
 * 0-token window).
 */
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

export class PgRunContextRepository implements IRunContextRepository {
  private static readonly logger = new Logger(PgRunContextRepository.name);

  constructor(private readonly db: DbService) {}

  /**
   * P2 (overflow routing): alias → catalog context window. GLOBAL table, so
   * a root read with no tenant context (documented posture, like the
   * template registry). Only `active` entries answer; anything else is null
   * (unknown — Studio treats null as "no window truth", never as room).
   * Failure falls back to all-null (advisory data must never fail context
   * assembly — the run proceeds with aliases only, exactly as before P2).
   */
  private async activeModelCatalogRows(): Promise<
    Array<{ provider: string; modelId: string; window: number | null }>
  > {
    try {
      return await this.db.root
        .select({
          provider: modelCatalogEntries.provider,
          modelId: modelCatalogEntries.modelId,
          window: modelCatalogEntries.contextWindowTokens,
        })
        .from(modelCatalogEntries)
        .where(eq(modelCatalogEntries.status, 'active'));
    } catch (err) {
      PgRunContextRepository.logger.warn(
        `model catalog unavailable, aliases unresolved: ${(err as Error).message}`,
      );
      return [];
    }
  }

  /**
   * Assemble the bounded ContextManifest (contract v1.1): instructions +
   * model params (pinned snapshot), recent history, newest compaction
   * summary, approved memory CONTENT, knowledge retrieval on the trigger
   * message (ACL-before-scoring), tool descriptors with JSON Schemas from the
   * org tool catalog, and budgets. Every untrusted surface (knowledge,
   * memory) is spotlighted and — when the pinned guardrail policy asks for it
   * — PII-redacted before it leaves the Engine.
   */
  async assembleRunContext(
    input: { orgId: string; runId: string },
    hooks: ContextRetrievalHooks,
  ): Promise<RunContextManifest> {
    return this.db.withOrg(input.orgId, async (tx) => {
      const found = await tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1);
      if (found.length === 0) {
        throw ApiError.notFound('run');
      }
      const run = found[0];

      const snapshotRows = await tx
        .select()
        .from(policySnapshots)
        .where(eq(policySnapshots.id, run.policySnapshotId))
        .limit(1);
      const snapshot = snapshotRows[0] ?? null;
      const toolPolicy = (snapshot?.toolPolicy as {
        tools?: Array<{ name: string; access?: string; approval?: string }>;
      } | null) ?? { tools: [] };
      const pinnedTools = toolPolicy.tools ?? [];
      const contextPolicy =
        (snapshot?.contextPolicy as {
          history_limit?: number;
          knowledge_sources?: string[];
          memory_scope?: string;
        } | null) ?? {};
      const knowledgePolicy =
        (snapshot?.knowledgePolicy as {
          retrieval_enabled?: boolean;
          max_results?: number;
        } | null) ?? {};
      const guardrailPolicy =
        (snapshot?.guardrailPolicy as {
          input_policy?: string;
          output_policy?: string;
          pii_redaction?: boolean;
          execution_mode?: string;
        } | null) ?? {};
      const piiOff = guardrailPolicy.pii_redaction === false;
      // P3: legacy snapshots predate the field — resolve blocking (their
      // historical behavior), never undefined.
      const executionMode =
        guardrailPolicy.execution_mode === 'logging'
          ? ('logging' as const)
          : ('blocking' as const);
      const modelParams =
        (snapshot?.modelParams as {
          temperature?: number;
          max_output_tokens?: number;
          top_p?: number;
          reasoning_effort?: string;
        } | null) ?? null;
      const modelPolicy = (snapshot?.modelPolicy as { allowed_models?: string[] } | null) ?? {};
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
      // TEMP-DEBUG (wave-4 smoke only): prove the manifest carries qualified
      const modelWindows = resolveModelWindows(qualifiedModels, modelCatalogRows);
      const budgetPolicy =
        (snapshot?.budgetPolicy as {
          max_total_tokens?: number;
          max_cost_micros?: number;
          wall_clock_seconds?: number;
          max_tool_calls?: number;
          max_model_calls?: number;
        } | null) ?? {};

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
      const triggerRows = await tx
        .select({ createdBy: messages.createdBy })
        .from(messages)
        .where(eq(messages.id, run.inputMessageId))
        .limit(1);
      const triggerAuthor = triggerRows[0]?.createdBy ?? null;
      const runActorAccountId =
        triggerAuthor !== null && UUID_RE.test(triggerAuthor) ? triggerAuthor : null;
      const userAccountId = memoryScope === 'user' ? runActorAccountId : null;

      // A4-23: the assistant identity behind this run's pinned snapshot.
      // Resolved snapshot → version → assistant; unresolvable (deleted
      // version/assistant) yields NO assistant scopes — fail closed, never
      // a widening to another scope (same posture as the user branch).
      let runAssistantId: string | null = null;
      if (memoryScope === 'assistant' && snapshot?.assistantVersionId) {
        const versionRows = await tx
          .select({ assistantId: assistantVersions.assistantId })
          .from(assistantVersions)
          .where(eq(assistantVersions.id, snapshot.assistantVersionId))
          .limit(1);
        runAssistantId = versionRows[0]?.assistantId ?? null;
      }

      // History — bounded by the pinned context policy (contract caps 20).
      const historyLimit = Math.min(Math.max(1, contextPolicy.history_limit ?? 20), 20);
      const recent = await tx
        .select({
          id: messages.id,
          role: messages.role,
          content: messages.content,
          sequence: messages.sequence,
          artifactRefs: messages.artifactRefs,
        })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, run.conversationId),
            eq(messages.organizationId, input.orgId),
          ),
        )
        .orderBy(sql`sequence desc`)
        .limit(historyLimit);
      const orderedRecent = recent.reverse();
      const oldestIncludedSequence =
        orderedRecent.length > 0 ? orderedRecent[0].sequence : Number.MAX_SAFE_INTEGER;

      // Compaction — newest summary that covers material OUTSIDE the included
      // history window (source_sequence < oldest included message).
      let summaryText = '';
      if (orderedRecent.length > 0) {
        const summaryRows = await tx
          .select({ summary: conversationSummaries.summary })
          .from(conversationSummaries)
          .where(
            and(
              eq(conversationSummaries.organizationId, input.orgId),
              eq(conversationSummaries.conversationId, run.conversationId),
              sql`${conversationSummaries.sourceSequence} <= ${oldestIncludedSequence - 1}`,
            ),
          )
          .orderBy(desc(conversationSummaries.sourceSequence))
          .limit(1);
        summaryText = summaryRows[0]?.summary ?? '';
      }

      // Approved memories — scoped rows WITH content, selected by the pinned
      // memory_scope (FL-1.5). FL-2.4: selection is SEMANTIC — the trigger
      // message is the query; the retrieval leg orders by cosine similarity
      // with the scope OR-list inside the ranking statement (ACL-before-
      // scoring) and degrades to recency for zero signal / pre-0038 rows.
      // Proposals never surface here (Phase 7.8). Content is untrusted →
      // spotlight (+PII redact).
      const triggerText = [...orderedRecent].reverse().find((m) => m.role === 'user');
      const triggerQuery = String(
        (triggerText?.content as { text?: unknown } | null)?.text ?? '',
      );
      let memoryRows: ApprovedMemoryRow[] = [];
      if (memoryScope !== 'none') {
        const scopes =
          memoryScope === undefined
            ? // Legacy default: organization + conversation surfaces.
              [
                { scopeType: 'organization' as const },
                { scopeType: 'conversation' as const, scopeId: run.conversationId },
              ]
            : memoryScope === 'conversation'
              ? [{ scopeType: 'conversation' as const, scopeId: run.conversationId }]
              : memoryScope === 'organization'
                ? [{ scopeType: 'organization' as const }]
                : memoryScope === 'assistant'
                  ? // A4-23: assistant scope without a resolvable assistant
                    // (deleted version/assistant) yields NO scopes — zero
                    // assistant memories, never a widening to another scope.
                    runAssistantId !== null
                    ? [{ scopeType: 'assistant' as const, scopeId: runAssistantId }]
                    : []
                  : // user scope without a resolvable account (service/channel
                    // trigger) yields NO scopes — zero user memories, never a
                    // widening to another scope.
                    userAccountId !== null
                    ? [{ scopeType: 'user' as const, scopeId: userAccountId }]
                    : [];
        memoryRows = await hooks.searchApprovedMemories({
          orgId: input.orgId,
          query: triggerQuery,
          scopes,
          limit: 20,
        });
      }

      // Knowledge — retrieval over the newest user message when the pinned
      // policy enables it. ACL-before-scoring happens inside the retrieval
      // leg (the authorization predicates live in the retrieval query itself).
      let knowledgeRefs: Array<{
        documentId: string;
        chunkId: string;
        snippet?: string;
        title?: string;
        score?: number;
        sourceRangeStart?: number;
        sourceRangeEnd?: number;
      }> = [];
      if (knowledgePolicy.retrieval_enabled && triggerText) {
        const query = String((triggerText.content as { text?: unknown }).text ?? '').slice(
          0,
          512,
        );
        if (query.trim().length > 0) {
          const hits: KnowledgeHitRow[] = await hooks.searchKnowledge({
            orgId: input.orgId,
            query,
            limit: Math.min(Math.max(1, knowledgePolicy.max_results ?? 5), 20),
            // E-1: constrain to the snapshot's resolved pins (undefined =
            // unpinned legacy versions keep the org-wide posture).
            allowedDocumentVersionIds: resolvedPinVersionIds(snapshot),
            callerAccountId: runActorAccountId ?? undefined,
          });
          // FL-2.9 — the retrieval leg is a durable run event; CommitRunResult
          // reads it in the SAME TX as the terminal commit and pins bounded
          // citations onto the assistant message.
          await this.recordRetrievalEvent({
            orgId: input.orgId,
            runId: input.runId,
            query,
            hits,
            tx,
          });
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
      const catalogRows = pinnedTools.length
        ? await tx.select().from(toolCatalog).where(eq(toolCatalog.organizationId, input.orgId))
        : [];
      const catalogByName = new Map(catalogRows.map((r) => [r.name, r]));
      // TPL-6.3 — disabled or operator-blocked tools are withheld from the
      // served descriptors: the model is never offered what authorize would
      // deny. Silent on this read path by design (documented); authorize
      // denies loudly with audit — the decision point, not the read path.
      const blockRows = await tx
        .select({ targetName: controlBlocks.targetName })
        .from(controlBlocks)
        .where(
          and(
            eq(controlBlocks.organizationId, input.orgId),
            eq(controlBlocks.targetType, 'tool'),
            or(isNull(controlBlocks.expiresAt), sql`${controlBlocks.expiresAt} > now()`),
          ),
        );
      const blockedNames = new Set(blockRows.map((r) => r.targetName));
      const visibleTools = pinnedTools.filter((t) => {
        if (blockedNames.has(t.name)) return false;
        const entry = catalogByName.get(t.name);
        if (entry && !entry.enabled) return false;
        return true;
      });
      const tools = visibleTools.map((t) => {
        const entry = catalogByName.get(t.name);
        // Built-in tools (e.g. request_human_handoff) resolve without a
        // catalog row - the platform implements them (FL-1.7c).
        const builtin = BUILT_IN_TOOLS.get(t.name);
        const annotations = (entry?.annotations ?? {}) as {
          read_only?: boolean;
          destructive?: boolean;
          idempotent?: boolean;
          open_world?: boolean;
        };
        return {
          name: t.name,
          effectClass:
            entry?.effectClass ??
            builtin?.effectClass ??
            (t.access === 'read' ? 'READ_ONLY' : 'MUTATING'),
          approvalRequirement:
            entry?.approvalRequirement ??
            builtin?.approvalRequirement ??
            (t.approval === 'required' ? 'REQUIRED' : 'NONE'),
          description: entry?.description ?? builtin?.description ?? undefined,
          inputSchemaJson: entry
            ? JSON.stringify(entry.inputSchema)
            : builtin
              ? JSON.stringify(builtin.inputSchema)
              : undefined,
          httpBinding: entry
            ? ((entry.httpBinding ?? null) as {
                url: string;
                method: string;
                timeout_ms: number;
                header_name: string;
              } | null)
            : undefined,
          annotations: entry
            ? {
                readOnly: annotations.read_only ?? entry.effectClass === 'READ_ONLY',
                destructive: annotations.destructive ?? entry.effectClass === 'DESTRUCTIVE',
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
        recentMessages: orderedRecent.map((m) => {
          // FL-1.6 — pinned MESSAGE_ATTACHMENT claim-check refs; the runtime
          // fetches each via GetRunArtifact and builds provider image parts.
          const refs = Array.isArray(m.artifactRefs)
            ? (m.artifactRefs as Array<{
                artifact_id: string;
                media_type: string;
                byte_length: number;
                sha256: string;
                purpose: string;
              }>)
            : [];
          return {
            messageId: m.id,
            role: m.role,
            text: String((m.content as { text?: unknown }).text ?? '').slice(0, 8192),
            attachments: refs.slice(0, 4).map((r) => ({
              artifactId: r.artifact_id,
              mediaType: r.media_type,
              byteLength: r.byte_length,
              sha256: Buffer.from(r.sha256, 'hex'),
              purpose: r.purpose,
            })),
          };
        }),
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
              outputSchema: (modelParams as { output_schema?: string }).output_schema,
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

  /** E-1 — run-scoped pin allow-list for the agentic SearchKnowledge path. */
  async pinnedVersionIdsForRun(orgId: string, runId: string): Promise<string[] | undefined> {
    const found = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({ policySnapshotId: runs.policySnapshotId })
        .from(runs)
        .where(eq(runs.id, runId))
        .limit(1),
    );
    const snapshotId = found[0]?.policySnapshotId ?? null;
    if (!snapshotId) {
      return undefined;
    }
    const snapshots = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({ knowledgePins: policySnapshots.knowledgePins })
        .from(policySnapshots)
        .where(eq(policySnapshots.id, snapshotId))
        .limit(1),
    );
    return resolvedPinVersionIds((snapshots[0] ?? null) as { knowledgePins?: unknown } | null);
  }

  /** P0-1 — run actor account for source-ACL matching (trigger author iff an account id). */
  async runActorAccountId(orgId: string, runId: string): Promise<string | null> {
    const found = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({ inputMessageId: runs.inputMessageId })
        .from(runs)
        .where(eq(runs.id, runId))
        .limit(1),
    );
    const messageId = found[0]?.inputMessageId ?? null;
    if (!messageId) {
      return null;
    }
    const trigger = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({ createdBy: messages.createdBy })
        .from(messages)
        .where(eq(messages.id, messageId))
        .limit(1),
    );
    const author = trigger[0]?.createdBy ?? null;
    return author !== null && UUID_RE.test(author) ? author : null;
  }

  /**
   * FL-2.9 — durable retrieval event (wire EVENT_TYPE_RETRIEVAL → stored
   * '5', payload {case:'retrieval', value:{citations}}). eventId is
   * deterministic per (run, query) so a re-driven context assembly dedups;
   * the payload mirrors the transport's {case, value, redaction} envelope.
   */
  private async recordRetrievalEvent(input: {
    orgId: string;
    runId: string;
    query: string;
    hits: Array<{
      documentId: string;
      chunkId: string;
      sourceRange: { byteStart: number; byteEnd: number };
    }>;
    tx?: PgTx;
  }): Promise<void> {
    const citations = input.hits.slice(0, 10).map((h) => ({
      document_id: h.documentId,
      chunk_id: h.chunkId,
      source_range_start: h.sourceRange.byteStart,
      source_range_end: h.sourceRange.byteEnd,
    }));
    if (citations.length === 0) {
      return;
    }
    const eventId = `retr-${createHash('sha256').update(`${input.runId}:${input.query}`).digest('hex').slice(0, 56)}`;
    const insert = (tx: PgTx): Promise<unknown> =>
      tx
        .insert(runEvents)
        .values({
          id: uuidv7(),
          eventId,
          runId: input.runId,
          organizationId: input.orgId,
          eventType: '5',
          schemaVersion: 1,
          producerIdentity: 'engine:mcp-authority',
          payload: { case: 'retrieval', value: { citations }, redaction: 'NONE' } as never,
        })
        .onConflictDoNothing({ target: [runEvents.runId, runEvents.eventId] });
    if (input.tx) {
      await insert(input.tx);
      return;
    }
    await this.db.withOrg(input.orgId, insert);
  }
}
