import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { ConfigPublishService } from '../config-publish/config-publish.service';
import type {
  Assistant,
  AssistantVersion,
  PolicySnapshot,
  AssistantVersionExport,
} from './schema';
import {
  validateAssistantPayload,
  assertPublishable,
  assistantPayloadSchema,
  rejectUnknownPayloadKeys,
  AssistantPayload,
} from './validation';
import { TemplatesService } from './templates.service';
import { undercoveredPinSlugs, unresolvedPinSlugs } from './manifest-resolution.service';
import { ConversationsService } from '../conversations/conversations.service';
import { EvalService } from '../knowledge/eval.service';
import { BUILT_IN_TOOLS, ToolCatalogService } from './tool-catalog.service';
import { canonicalHash } from '../../common/crypto/canonical-hash';
import { normalizeResidency, modelServesResidency, Residency } from './residency';
import { ModelCatalogService, unknownPlatformModels } from './model-catalog.service';
import {
  ASSISTANT_REPOSITORY,
  ASSISTANT_VERSION_REPOSITORY,
  POLICY_SNAPSHOT_REPOSITORY,
  ASSISTANT_KNOWLEDGE_QUERIES,
  type IAssistantRepository,
  type IAssistantVersionRepository,
  type IPolicySnapshotRepository,
  type IAssistantKnowledgeQueries,
  type VersionPayloadValues,
} from './repositories/tokens';

/**
 * Assistants domain — Phase 3.1-3.3
 *
 * Stable identity (`assistants`) + immutable history (`assistant_versions`).
 * Publish never mutates a row — it inserts a new PUBLISHED version and moves
 * `assistants.active_version_id` atomically under a per-assistant advisory
 * lock (same pattern as `src/modules/config-publish/config-publish.service.ts:92`).
 *
 * In-flight runs remain pinned to the `assistant_version_id` they were
 * created with — tested in Phase 4.4. discardDraft owns the draft-pinned
 * test runs (deleted in the same transaction; see A2-21), but nothing else
 * in this service mutates runs.
 */
@Injectable()
export class AssistantsService {
  private static readonly logger = new Logger(AssistantsService.name);

  constructor(
    @Inject(ASSISTANT_REPOSITORY) private readonly assistants: IAssistantRepository,
    @Inject(ASSISTANT_VERSION_REPOSITORY) private readonly versions: IAssistantVersionRepository,
    @Inject(POLICY_SNAPSHOT_REPOSITORY) private readonly snapshots: IPolicySnapshotRepository,
    @Inject(ASSISTANT_KNOWLEDGE_QUERIES)
    private readonly knowledgeQueries: IAssistantKnowledgeQueries,
    private readonly audit: AuditService,
    private readonly configPublish: ConfigPublishService,
    private readonly templates: TemplatesService,
    private readonly evals: EvalService,
    private readonly conversations: ConversationsService,
    private readonly modelCatalog: ModelCatalogService,
    private readonly toolCatalog: ToolCatalogService,
  ) {}

  // ── Assistants (identity) ────────────────────────────────────────────────

  /**
   * TPL-2.1 — three modes, one route. Name-only keeps back-compat; `template`
   * installs a registry template (copy into assistant + DRAFT version +
   * install record + provisioning outbox, atomically); `definition` lands a
   * full Engine-subset payload (assistant + DRAFT version, atomically).
   * `template` and `definition` together are a 422 — install is copy from
   * exactly one source.
   *
   * Consumer contract (plan §7.3 item 3): the response carries the assistant
   * PLUS the install provenance — version_id, `slug@version` (template path
   * only), and the content hash — so a client never needs a second read to
   * know what landed.
   */
  async create(input: {
    orgId: string;
    name: string;
    description?: string | null;
    createdBy: string;
    template?: { slug: string; version?: string };
    definition?: Record<string, unknown>;
  }): Promise<{
    assistant: Assistant;
    version_id: string | null;
    template: string | null;
    hash: string | null;
  }> {
    assertOrgId(input.orgId);
    assertName(input.name);
    if (input.template && input.definition) {
      throw ApiError.validation({
        template:
          'template and definition are mutually exclusive — install copies from exactly one source',
      });
    }
    if (input.template) {
      const installed = await this.templates.install({
        orgId: input.orgId,
        slug: input.template.slug,
        version: input.template.version,
        name: input.name,
        actorId: input.createdBy,
      });
      return {
        assistant: installed.assistant,
        version_id: installed.version.id,
        template: `${installed.install.slug}@${installed.install.templateVersion}`,
        hash: installed.version.hash,
      };
    }
    if (input.definition) {
      const normalized = rejectUnknownPayloadKeys(input.definition);
      const validated = validateAssistantPayload(normalized);
      if (!validated.ok) {
        throw ApiError.validation({ assistant: validated.issues });
      }
      const hash = hashPayload(validated.normalized);
      // One transaction: assistant identity + DRAFT version commit together —
      // a failed version insert must never leave a versionless assistant.
      // Transaction ownership and unique-violation mapping live in the
      // repository; the raw name is passed so conflict details match.
      const created = await this.assistants.createAssistantWithDraftVersion({
        orgId: input.orgId,
        name: input.name,
        description: input.description,
        versionValues: {
          ...toVersionPayloadValues(validated.normalized),
          parentVersionId: null,
          hash,
        },
      });
      const assistant = created.assistant;
      const versionId = created.versionId;
      await this.audit.add({
        action: 'assistant.created',
        resourceType: 'assistant',
        resourceId: assistant.id,
        actorType: 'account',
        actorId: input.createdBy,
        tenantId: input.orgId,
        details: { name: assistant.name, from: 'definition' },
      });
      await this.audit.add({
        action: 'assistant.version_drafted',
        resourceType: 'assistant_version',
        resourceId: versionId,
        actorType: 'account',
        actorId: input.createdBy,
        tenantId: input.orgId,
        details: { assistant_id: assistant.id, hash: hash.slice(0, 16) },
      });
      return { assistant, version_id: versionId, template: null, hash };
    }
    // Transaction ownership and unique-violation mapping live in the
    // repository; the raw name is passed so conflict details match.
    const row = await this.assistants.createAssistant({
      orgId: input.orgId,
      name: input.name,
      description: input.description,
    });
    await this.audit.add({
      action: 'assistant.created',
      resourceType: 'assistant',
      resourceId: row.id,
      actorType: 'account',
      actorId: input.createdBy,
      tenantId: input.orgId,
      details: { name: row.name },
    });
    return { assistant: row, version_id: null, template: null, hash: null };
  }

  async get(orgId: string, assistantId: string): Promise<Assistant | null> {
    assertOrgId(orgId);
    assertUuid(assistantId);
    return this.assistants.getAssistant(orgId, assistantId);
  }

  async list(orgId: string): Promise<Assistant[]> {
    assertOrgId(orgId);
    return this.assistants.listAssistants(orgId);
  }

  /**
   * Deletes an assistant. Conversations are the audit plane: an assistant with
   * ACTIVE conversations cannot be deleted (409). Conversations that are
   * already archived or deleted are removed in the same transaction — archiving
   * is the documented prerequisite ("archive them before deleting"), so a
   * fully-archived assistant is deletable. Message/participant/event rows
   * cascade from the conversation delete.
   */
  async remove(input: {
    orgId: string;
    assistantId: string;
    actorId: string;
  }): Promise<{ ok: true }> {
    assertOrgId(input.orgId);
    assertUuid(input.assistantId);
    // P5-B12: the active check, the retired-conversation delete, and the
    // assistant delete all run inside ONE transaction. The old code
    // hard-deleted the assistant row and relied on the FK catch — but
    // archiving never cleared the FK, so the documented "archive them before
    // deleting" workflow could never succeed. Transaction ownership and
    // race/FK conflict mapping live in the repository.
    try {
      const deleted = await this.assistants.deleteAssistantWithRetiredConversations(
        input.orgId,
        input.assistantId,
      );
      await this.audit.add({
        action: 'assistant.deleted',
        resourceType: 'assistant',
        resourceId: input.assistantId,
        actorType: 'account',
        actorId: input.actorId,
        tenantId: input.orgId,
        details: { name: deleted.name, conversationsRemoved: deleted.conversationsRemoved },
      });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      // FK violation — an active conversation landed between the check and the
      // delete (race); the caller should archive and retry.
      throw ApiError.conflict('assistant has active conversations — archive them before deleting');
    }
    return { ok: true };
  }

  // ── Versions ─────────────────────────────────────────────────────────────

  /**
   * TPL-6.3 — assistant kill flag. Set blocks run acceptance for the whole
   * assistant (in-flight runs fail closed at their next tool authorization);
   * cleared resumes it. Both transitions audited. Idempotent.
   */
  async setDisabled(input: {
    orgId: string;
    assistantId: string;
    disabled: boolean;
    reason?: string;
    actorId: string;
  }): Promise<Assistant> {
    assertOrgId(input.orgId);
    assertUuid(input.assistantId);
    // Transaction ownership and the 404 live in the repository.
    const row = await this.assistants.setDisabled(input.orgId, input.assistantId, input.disabled, {
      reason: input.reason,
      actorId: input.actorId,
    });
    await this.audit.add({
      action: input.disabled ? 'assistant.disabled' : 'assistant.enabled',
      resourceType: 'assistant',
      resourceId: input.assistantId,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      details: input.disabled ? { reason: row.disabledReason } : {},
    });
    return row;
  }

  async createVersion(input: {
    orgId: string;
    assistantId: string;
    payload: AssistantPayload;
    createdBy: string;
  }): Promise<AssistantVersion> {
    assertOrgId(input.orgId);
    assertUuid(input.assistantId);
    const assistant = await this.requireAssistant(input.orgId, input.assistantId);

    // P6 (lineage): a new draft forks the ACTIVE version (the state being
    // edited). First draft on a versionless assistant parents null.
    const parentVersionId = assistant.activeVersionId ?? null;

    // Strict chain, identical to definition-create and draft-update: unknown
    // keys refuse (never silently stripped), then shape validation. A draft
    // carrying template-only extensions must fail loudly at write time.
    const strict = rejectUnknownPayloadKeys(input.payload as Record<string, unknown>);
    const validated = validateAssistantPayload(strict);
    if (!validated.ok) {
      throw ApiError.validation({ assistant: validated.issues });
    }
    const hash = hashPayload(validated.normalized);

    // DRAFT is always a new row; version is assigned only on publish. The
    // (assistant_id, version=0) sentinel is unique — a second draft before
    // the first is published surfaces as a typed 409, never a raw 23505.
    // Unique-violation mapping lives in the repository. Unknown keys refuse
    // here exactly like the definition-create path (rejectUnknownPayloadKeys
    // runs inside validateAssistantPayload's callers — see updateDraft for
    // the shared strict chain).
    const row = await this.versions.createDraftVersion({
      orgId: input.orgId,
      assistantId: input.assistantId,
      payloadValues: { ...toVersionPayloadValues(validated.normalized), parentVersionId, hash },
    });
    await this.audit.add({
      action: 'assistant.version_drafted',
      resourceType: 'assistant_version',
      resourceId: row.id,
      actorType: 'account',
      actorId: input.createdBy,
      tenantId: input.orgId,
      details: { assistant_id: input.assistantId, hash: hash.slice(0, 16) },
    });
    return row;
  }

  /**
   * Iterative draft editing with optimistic concurrency. DRAFT rows are
   * otherwise write-once (createVersion inserts; publish consumes), so two
   * authors saving the same draft would silently clobber without this:
   * the single-statement UPDATE matches id + DRAFT status + expected hash,
   * and a miss resolves to 404 / 409-not-draft / 412-stale — never a silent
   * overwrite. If-Match is REQUIRED (fail closed); the hash comes from any
   * version GET. Same-hash saves succeed idempotently (autosave-safe).
   */
  async updateDraft(input: {
    orgId: string;
    assistantId: string;
    versionId: string;
    payload: unknown;
    expectedHash: string;
    actorId: string;
  }): Promise<AssistantVersion> {
    assertOrgId(input.orgId);
    assertUuid(input.assistantId);
    assertUuid(input.versionId);
    if (!input.expectedHash || typeof input.expectedHash !== 'string') {
      throw ApiError.validation({ 'if-match': 'If-Match header with the draft hash is required' });
    }
    const strict = rejectUnknownPayloadKeys(input.payload as Record<string, unknown>);
    const validated = validateAssistantPayload(strict);
    if (!validated.ok) {
      throw ApiError.validation({ assistant: validated.issues });
    }
    const hash = hashPayload(validated.normalized);
    // P6: rebase lineage on every edit — a draft saved while v3 is active
    // derives from v3's state, not from whatever was active when the draft
    // row was first created (one PK read; negligible beside the update).
    // Same-hash idempotent saves rebase harmlessly (same value rewritten).
    const assistant = await this.assistants.getAssistant(input.orgId, input.assistantId);
    const rebasedParent = assistant?.activeVersionId ?? null;
    // The conditional UPDATE and OCC-miss classification live in the
    // repository; the single statement still matches id + DRAFT status +
    // expected hash so two authors never silently clobber.
    const row = await this.versions.updateDraftContent({
      orgId: input.orgId,
      assistantId: input.assistantId,
      versionId: input.versionId,
      expectedHash: input.expectedHash,
      payloadValues: {
        ...toVersionPayloadValues(validated.normalized),
        parentVersionId: rebasedParent,
        hash,
      },
    });
    if (row) {
      await this.audit.add({
        action: 'assistant.version_redrafted',
        resourceType: 'assistant_version',
        resourceId: row.id,
        actorType: 'account',
        actorId: input.actorId,
        tenantId: input.orgId,
        details: {
          assistant_id: input.assistantId,
          from: input.expectedHash.slice(0, 16),
          to: hash.slice(0, 16),
        },
      });
      return row;
    }
    const current = await this.getVersion(input.orgId, input.versionId);
    throw draftWriteMissError({
      existsSameAssistant: !!current && current.assistantId === input.assistantId,
      status: current && current.assistantId === input.assistantId ? current.status : null,
      expectedHash: input.expectedHash,
      currentHash: current && current.assistantId === input.assistantId ? current.hash : null,
    });
  }

  /**
   * Abandon a DRAFT (audited). Published history is untouched — only the
   * unshipped draft row is removed.
   *
   * The builder's Try console pins test runs (`runs.assistant_version_id`)
   * to the draft, and that FK has no ON DELETE CASCADE — so discarding a
   * tried draft deletes its test runs first, in the same transaction. The
   * migration-declared cascades then clean run_events / approvals /
   * tool_effects / checkpoints / memory_proposals / run_manifests /
   * run_judgments (escalations SET NULL). Test runs are run_kind='test':
   * never billable and excluded from usage-ledger entries by design
   * (REL-2.2/REL-2.4), and usage_ledger_entries.run_id carries no FK to
   * runs at all — the append-only ledger is untouched and never rewritten.
   *
   * Two durable references refuse the discard instead of being deleted:
   * eval_runs (release provenance — deleting it would erase the evidence
   * the publish gate relied on) and any non-test run pinned to the draft
   * (production history must never vanish silently). Both refuse with a
   * typed 409 naming the blocking row.
   */
  async discardDraft(input: {
    orgId: string;
    assistantId: string;
    versionId: string;
    actorId: string;
  }): Promise<void> {
    assertOrgId(input.orgId);
    assertUuid(input.assistantId);
    assertUuid(input.versionId);
    const current = await this.getVersion(input.orgId, input.versionId);
    if (!current || current.assistantId !== input.assistantId) {
      throw ApiError.notFound('assistant version');
    }
    if (current.status !== 'DRAFT') {
      throw ApiError.conflict(
        `only DRAFT versions can be discarded (status is ${current.status})`,
        { status: current.status },
      );
    }
    // Transaction ownership, the durable eval/non-test-run refusals, and
    // the test-run cascade live in the repository.
    await this.versions.discardDraftVersion({
      orgId: input.orgId,
      assistantId: input.assistantId,
      versionId: input.versionId,
    });
    await this.audit.add({
      action: 'assistant.version_draft_discarded',
      resourceType: 'assistant_version',
      resourceId: input.versionId,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      details: { assistant_id: input.assistantId },
    });
  }

  /**
   * Knowledge health for the operate view: the ACTIVE version's pins joined
   * against live document states. Degraded = any declared pin unresolved or
   * not READY (retired by a connector tombstone, failed ingestion, or never
   * mapped). Computed read-only from committed rows — no new state, no
   * worker. No active version = nothing serving = not degraded.
   */
  async getKnowledgeHealth(
    orgId: string,
    assistantId: string,
  ): Promise<{
    degraded: boolean;
    pins: Array<{
      source_slug: string;
      resolved: boolean;
      document_id: string | null;
      state: string | null;
      embedding_complete: boolean | null;
    }>;
  }> {
    assertOrgId(orgId);
    assertUuid(assistantId);
    const assistant = await this.get(orgId, assistantId);
    const activeVersionId = assistant?.activeVersionId ?? null;
    if (!assistant || !activeVersionId) {
      return { degraded: false, pins: [] };
    }
    const snap = await this.getSnapshotForVersion(orgId, assistantId, activeVersionId);
    const pins = (snap?.knowledgePins ?? []) as Array<{
      source_slug?: unknown;
      resolved?: unknown;
      document_id?: unknown;
      document_version_id?: unknown;
      embedding_model?: unknown;
      embedding_coverage?: { complete?: unknown } | null;
    }>;
    if (!Array.isArray(pins) || pins.length === 0) {
      return { degraded: false, pins: [] };
    }
    const ids = pins
      .filter((p) => p?.resolved === true && typeof p?.document_id === 'string')
      .map((p) => p.document_id as string);
    // Document states come from the knowledge query port (persistence
    // only) — the degradation rules below stay here in the service.
    const states = await this.knowledgeQueries.getDocumentStates(orgId, ids);
    // P0 (GAP-1): live embedding coverage for resolved pins, computed against
    // the PINNED version (not latest — the snapshot is the pinning authority).
    // Pins without a model (legacy snapshots) report null: unknown, not broken.
    const coverable = pins.filter(
      (p) =>
        p?.resolved === true &&
        typeof p?.document_version_id === 'string' &&
        typeof p?.embedding_model === 'string',
    );
    const coverage = new Map<string, boolean | null>();
    if (coverable.length > 0) {
      // Per-(version, model) pairs: a version carrying stale rows of ANOTHER
      // model (pre-sweep migration residue) must not inflate its own count.
      // The VALUES join binds each pinned version to exactly its pin's model.
      const pairs = coverable.map((p) => ({
        versionId: p.document_version_id as string,
        model: p.embedding_model as string,
      }));
      const byVersion = await this.knowledgeQueries.getChunkEmbeddingStats(orgId, pairs);
      for (const p of coverable) {
        const stat = byVersion.get(p.document_version_id as string);
        if (stat !== undefined) {
          coverage.set(p.document_version_id as string, stat.embedded === stat.total);
          continue;
        }
        // No chunk rows: vacuous coverage (complete) when the document row
        // still exists — same rule as resolveEmbeddingCoverage. A vanished
        // document reports null (unknown); the state check already degrades it.
        const docExists = typeof p?.document_id === 'string' && states.has(p.document_id as string);
        coverage.set(p.document_version_id as string, docExists ? true : null);
      }
    }
    const view = pins.map((p) => {
      const slug = typeof p?.source_slug === 'string' ? (p.source_slug as string) : '';
      const resolved = p?.resolved === true && typeof p?.document_id === 'string';
      const state = resolved ? (states.get(p.document_id as string) ?? 'deleted') : null;
      const complete =
        resolved && typeof p?.document_version_id === 'string'
          ? (coverage.get(p.document_version_id as string) ?? null)
          : null;
      return {
        source_slug: slug,
        resolved,
        document_id: resolved ? (p.document_id as string) : null,
        state,
        embedding_complete: complete,
      };
    });
    return {
      degraded: view.some(
        (v) => !v.resolved || v.state !== 'ready' || v.embedding_complete === false,
      ),
      pins: view,
    };
  }

  async getVersion(orgId: string, versionId: string): Promise<AssistantVersion | null> {
    assertOrgId(orgId);
    assertUuid(versionId);
    return this.versions.getVersion(orgId, versionId);
  }

  async listVersions(orgId: string, assistantId: string): Promise<AssistantVersion[]> {
    assertOrgId(orgId);
    assertUuid(assistantId);
    return this.versions.listVersions(orgId, assistantId);
  }

  /**
   * Publish a DRAFT/VALID version — advisory-lock serialized per assistant.
   * Computes `nextVersion = max(version where status IN (PUBLISHED,RETIRED,ROLLED_BACK)) + 1`,
   * inserts a new PUBLISHED row, and moves `assistants.active_version_id` atomically.
   */
  async publish(input: {
    orgId: string;
    assistantId: string;
    versionId: string;
    publishedBy: string;
    acknowledgeDegradedKnowledge?: boolean;
  }): Promise<AssistantVersion> {
    assertOrgId(input.orgId);
    assertUuid(input.assistantId);
    assertUuid(input.versionId);

    const draft = await this.getVersion(input.orgId, input.versionId);
    if (!draft || draft.assistantId !== input.assistantId) {
      throw ApiError.notFound('assistant version');
    }
    if (!['DRAFT', 'VALID', 'VALIDATING'].includes(draft.status)) {
      throw ApiError.validation({ status: `version status ${draft.status} cannot be published` });
    }
    // Re-validate the FULL draft row — instructions/model_params/budget/
    // brand live on the version row, not just the policy columns. (A
    // policies-only rebuild silently drops the prompt and can never satisfy
    // assertPublishable — that path is why every publish must start here.)
    const payload: AssistantPayload = {
      model_policy: draft.modelPolicy as AssistantPayload['model_policy'],
      context_policy: draft.contextPolicy as AssistantPayload['context_policy'],
      tool_policy: draft.toolPolicy as AssistantPayload['tool_policy'],
      knowledge_policy: (draft.knowledgePolicy ??
        undefined) as AssistantPayload['knowledge_policy'],
      guardrail_policy: draft.guardrailPolicy as AssistantPayload['guardrail_policy'],
      instructions: (draft.instructions ?? undefined) as AssistantPayload['instructions'],
      model_params: (draft.modelParams ?? undefined) as AssistantPayload['model_params'],
      budget_policy: (draft.budgetPolicy ?? undefined) as AssistantPayload['budget_policy'],
      brand: (draft.brand ?? undefined) as AssistantPayload['brand'],
    };
    const validated = validateAssistantPayload(payload);
    if (!validated.ok) {
      throw ApiError.validation({ assistant: validated.issues });
    }
    await this.rejectUnknownModels(input.orgId, validated.normalized);
    assertPublishable(validated.normalized);
    await this.assertToolPins(input.orgId, validated.normalized);

    // The repository owns the advisory-lock serialization, next-version
    // computation, manifest resolution, the no-op/release/degraded gates,
    // the PUBLISHED insert + snapshot, and the active-pointer move — one
    // commit. `version` is advisory: the repository computes nextVersion
    // under the lock (the published row inherits the draft's fork point).
    const published = await this.versions.publishVersion({
      orgId: input.orgId,
      assistantId: input.assistantId,
      version: 0,
      schemaVersion: draft.schemaVersion,
      normalized: validated.normalized,
      publishedBy: input.publishedBy,
      rollbackOf: null,
      // P6: the published row inherits the draft's fork point.
      parentVersionId: draft.parentVersionId ?? null,
      acknowledgeDegradedKnowledge: input.acknowledgeDegradedKnowledge === true,
    });

    await this.audit.add({
      action: 'assistant.published',
      resourceType: 'assistant_version',
      resourceId: published.id,
      actorType: 'account',
      actorId: input.publishedBy,
      tenantId: input.orgId,
      details: {
        assistant_id: input.assistantId,
        version: published.version,
        hash: published.hash.slice(0, 16),
      },
    });
    await this.auditDegradedBypass(
      input.orgId,
      input.assistantId,
      published.id,
      input.publishedBy,
      input.acknowledgeDegradedKnowledge === true,
    );
    AssistantsService.logger.log(
      `assistant ${input.assistantId} published v${published.version} for org ${input.orgId}`,
    );
    return published;
  }

  async retire(input: {
    orgId: string;
    assistantId: string;
    versionId: string;
    retiredBy: string;
  }): Promise<AssistantVersion> {
    assertOrgId(input.orgId);
    assertUuid(input.assistantId);
    assertUuid(input.versionId);
    const version = await this.getVersion(input.orgId, input.versionId);
    if (!version || version.assistantId !== input.assistantId) {
      throw ApiError.notFound('assistant version');
    }
    if (version.status !== 'PUBLISHED') {
      throw ApiError.validation({ status: 'only PUBLISHED versions can be retired' });
    }
    // Serialize against publish/rollback (same advisory lock domain) so a
    // concurrent publish cannot re-activate the version mid-retire, and a
    // concurrent rollback cannot point `active_version_id` at the retiring row.
    // The lock, the active-pointer guard, and the conditional status move
    // live in the repository.
    const row = await this.versions.retireVersion(input.orgId, input.assistantId, input.versionId);
    await this.audit.add({
      action: 'assistant.retired',
      resourceType: 'assistant_version',
      resourceId: row.id,
      actorType: 'account',
      actorId: input.retiredBy,
      tenantId: input.orgId,
      details: { assistant_id: input.assistantId, version: row.version },
    });
    return row;
  }

  async rollback(input: {
    orgId: string;
    assistantId: string;
    toVersionId: string;
    publishedBy: string;
    acknowledgeDegradedKnowledge?: boolean;
  }): Promise<AssistantVersion> {
    const target = await this.getVersion(input.orgId, input.toVersionId);
    if (!target || target.assistantId !== input.assistantId) {
      throw ApiError.notFound('assistant version');
    }
    if (target.status === 'DRAFT') {
      throw ApiError.validation({ rollback: 'cannot rollback to a DRAFT' });
    }
    // Rollback = NEW PUBLISHED version restoring target's payload (full row —
    // same always-throw trap as publish: instructions/model_params/budget/
    // brand live on the version row and must round-trip, or rollback 500s).
    const payload: AssistantPayload = {
      model_policy: target.modelPolicy as AssistantPayload['model_policy'],
      context_policy: target.contextPolicy as AssistantPayload['context_policy'],
      tool_policy: target.toolPolicy as AssistantPayload['tool_policy'],
      knowledge_policy: (target.knowledgePolicy ??
        undefined) as AssistantPayload['knowledge_policy'],
      guardrail_policy: target.guardrailPolicy as AssistantPayload['guardrail_policy'],
      instructions: (target.instructions ?? undefined) as AssistantPayload['instructions'],
      model_params: (target.modelParams ?? undefined) as AssistantPayload['model_params'],
      budget_policy: (target.budgetPolicy ?? undefined) as AssistantPayload['budget_policy'],
      brand: (target.brand ?? undefined) as AssistantPayload['brand'],
    };
    const validated = validateAssistantPayload(payload);
    if (!validated.ok) {
      throw ApiError.validation({ assistant: validated.issues });
    }
    await this.rejectUnknownModels(input.orgId, validated.normalized);
    assertPublishable(validated.normalized);
    await this.assertToolPins(input.orgId, validated.normalized);
    // Rollback flows through the same repository commit as publish
    // (advisory lock, manifest resolution, gates, snapshot, pointer move).
    // `version` is advisory: the repository computes nextVersion under the
    // lock. P6: rollback-as-new derives from the restored version.
    const published = await this.versions.publishVersion({
      orgId: input.orgId,
      assistantId: input.assistantId,
      version: 0,
      schemaVersion: target.schemaVersion,
      normalized: validated.normalized,
      publishedBy: input.publishedBy,
      rollbackOf: target.id,
      parentVersionId: target.id,
      acknowledgeDegradedKnowledge: input.acknowledgeDegradedKnowledge === true,
    });
    await this.audit.add({
      action: 'assistant.rolled_back',
      resourceType: 'assistant_version',
      resourceId: published.id,
      actorType: 'account',
      actorId: input.publishedBy,
      tenantId: input.orgId,
      details: {
        assistant_id: input.assistantId,
        to_version: target.version,
        new_version: published.version,
      },
    });
    await this.auditDegradedBypass(
      input.orgId,
      input.assistantId,
      published.id,
      input.publishedBy,
      input.acknowledgeDegradedKnowledge === true,
    );
    return published;
  }

  // ── Policy snapshots (pinning authority for Phase 4 runs) ───────────────

  async getSnapshot(orgId: string, snapshotId: string): Promise<PolicySnapshot | null> {
    assertOrgId(orgId);
    assertUuid(snapshotId);
    return this.snapshots.getSnapshot(orgId, snapshotId);
  }

  async getSnapshotForVersion(
    orgId: string,
    assistantId: string,
    versionId: string,
  ): Promise<PolicySnapshot | null> {
    assertOrgId(orgId);
    assertUuid(assistantId);
    assertUuid(versionId);
    return this.snapshots.getSnapshotForVersion(orgId, assistantId, versionId);
  }

  /**
   * TPL-7.2 — evaluate a PUBLISHED version. Thin route over EvalService.startRun:
   * with no explicit dataset, the version's template-seeded dataset
   * (`template:<slug>@<version>`) is selected automatically. DRAFT versions
   * stay rejected (PUBLISHED-only gate in startRun is untouched).
   */
  async evaluateVersion(input: {
    orgId: string;
    assistantId: string;
    versionId: string;
    datasetId?: string;
    environment?: string;
    attemptsPerCase?: number;
    actor: string;
  }): Promise<unknown> {
    assertOrgId(input.orgId);
    assertUuid(input.assistantId);
    assertUuid(input.versionId);
    const version = await this.getVersion(input.orgId, input.versionId);
    if (!version || version.assistantId !== input.assistantId) {
      throw ApiError.notFound('assistant version');
    }
    let datasetId: string | undefined = input.datasetId;
    if (!datasetId) {
      const resolved = await this.resolveTemplateDataset(input.orgId, input.assistantId);
      if (!resolved) {
        throw ApiError.validation({
          dataset_id:
            'no template dataset for this assistant — install from a template or pass dataset_id explicitly',
        });
      }
      datasetId = resolved;
    }
    // R-2 (team_setup_ledger.md §3) — formal evaluation of DRAFT content
    // (EVALUATE → PUBLISH): drafts carry no publish artifact, so synthesize
    // the snapshot first — the same resolved set test runs execute. startRun
    // admits DRAFT + PUBLISHED; the executor pins the version and the
    // conversation plane requires the snapshot (no snapshot → no run).
    await this.ensureVersionSnapshot(input.orgId, input.assistantId, input.versionId);
    const run = await this.evals.startRun({
      orgId: input.orgId,
      datasetId,
      assistantVersionId: input.versionId,
      attemptsPerCase: input.attemptsPerCase ?? 1,
      actor: input.actor,
      ...(input.environment ? { environment: input.environment } : {}),
    });
    const runId = (run as { id?: unknown } | null)?.id;
    await this.audit.add({
      action: 'assistant.eval_started',
      resourceType: 'assistant_version',
      resourceId: input.versionId,
      actorType: 'account',
      actorId: input.actor,
      tenantId: input.orgId,
      details: {
        assistant_id: input.assistantId,
        dataset_id: datasetId,
        ...(typeof runId === 'string' ? { eval_run_id: runId } : {}),
      },
    });
    return run;
  }

  /** Template-seeded dataset id for an assistant (`template:<slug>@<version>`), if installed. */
  private async resolveTemplateDataset(orgId: string, assistantId: string): Promise<string | null> {
    // Install resolution lives in TemplatesService (org predicate inside);
    // the dataset-by-exact-name read is a knowledge query-port read.
    const template = await this.templates.resolveInstallTemplate(orgId, assistantId);
    if (!template) {
      return null;
    }
    return this.knowledgeQueries.findEvalDatasetId(
      orgId,
      `template:${template.slug}@${template.version}`,
    );
  }

  /**
   * TPL-4.2 — version provenance for reads. Enriches (never replaces) the
   * version/snapshot payloads: template ref, snapshot manifest hash,
   * update-available signal, and the last completed EvaluationRun decision.
   * Upgrade guidance is always "new draft from vX.Y.Z" — published rows are
   * never mutated.
   */
  async getVersionProvenance(
    orgId: string,
    assistantId: string,
    versionId: string,
  ): Promise<{
    template: { slug: string; version: string; definition_hash: string | null } | null;
    manifest_hash: string | null;
    update_available: 'major' | 'minor' | 'none';
    last_evaluation: { decision: string; score: string | null; finished_at: string | null } | null;
    /** P6: content lineage (null for first versions). */
    parent_version_id: string | null;
  }> {
    assertOrgId(orgId);
    assertUuid(assistantId);
    assertUuid(versionId);
    const version = await this.getVersion(orgId, versionId);
    if (!version || version.assistantId !== assistantId) {
      throw ApiError.notFound('assistant version');
    }
    const snapshot = await this.getSnapshotForVersion(orgId, assistantId, versionId);
    const template = await this.templates.resolveInstallTemplate(orgId, assistantId);
    let update_available: 'major' | 'minor' | 'none' = 'none';
    if (template) {
      const updates = await this.templates.checkUpdates(orgId);
      const entry = updates.find(
        (u) => u.slug === template.slug && u.installed_version === template.version,
      );
      update_available = entry?.update_available ?? 'none';
    }
    // Latest completed, non-shadow eval decision — formal verdict only
    // (shadow observations surface via drift alerts, never here). Read via
    // the knowledge query port; the predicate is byte-identical.
    const last = await this.knowledgeQueries.getLatestEvalDecision(orgId, versionId);
    return {
      template,
      manifest_hash: (snapshot?.manifestHash ?? null) as string | null,
      update_available,
      last_evaluation: last?.decision
        ? { decision: last.decision, score: last.score, finished_at: last.finished_at }
        : null,
      parent_version_id: version.parentVersionId ?? null,
    };
  }

  // ── Deterministic export / import (Phase 3 exit gate) ───────────────────

  /**
   * Export a version as a canonical envelope. Deterministic: identical payload
   * always serializes to the identical JSON string (sorted keys, schema_version included).
   */
  async exportVersion(
    orgId: string,
    assistantId: string,
    versionId: string,
  ): Promise<AssistantVersionExport> {
    assertOrgId(orgId);
    assertUuid(assistantId);
    assertUuid(versionId);
    const version = await this.getVersion(orgId, versionId);
    if (!version || version.assistantId !== assistantId || version.status === 'DRAFT') {
      throw ApiError.notFound('assistant version');
    }
    return {
      schema_version: version.schemaVersion,
      instructions: version.instructions,
      model_params: version.modelParams,
      budget_policy: version.budgetPolicy,
      brand: version.brand,
      model_policy: version.modelPolicy,
      context_policy: version.contextPolicy,
      tool_policy: version.toolPolicy,
      knowledge_policy: version.knowledgePolicy,
      guardrail_policy: version.guardrailPolicy,
      hash: version.hash,
    };
  }

  /**
   * Import an exported envelope as a new DRAFT for the assistant.
   * The recomputed canonical hash must match the envelope's `hash` — a
   * tampered or non-canonical export is rejected before persistence.
   */
  async importVersion(input: {
    orgId: string;
    assistantId: string;
    exported: AssistantVersionExport;
    createdBy: string;
  }): Promise<AssistantVersion> {
    assertOrgId(input.orgId);
    assertUuid(input.assistantId);
    const exported = input.exported;
    if (
      !exported ||
      typeof exported !== 'object' ||
      typeof exported.hash !== 'string' ||
      typeof exported.schema_version !== 'number'
    ) {
      throw ApiError.validation({ exported: 'must be an assistant version export envelope' });
    }
    // The hash covers the FULL normalized payload — the exact shape the
    // creation path hashes (canonicalHash over the parsed+defaulted payload).
    // Parse-normalize first so defaulted fields match; a legacy lossy
    // envelope (no instructions/model_params) then fails the hash check
    // instead of silently importing a v2 assistant without its prompt.
    //
    // G4/G5: the envelope carries NULL for unset optionals (instructions,
    // brand, knowledge_policy…) while the schema takes ABSENT — strip
    // top-level nulls so a faithful export re-normalizes identically (the
    // hash still guards every real byte; null-strip changes nothing else).
    const { hash: _envelopeHash, schema_version: _envelopeSchema, ...envelopeBody } = exported;
    const compacted = Object.fromEntries(
      Object.entries(envelopeBody).filter(([, value]) => value !== null),
    );
    const parsed = assistantPayloadSchema.safeParse(compacted);
    if (!parsed.success) {
      throw ApiError.validation({
        exported: `payload failed schema validation: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
      });
    }
    const recomputed = hashPayload(parsed.data);
    if (recomputed !== exported.hash) {
      throw ApiError.validation({
        hash: 'export envelope hash mismatch — payload is not canonical',
      });
    }
    return this.createVersion({
      orgId: input.orgId,
      assistantId: input.assistantId,
      payload: parsed.data,
      createdBy: input.createdBy,
    });
  }

  /**
   * Capability-registry check (ledger 3.3) — two layers:
   *
   * Layer 1 — PLATFORM existence (A2-40, NON-advisory): every `allowed_models`
   * entry with a `provider/model` shape must reference an ACTIVE pair in the
   * platform `model_catalog_entries` table — the same table the console's own
   * readiness check reads via GET /console/org/:orgId/models. A model the
   * platform has never heard of can never be served, so publishing it is
   * always wrong. An empty platform catalog (unseeded rig) skips this layer —
   * there is nothing to judge against — and bare refs without a provider
   * slash predate the catalog and keep the old structural-only posture.
   *
   * Layer 2 — ORG governance (advisory): when the org has a published
   * `model_catalog` config, every entry must also be ENABLED there. No
   * published catalog = governance not opted into for this org — structural
   * validation only. Invalid refs must be rejected BEFORE `PUBLISHED`
   * (Phase 3 exit gate).
   */
  private async rejectUnknownModels(orgId: string, payload: AssistantPayload): Promise<void> {
    // Fail CLOSED: if the platform catalog cannot be read, publish refuses
    // rather than skipping existence validation (A2-40 is non-advisory).
    const platformRefs = new Set(
      (await this.modelCatalog.listEntries('active')).map((e) => `${e.provider}/${e.modelId}`),
    );
    if (platformRefs.size > 0) {
      const bogus = unknownPlatformModels(payload.model_policy.allowed_models, platformRefs);
      if (bogus.length > 0) {
        throw ApiError.validation({
          model_policy: `allowed_models not present in the platform model catalog: ${bogus.join(', ')} — choose a model from the model list`,
        });
      }
    }
    const loadCatalog = async (): Promise<{
      models: Array<{ provider: string; model: string; enabled: boolean; regions?: string[] }>;
    } | null> => {
      const latest = await this.configPublish.latest(orgId, 'model_catalog', null);
      return (latest?.payload ?? null) as {
        models: Array<{ provider: string; model: string; enabled: boolean; regions?: string[] }>;
      } | null;
    };
    let catalog: {
      models: Array<{ provider: string; model: string; enabled: boolean; regions?: string[] }>;
    } | null = null;
    try {
      catalog = await loadCatalog();
    } catch {
      // Catalog governance is advisory when the config-publish surface is
      // unavailable (e.g. flag-disabled module in a test rig) — publish still
      // passes structural + secret validation.
      return;
    }
    if (!catalog || !Array.isArray(catalog.models) || catalog.models.length === 0) {
      return;
    }
    const enabled = new Set(
      catalog.models.filter((m) => m.enabled).map((m) => `${m.provider}/${m.model}`),
    );
    const unknown = payload.model_policy.allowed_models.filter((ref) => !enabled.has(ref));
    if (unknown.length > 0) {
      throw ApiError.validation({
        model_policy: `allowed_models not present in the published model catalog: ${unknown.join(', ')}`,
      });
    }

    // FL-2.19 + REL-11.2 — residency gate: the org's knowledge_config.residency
    // pin (or org_settings.preferences.residency) must be covered by every
    // referenced catalog model's `regions` list. `eu` is strict: only models
    // with `eu` or `global` serve eu. `default`/`us` remain permissive.
    // Second region `eu` is now addressable — see residency.ts policy.
    const residencyConfig = await this.configPublish.latest(orgId, 'knowledge_config', null);
    const rawResidency = String(
      (residencyConfig?.payload as { residency?: string } | undefined)?.residency ?? 'default',
    );
    let residency: Residency;
    try {
      residency = normalizeResidency(rawResidency);
    } catch {
      throw ApiError.validation({ residency: `unknown residency: ${rawResidency}` });
    }
    if (residency !== 'default') {
      const uncovered = payload.model_policy.allowed_models.filter((ref) => {
        const entry = catalog.models.find((m) => `${m.provider}/${m.model}` === ref);
        if (!entry) return false;
        const regions = entry.regions ?? null;
        return !modelServesResidency(residency, regions as string[] | null);
      });
      if (uncovered.length > 0) {
        throw ApiError.validation({
          model_policy: `residency '${residency}' not served by catalog models: ${uncovered.join(', ')}`,
        });
      }
    }
  }

  /**
   * Publish-time tool pin validation (drizzle/0032): every tool_policy entry
   * must reference an ENABLED tool_catalog row, and an explicit schema_hash
   * must match the catalog hash — a run can then never see a mutated schema.
   */
  private async assertToolPins(orgId: string, payload: AssistantPayload): Promise<void> {
    const tools = payload.tool_policy.tools;
    if (tools.length === 0) {
      return;
    }
    // The catalog read is unfiltered (disabled rows included) so the
    // 'not present or disabled' verdict is computed here, exactly as before.
    const rows = await this.toolCatalog.list(orgId, { includeDisabled: true });
    const byName = new Map(rows.map((r) => [r.name, r]));
    const problems: string[] = [];
    for (const entry of tools) {
      if (BUILT_IN_TOOLS.has(entry.name)) {
        // Built-in tools are platform-implemented - no catalog row to pin.
        continue;
      }
      const row = byName.get(entry.name);
      if (!row || !row.enabled) {
        problems.push(`${entry.name}: not present in the tool catalog or disabled`);
        continue;
      }
      if (entry.schema_hash !== undefined && entry.schema_hash !== row.hash) {
        problems.push(`${entry.name}: schema_hash does not match the catalog entry (pin is stale)`);
      }
    }
    if (problems.length > 0) {
      throw ApiError.validation({ tool_policy: `tool pins rejected: ${problems.join('; ')}` });
    }
  }

  /**
   * R-2 (team_setup_ledger.md §3) — snapshot synthesis shared by every
   * pre-publish execution path (test runs AND formal evaluation). Snapshots
   * are publish artifacts, so a version without one (any DRAFT, any legacy
   * row) gets the same resolved set synthesized from its row: pinning then
   * has something to point at. Idempotent per version (1:1 snapshots) — a
   * second call is a no-op. The caller's transaction (message accept, eval
   * dispatch) runs separately: the snapshot must COMMIT first.
   *
   * Frozen-content semantics: the snapshot captures the row ONCE. A later
   * draft edit does not rebuild it (history must not shift under a running
   * eval); the publish gate is content-hash keyed, so an edited draft
   * simply needs a fresh evaluation — the UI says exactly that.
   */
  private async ensureVersionSnapshot(
    orgId: string,
    assistantId: string,
    versionId: string,
  ): Promise<void> {
    assertOrgId(orgId);
    assertUuid(assistantId);
    assertUuid(versionId);
    // Synthesis owns its own transaction in the repository and commits
    // before any caller pins the row (see the doc comment above).
    await this.snapshots.synthesizeSnapshotForVersion({ orgId, assistantId, versionId });
  }

  /**
   * REL-2.4 — pre-publish test conversation: execute a version (DRAFT
   * included) through the real conversation plane without publishing it.
   * The run is run_kind='test': no quota reservation, no billable usage
   * entry, invisible to end users and rollups. A draft version gets its
   * policy snapshot materialized via ensureVersionSnapshot (snapshots are
   * publish artifacts — the test path synthesizes the same resolved set
   * from the draft row so pinning has something to point at).
   *
   * Deliberately NOT one transaction: the snapshot must commit before
   * acceptMessage (a separate transaction) can pin it. A failure after the
   * snapshot leaves an orphan test conversation — harmless by construction.
   */
  async startTestRun(input: {
    orgId: string;
    assistantId: string;
    versionId: string;
    text: string;
    actor: string;
  }): Promise<{
    conversation_id: string;
    message_id: string;
    run_id: string | null;
  }> {
    assertOrgId(input.orgId);
    assertUuid(input.assistantId);
    assertUuid(input.versionId);
    const text = input.text.trim();
    if (text.length === 0 || text.length > 8192) {
      throw ApiError.validation({ text: 'must be 1..8192 chars' });
    }

    // Snapshot synthesis for pre-publish execution (shared with formal
    // evaluation — see ensureVersionSnapshot). Deliberately NOT one
    // transaction with the message accept below: the snapshot must commit
    // before acceptMessage (a separate transaction) can pin it.
    await this.ensureVersionSnapshot(input.orgId, input.assistantId, input.versionId);

    const conversation = await this.conversations.createConversation({
      orgId: input.orgId,
      assistantId: input.assistantId,
      createdBy: input.actor,
      participantScope: 'org',
    });
    const accepted = await this.conversations.acceptMessage({
      orgId: input.orgId,
      principalId: input.actor,
      conversationId: conversation.id,
      content: { text },
      pinVersionId: input.versionId,
      runKind: 'test',
    });
    await this.audit.add({
      action: 'assistant.test_run_started',
      resourceType: 'assistant_version',
      resourceId: input.versionId,
      actorType: 'account',
      actorId: input.actor,
      tenantId: input.orgId,
      details: { conversation_id: conversation.id, run_id: accepted.run_id },
    });
    return {
      conversation_id: conversation.id,
      message_id: accepted.message_id,
      run_id: accepted.run_id,
    };
  }

  /**
   * Post-commit degraded-knowledge audit. Reads the COMMITTED snapshot (no
   * TOCTOU — the gate already enforced inside the TX) and records the
   * acknowledged slugs only when the bypass flag was actually set. Silent
   * when unneeded so the audit stream stays signal-dense.
   */
  private async auditDegradedBypass(
    orgId: string,
    assistantId: string,
    versionId: string,
    actorId: string,
    acknowledged: boolean,
  ): Promise<void> {
    if (!acknowledged) {
      return;
    }
    // The COMMITTED snapshot: the row matching the version's live hash
    // (content-addressed, drizzle/0069 — older rows are immutable history).
    const snap = await this.snapshots.getSnapshotForVersion(orgId, assistantId, versionId);
    const pins = { knowledgePins: (snap?.knowledgePins ?? []) as never };
    const slugs = unresolvedPinSlugs(pins);
    // P0: the bypass may have covered indexing gaps rather than (or as well
    // as) unresolved slugs — record both so the audit names what was waived.
    const undercovered = undercoveredPinSlugs(pins).map(
      (p) => `${p.slug} (${p.embedded}/${p.total} on ${p.model})`,
    );
    await this.audit.add({
      action: 'assistant.publish_degraded_acknowledged',
      resourceType: 'assistant_version',
      resourceId: versionId,
      actorType: 'account',
      actorId,
      tenantId: orgId,
      details: { unresolved_slugs: slugs, undercovered_pins: undercovered },
    });
  }


  /**
   * P5 (degraded lifecycle) — sweep overdue + due-soon degraded assistants.
   * Overdue (degraded_until past, still enabled): auto-suspend through the
   * disable path (reversible, audited as assistant.disabled with the TTL
   * reason — the degraded columns stay as the banner's explanation). Due
   * soon (inside 24h, never alerted, still enabled): mark alerted and report
   * for owner notification (the WORKER notifies; this method only marks, so
   * alerting and state stay in one audited transaction each). Already
   * disabled rows are left alone (an operator decision outranks the clock).
   * `orgId` scopes the sweep (test seam; production omits it).
   */
  async sweepDegradedAssistants(input: { orgId?: string } = {}): Promise<{
    suspended: Array<{ orgId: string; assistantId: string; name: string }>;
    dueSoon: Array<{ orgId: string; assistantId: string; name: string }>;
  }> {
    const suspended: Array<{ orgId: string; assistantId: string; name: string }> = [];
    const dueSoon: Array<{ orgId: string; assistantId: string; name: string }> = [];
    // Claim + mark live in the repository (bypass boundary, FOR UPDATE
    // SKIP LOCKED); the disable path stays the audited service method.
    const overdue = await this.assistants.claimOverdueDegradedAssistants({ orgId: input.orgId });
    for (const row of overdue) {
      try {
        await this.setDisabled({
          orgId: row.orgId,
          assistantId: row.assistantId,
          disabled: true,
          reason:
            'degraded knowledge unresolved past the 7-day waiver — fix the pins and re-enable',
          actorId: 'system:degraded-sweep',
        });
        suspended.push({ orgId: row.orgId, assistantId: row.assistantId, name: row.name });
      } catch {
        // Per-candidate isolation (a concurrent disable/rename just skips).
      }
    }
    const soon = await this.assistants.claimDueSoonDegradedAssistants({ orgId: input.orgId });
    for (const row of soon) {
      try {
        await this.assistants.markDegradedAlerted(row.assistantId);
        await this.audit.add({
          action: 'assistant.degraded_warning',
          resourceType: 'assistant',
          resourceId: row.assistantId,
          actorType: 'service',
          actorId: 'system:degraded-sweep',
          tenantId: row.orgId,
          details: {},
        });
        dueSoon.push({ orgId: row.orgId, assistantId: row.assistantId, name: row.name });
      } catch {
        // Per-candidate isolation.
      }
    }
    return { suspended, dueSoon };
  }

  private async requireAssistant(orgId: string, assistantId: string): Promise<Assistant> {
    const row = await this.get(orgId, assistantId);
    if (!row) {
      throw ApiError.notFound('assistant');
    }
    return row;
  }
}

function assertOrgId(orgId: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orgId)) {
    throw ApiError.validation({ orgId: 'must be a uuid' });
  }
}

function assertUuid(id: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw ApiError.validation({ id: 'must be a uuid' });
  }
}

/**
 * TPL-2.1 — unknown-key rejection lives in validation.ts (`rejectUnknownPayloadKeys`)
 * so the create-definition path and the template install path share one
 * implementation (deep diff, 422 with the key list).
 */

/**
 * Normalize a validated payload into the repository's version-values
 * shape (snake_case → column values). Hash and parentVersionId are
 * supplied per-call because they differ by path (create: fresh hash, no
 * parent; updateDraft: rebased parent).
 */
function toVersionPayloadValues(
  normalized: AssistantPayload,
): Omit<VersionPayloadValues, 'parentVersionId' | 'hash'> {
  return {
    modelPolicy: normalized.model_policy,
    contextPolicy: normalized.context_policy,
    toolPolicy: normalized.tool_policy,
    knowledgePolicy: normalized.knowledge_policy ?? null,
    guardrailPolicy: normalized.guardrail_policy,
    instructions: normalized.instructions ?? null,
    modelParams: normalized.model_params ?? null,
    budgetPolicy: normalized.budget_policy ?? null,
    brand: normalized.brand ?? null,
  };
}

function assertName(name: string): void {
  if (!name || name.trim().length < 2 || name.trim().length > 128) {
    throw ApiError.validation({ name: 'must be 2..128 chars' });
  }
}

function hashPayload(value: unknown): string {
  return canonicalHash(value);
}

/**
 * OCC miss classification for draft writes (pure — unit-tested). See
 * updateDraft: the conditional UPDATE either lands or this maps the miss to
 * exactly one typed error — missing/foreign → 404, non-draft → 409, stale
 * hash → 412 carrying both hashes for merge-or-reload UX. Never throws
 * itself; the caller throws the returned error.
 */
export function draftWriteMissError(input: {
  existsSameAssistant: boolean;
  status: string | null;
  expectedHash: string;
  currentHash: string | null;
}): ApiError {
  if (!input.existsSameAssistant) {
    return ApiError.notFound('assistant version');
  }
  if (input.status !== 'DRAFT') {
    return ApiError.conflict(`only DRAFT versions are editable (status is ${input.status})`, {
      status: input.status,
    });
  }
  return ApiError.precondition({ expected: input.expectedHash, current: input.currentHash });
}
