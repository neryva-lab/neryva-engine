import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { pgViolation } from '../../common/infra/db/pg-types';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { ConfigPublishService } from '../config-publish/config-publish.service';
import {
  assistants,
  assistantVersions,
  policySnapshots,
  assistantInstalls,
  Assistant,
  AssistantVersion,
  PolicySnapshot,
  AssistantVersionExport,
  POLICY_SNAPSHOT_SCHEMA_VERSION,
} from './schema';
import {
  validateAssistantPayload,
  assertPublishable,
  assistantPayloadSchema,
  rejectUnknownPayloadKeys,
  AssistantPayload,
} from './validation';
import { evaluatePublishGate, throwGateRefusal } from './release-gate';
import { TemplatesService } from './templates.service';
import {
  ManifestResolutionService,
  undercoveredPinSlugs,
  unresolvedPinSlugs,
} from './manifest-resolution.service';
import { ConversationsService } from '../conversations/conversations.service';
import { evalRuns, evalDatasets } from '../knowledge/eval.schema';
import { documents } from '../knowledge/schema';
import { EvalService } from '../knowledge/eval.service';
import { toolCatalog } from './tool-catalog.schema';
import { BUILT_IN_TOOLS } from './tool-catalog.service';
import { canonicalHash } from '../../common/crypto/canonical-hash';
import { normalizeResidency, modelServesResidency, Residency } from './residency';

/**
 * Assistants domain — Phase 3.1-3.3
 *
 * Stable identity (`assistants`) + immutable history (`assistant_versions`).
 * Publish never mutates a row — it inserts a new PUBLISHED version and moves
 * `assistants.active_version_id` atomically under a per-assistant advisory
 * lock (same pattern as `src/modules/config-publish/config-publish.service.ts:92`).
 *
 * In-flight runs remain pinned to the `assistant_version_id` they were
 * created with — tested in Phase 4.4. This service does not know runs.
 */
@Injectable()
export class AssistantsService {
  private static readonly logger = new Logger(AssistantsService.name);

  /** Hard caps for unpaginated list endpoints (public API checklist: bounded responses). */
  private static readonly LIST_CAP = 200;
  private static readonly VERSION_LIST_CAP = 500;

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly configPublish: ConfigPublishService,
    private readonly templates: TemplatesService,
    private readonly manifests: ManifestResolutionService,
    private readonly evals: EvalService,
    private readonly conversations: ConversationsService,
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
      let assistant: Assistant;
      let versionId: string;
      try {
        const created = await this.db.withOrg(input.orgId, async (tx) => {
          const assistantRows = await tx
            .insert(assistants)
            .values({
              organizationId: input.orgId,
              name: input.name.trim(),
              description: input.description?.trim() ?? null,
            })
            .returning();
          const versionRows = await tx
            .insert(assistantVersions)
            .values({
              assistantId: assistantRows[0].id,
              organizationId: input.orgId,
              version: 0, // sentinel for DRAFT — publish assigns monotonic version
              status: 'DRAFT',
              modelPolicy: validated.normalized.model_policy,
              contextPolicy: validated.normalized.context_policy,
              toolPolicy: validated.normalized.tool_policy,
              knowledgePolicy: validated.normalized.knowledge_policy ?? null,
              guardrailPolicy: validated.normalized.guardrail_policy,
              instructions: validated.normalized.instructions ?? null,
              modelParams: validated.normalized.model_params ?? null,
              budgetPolicy: validated.normalized.budget_policy ?? null,
              brand: validated.normalized.brand ?? null,
              hash,
            })
            .returning({ id: assistantVersions.id });
          return { assistant: assistantRows[0], versionId: versionRows[0].id };
        });
        assistant = created.assistant;
        versionId = created.versionId;
      } catch (err) {
        if (err instanceof ApiError) throw err;
        throw mapAssistantUniqueViolation(err, input.name);
      }
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
    let row: Assistant;
    try {
      const rows = await this.db.withOrg(input.orgId, (tx) =>
        tx
          .insert(assistants)
          .values({
            organizationId: input.orgId,
            name: input.name.trim(),
            description: input.description?.trim() ?? null,
          })
          .returning(),
      );
      row = rows[0];
    } catch (err) {
      throw mapAssistantUniqueViolation(err, input.name);
    }
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
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx.select().from(assistants).where(eq(assistants.id, assistantId)).limit(1),
    );
    return rows[0] ?? null;
  }

  async list(orgId: string): Promise<Assistant[]> {
    assertOrgId(orgId);
    return this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(assistants)
        .where(eq(assistants.organizationId, orgId))
        .orderBy(desc(assistants.updatedAt))
        .limit(AssistantsService.LIST_CAP),
    );
  }

  /**
   * Soft-deletes an assistant by clearing its identity fields (the row stays
   * for FK integrity — conversations reference assistants.id). Refuses when
   * conversations exist; the caller should archive those first.
   */
  async remove(input: {
    orgId: string;
    assistantId: string;
    actorId: string;
  }): Promise<{ ok: true }> {
    assertOrgId(input.orgId);
    assertUuid(input.assistantId);
    // Attempt delete — the FK from conversations.assistant_id will reject
    // if any conversation references this assistant. We catch and re-throw
    // as a 409 so the caller knows to archive conversations first.
    try {
      const rows = await this.db.withOrg(input.orgId, (tx) =>
        tx.delete(assistants).where(eq(assistants.id, input.assistantId)).returning(),
      );
      if (rows.length === 0) {
        throw ApiError.notFound('assistant');
      }
      await this.audit.add({
        action: 'assistant.deleted',
        resourceType: 'assistant',
        resourceId: input.assistantId,
        actorType: 'account',
        actorId: input.actorId,
        tenantId: input.orgId,
        details: { name: rows[0].name },
      });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      // FK violation — conversations still reference this assistant
      throw ApiError.conflict('assistant has conversations — archive them before deleting');
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
    const rows = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .update(assistants)
        .set(
          input.disabled
            ? {
                disabledAt: new Date().toISOString(),
                disabledBy: input.actorId.slice(0, 128),
                disabledReason: (input.reason ?? 'operator kill switch').slice(0, 512),
                updatedAt: new Date().toISOString(),
              }
            : {
                disabledAt: null,
                disabledBy: null,
                disabledReason: null,
                updatedAt: new Date().toISOString(),
              },
        )
        .where(eq(assistants.id, input.assistantId))
        .returning(),
    );
    if (rows.length === 0) {
      throw ApiError.notFound('assistant');
    }
    await this.audit.add({
      action: input.disabled ? 'assistant.disabled' : 'assistant.enabled',
      resourceType: 'assistant',
      resourceId: input.assistantId,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      details: input.disabled ? { reason: rows[0].disabledReason } : {},
    });
    return rows[0];
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
    // Unknown keys refuse here exactly like the definition-create path
    // (rejectUnknownPayloadKeys runs inside validateAssistantPayload's
    // callers — see updateDraft for the shared strict chain).

    // DRAFT is always a new row; version is assigned only on publish. The
    // (assistant_id, version=0) sentinel is unique — a second draft before
    // the first is published surfaces as a typed 409, never a raw 23505.
    let row: AssistantVersion;
    try {
      const rows = await this.db.withOrg(input.orgId, (tx) =>
        tx
          .insert(assistantVersions)
          .values({
            assistantId: input.assistantId,
            organizationId: input.orgId,
            version: 0, // sentinel for DRAFT — publish assigns monotonic version
            status: 'DRAFT',
            modelPolicy: validated.normalized.model_policy,
            contextPolicy: validated.normalized.context_policy,
            toolPolicy: validated.normalized.tool_policy,
            knowledgePolicy: validated.normalized.knowledge_policy ?? null,
            guardrailPolicy: validated.normalized.guardrail_policy,
            instructions: validated.normalized.instructions ?? null,
            modelParams: validated.normalized.model_params ?? null,
            budgetPolicy: validated.normalized.budget_policy ?? null,
            brand: validated.normalized.brand ?? null,
            parentVersionId,
            hash,
          })
          .returning(),
      );
      row = rows[0];
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw mapAssistantUniqueViolation(err, '');
    }
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
    const forkRows = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .select({ activeVersionId: assistants.activeVersionId })
        .from(assistants)
        .where(eq(assistants.id, input.assistantId))
        .limit(1),
    );
    const rebasedParent = forkRows[0]?.activeVersionId ?? null;
    const rows = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .update(assistantVersions)
        .set({
          modelPolicy: validated.normalized.model_policy,
          contextPolicy: validated.normalized.context_policy,
          toolPolicy: validated.normalized.tool_policy,
          knowledgePolicy: validated.normalized.knowledge_policy ?? null,
          guardrailPolicy: validated.normalized.guardrail_policy,
          instructions: validated.normalized.instructions ?? null,
          modelParams: validated.normalized.model_params ?? null,
          budgetPolicy: validated.normalized.budget_policy ?? null,
          brand: validated.normalized.brand ?? null,
          parentVersionId: rebasedParent,
          hash,
          updatedAt: new Date().toISOString(),
        })
        .where(
          and(
            eq(assistantVersions.id, input.versionId),
            eq(assistantVersions.assistantId, input.assistantId),
            eq(assistantVersions.status, 'DRAFT'),
            eq(assistantVersions.hash, input.expectedHash),
          ),
        )
        .returning(),
    );
    if (rows[0]) {
      await this.audit.add({
        action: 'assistant.version_redrafted',
        resourceType: 'assistant_version',
        resourceId: rows[0].id,
        actorType: 'account',
        actorId: input.actorId,
        tenantId: input.orgId,
        details: {
          assistant_id: input.assistantId,
          from: input.expectedHash.slice(0, 16),
          to: hash.slice(0, 16),
        },
      });
      return rows[0];
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
   * unshipped draft row is removed. Drafts carry no durable references
   * (snapshots/manifests exist for published versions only), so removal is
   * a single-row delete.
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
    await this.db.withOrg(input.orgId, (tx) =>
      tx.delete(assistantVersions).where(eq(assistantVersions.id, input.versionId)),
    );
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
    const states = new Map<string, string>();
    if (ids.length > 0) {
      const rows = await this.db.withOrg(orgId, (tx) =>
        tx
          .select({ id: documents.id, state: documents.state })
          .from(documents)
          .where(inArray(documents.id, ids)),
      );
      for (const r of rows) {
        states.set(r.id, r.state);
      }
    }
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
      const rows = await this.db.withOrg(orgId, (tx) =>
        tx.execute(sql`
          select c.document_version_id as version_id,
                 count(c.id)::int as total,
                 count(e.id)::int as embedded
          from chunks c
          join (values ${sql.join(
            pairs.map((pair) => sql`(${pair.versionId}::uuid, ${pair.model})`),
            sql`, `,
          )}) as want(version_id, model) on want.version_id = c.document_version_id
          left join embeddings e on e.chunk_id = c.id and e.model = want.model
          where c.organization_id = ${orgId}::uuid
          group by c.document_version_id
        `),
      );
      const byVersion = new Map<string, { total: number; embedded: number }>();
      for (const r of rows.rows as Array<{ version_id: string; total: number; embedded: number }>) {
        byVersion.set(r.version_id, { total: Number(r.total), embedded: Number(r.embedded) });
      }
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
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx.select().from(assistantVersions).where(eq(assistantVersions.id, versionId)).limit(1),
    );
    return rows[0] ?? null;
  }

  async listVersions(orgId: string, assistantId: string): Promise<AssistantVersion[]> {
    assertOrgId(orgId);
    assertUuid(assistantId);
    return this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(assistantVersions)
        .where(eq(assistantVersions.assistantId, assistantId))
        .orderBy(desc(assistantVersions.version), desc(assistantVersions.createdAt))
        .limit(AssistantsService.VERSION_LIST_CAP),
    );
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

    const published = await this.db.withOrg(input.orgId, async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`assistant:${input.assistantId}`}))`,
      );

      const latest = await tx
        .select({ version: assistantVersions.version })
        .from(assistantVersions)
        .where(
          and(
            eq(assistantVersions.assistantId, input.assistantId),
            eq(assistantVersions.status, 'PUBLISHED'),
          ),
        )
        .orderBy(desc(assistantVersions.version))
        .limit(1);
      // Also consider non-PUBLISHED but already versioned rows (RETIRED, etc.)
      const maxAll = await tx
        .select({ version: assistantVersions.version })
        .from(assistantVersions)
        .where(
          and(
            eq(assistantVersions.assistantId, input.assistantId),
            sql`${assistantVersions.version} > 0`,
          ),
        )
        .orderBy(desc(assistantVersions.version))
        .limit(1);
      const nextVersion = Math.max(latest[0]?.version ?? 0, maxAll[0]?.version ?? 0) + 1;

      return this.insertPublishedVersion(tx, {
        orgId: input.orgId,
        assistantId: input.assistantId,
        version: nextVersion,
        schemaVersion: draft.schemaVersion,
        normalized: validated.normalized,
        publishedBy: input.publishedBy,
        rollbackOf: null,
        // P6: the published row inherits the draft's fork point.
        parentVersionId: draft.parentVersionId ?? null,
        acknowledgeDegradedKnowledge: input.acknowledgeDegradedKnowledge === true,
      });
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
    const row = await this.db.withOrg(input.orgId, async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`assistant:${input.assistantId}`}))`,
      );
      const active = await tx
        .select({ activeVersionId: assistants.activeVersionId })
        .from(assistants)
        .where(eq(assistants.id, input.assistantId))
        .limit(1);
      if (active[0]?.activeVersionId === version.id) {
        // The active pointer must never reference a RETIRED version — runs
        // started after retire would pin a version the org has withdrawn.
        // Withdraw by publishing/rolling back to a successor first.
        throw ApiError.conflict(
          'cannot retire the active version — publish or roll back to a successor first',
          {
            assistant_id: input.assistantId,
            version_id: version.id,
          },
        );
      }
      const rows = await tx
        .update(assistantVersions)
        .set({ status: 'RETIRED', updatedAt: new Date().toISOString() })
        .where(and(eq(assistantVersions.id, version.id), eq(assistantVersions.status, 'PUBLISHED')))
        .returning();
      if (rows.length === 0) {
        throw ApiError.conflict('assistant version was retired concurrently');
      }
      return rows[0];
    });
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
    const published = await this.db.withOrg(input.orgId, async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`assistant:${input.assistantId}`}))`,
      );
      const maxAll = await tx
        .select({ version: assistantVersions.version })
        .from(assistantVersions)
        .where(
          and(
            eq(assistantVersions.assistantId, input.assistantId),
            sql`${assistantVersions.version} > 0`,
          ),
        )
        .orderBy(desc(assistantVersions.version))
        .limit(1);
      const nextVersion = (maxAll[0]?.version ?? 0) + 1;
      return this.insertPublishedVersion(tx, {
        orgId: input.orgId,
        assistantId: input.assistantId,
        version: nextVersion,
        schemaVersion: target.schemaVersion,
        normalized: validated.normalized,
        publishedBy: input.publishedBy,
        rollbackOf: target.id,
        // P6: rollback-as-new derives from the restored version.
        parentVersionId: target.id,
        acknowledgeDegradedKnowledge: input.acknowledgeDegradedKnowledge === true,
      });
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
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx.select().from(policySnapshots).where(eq(policySnapshots.id, snapshotId)).limit(1),
    );
    return rows[0] ?? null;
  }

  async getSnapshotForVersion(
    orgId: string,
    assistantId: string,
    versionId: string,
  ): Promise<PolicySnapshot | null> {
    assertOrgId(orgId);
    assertUuid(assistantId);
    assertUuid(versionId);
    return this.db.withOrg(orgId, async (tx) => {
      const version = await tx
        .select({
          id: assistantVersions.id,
          assistantId: assistantVersions.assistantId,
          hash: assistantVersions.hash,
        })
        .from(assistantVersions)
        .where(
          and(eq(assistantVersions.id, versionId), eq(assistantVersions.assistantId, assistantId)),
        )
        .limit(1);
      if (version.length === 0) {
        return null;
      }
      // Content-addressed (drizzle/0069): "the version's snapshot" is the row
      // matching the version's LIVE hash — older rows are immutable history
      // for runs dispatched against them.
      const rows = await tx
        .select()
        .from(policySnapshots)
        .where(
          and(
            eq(policySnapshots.assistantVersionId, versionId),
            eq(policySnapshots.hash, version[0].hash),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    });
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
    const name = await this.db.withOrg(orgId, async (tx) => {
      const installs = await tx
        .select()
        .from(assistantInstalls)
        .where(eq(assistantInstalls.assistantId, assistantId))
        .limit(1);
      const install = installs[0];
      if (!install || install.organizationId !== orgId) {
        return null;
      }
      return `template:${install.slug}@${install.templateVersion}`;
    });
    if (!name) {
      return null;
    }
    const datasets = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({ id: evalDatasets.id })
        .from(evalDatasets)
        .where(and(eq(evalDatasets.organizationId, orgId), eq(evalDatasets.name, name)))
        .limit(1),
    );
    return datasets[0]?.id ?? null;
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
    const runs = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({
          decision: evalRuns.decision,
          score: evalRuns.score,
          finishedAt: evalRuns.finishedAt,
        })
        .from(evalRuns)
        .where(
          and(
            eq(evalRuns.organizationId, orgId),
            eq(evalRuns.assistantVersionId, versionId),
            eq(evalRuns.state, 'completed'),
            // P5: the version verdict is the FORMAL decision — shadow
            // observations surface via drift alerts, never here.
            eq(evalRuns.isShadow, false),
          ),
        )
        .orderBy(desc(evalRuns.finishedAt))
        .limit(1),
    );
    const last = runs[0];
    return {
      template,
      manifest_hash: (snapshot?.manifestHash ?? null) as string | null,
      update_available,
      last_evaluation: last?.decision
        ? { decision: last.decision, score: last.score, finished_at: last.finishedAt }
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
   * Capability-registry check (ledger 3.3): when the org has a published
   * `model_catalog` config, every `allowed_models` entry must reference an
   * ENABLED `provider/model` pair from that catalog. No published catalog =
   * catalog governance not opted into for this org — structural validation
   * only. Invalid refs must be rejected BEFORE `PUBLISHED` (Phase 3 exit gate).
   */
  private async rejectUnknownModels(orgId: string, payload: AssistantPayload): Promise<void> {
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
    const names = tools.map((t) => t.name);
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({
          name: toolCatalog.name,
          hash: toolCatalog.hash,
          enabled: toolCatalog.enabled,
        })
        .from(toolCatalog)
        .where(eq(toolCatalog.organizationId, orgId)),
    );
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
    void names;
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
    await this.db.withOrg(orgId, async (tx) => {
      const versionRows = await tx
        .select()
        .from(assistantVersions)
        .where(
          and(eq(assistantVersions.id, versionId), eq(assistantVersions.organizationId, orgId)),
        )
        .limit(1);
      const version = versionRows[0];
      if (!version || version.assistantId !== assistantId) {
        throw ApiError.notFound('assistant version');
      }
      // Content-addressed + immutable (drizzle/0069): one row per
      // (version, content hash). A draft edited after the snapshot was taken
      // INSERTS a new row — never mutates the existing one. In-place refresh
      // was the in-flight edit race: an eval dispatched against H1 completed
      // after the refresh and pinned H2 in its provenance, and in-flight
      // runs re-reading the snapshot by id silently switched content
      // mid-run. Runs reference their snapshot row by id and always see the
      // content they were dispatched against.
      const existing = await tx
        .select({ id: policySnapshots.id })
        .from(policySnapshots)
        .where(
          and(
            eq(policySnapshots.assistantVersionId, versionId),
            eq(policySnapshots.hash, version.hash),
          ),
        )
        .limit(1);
      if (existing.length > 0) {
        return; // snapshot already reflects this exact content
      }
      const payload: AssistantPayload = {
        model_policy: version.modelPolicy as AssistantPayload['model_policy'],
        context_policy: version.contextPolicy as AssistantPayload['context_policy'],
        tool_policy: version.toolPolicy as AssistantPayload['tool_policy'],
        knowledge_policy: (version.knowledgePolicy ??
          undefined) as AssistantPayload['knowledge_policy'],
        guardrail_policy: version.guardrailPolicy as AssistantPayload['guardrail_policy'],
        instructions: (version.instructions ?? undefined) as AssistantPayload['instructions'],
        model_params: (version.modelParams ?? undefined) as AssistantPayload['model_params'],
        budget_policy: (version.budgetPolicy ?? undefined) as AssistantPayload['budget_policy'],
        brand: (version.brand ?? undefined) as AssistantPayload['brand'],
      };
      const validated = validateAssistantPayload(payload);
      if (!validated.ok) {
        throw ApiError.validation({ assistant: validated.issues });
      }
      const manifest = await this.manifests.resolveForPublish(
        tx,
        orgId,
        assistantId,
        validated.normalized,
      );
      const snapshotValues = {
        organizationId: orgId,
        assistantVersionId: versionId,
        snapshotVersion: POLICY_SNAPSHOT_SCHEMA_VERSION,
        modelPolicy: version.modelPolicy,
        contextPolicy: version.contextPolicy,
        toolPolicy: version.toolPolicy,
        guardrailPolicy: version.guardrailPolicy,
        knowledgePolicy: version.knowledgePolicy ?? null,
        instructions: version.instructions ?? null,
        modelParams: version.modelParams ?? null,
        budgetPolicy: version.budgetPolicy ?? null,
        brand: version.brand ?? null,
        hash: version.hash,
        toolBindings: manifest.toolBindings,
        knowledgePins: manifest.knowledgePins,
        modelRef: manifest.modelRef,
        templateRef: manifest.templateRef,
        manifestHash: manifest.manifestHash,
      };
      // Immutable rows: a new content hash always INSERTS. The unique key is
      // (assistant_version_id, hash) — concurrent inserts of the same
      // content resolve via on-conflict-do-nothing below.
      await tx
        .insert(policySnapshots)
        .values(snapshotValues)
        .onConflictDoNothing({ target: [policySnapshots.assistantVersionId, policySnapshots.hash] });
    });
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
   * Shared publish/rollback commit — version row + resolved snapshot + active
   * pointer in ONE transaction (caller holds the advisory lock).
   *
   * In-TX gates (no TOCTOU against concurrent publishes of this assistant):
   *  - no-op guard (active pointer already carries the payload),
   *  - BLOCK gate (TPL-6.1): content whose hash matches a BLOCK-decided eval
   *    run can never publish again — critical failures are mathematically
   *    unpublishable. (Concurrent eval completion racing this TX is covered
   *    by the release-pointer gate at promotion time.)
   * Resolution failures (missing pins, drifted catalog) abort the TX —
   * nothing half-publishes.
   */
  /**
   * Post-commit degraded-knowledge audit. Reads the COMMITTED snapshot (no
   * TOCTOU — the gate already enforced inside the TX) and records the
   * acknowledged slugs only when the bypass flag was actually set. Silent
   * when unneeded so the audit stream stays signal-dense.
   */
  private async auditDegradedBypass(
    orgId: string,
    versionId: string,
    actorId: string,
    acknowledged: boolean,
  ): Promise<void> {
    if (!acknowledged) {
      return;
    }
    const snapRows = await this.db.withOrg(orgId, async (tx) => {
      // The COMMITTED snapshot: the row matching the version's live hash
      // (content-addressed, drizzle/0069 — older rows are immutable history).
      const vRows = await tx
        .select({ hash: assistantVersions.hash })
        .from(assistantVersions)
        .where(and(eq(assistantVersions.id, versionId), eq(assistantVersions.organizationId, orgId)))
        .limit(1);
      if (vRows.length === 0) return [];
      return tx
        .select({ knowledgePins: policySnapshots.knowledgePins })
        .from(policySnapshots)
        .where(
          and(
            eq(policySnapshots.assistantVersionId, versionId),
            eq(policySnapshots.hash, vRows[0].hash),
          ),
        )
        .limit(1);
    });
    const pins = { knowledgePins: (snapRows[0]?.knowledgePins ?? []) as never };
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

  private async insertPublishedVersion(
    tx: NodePgDatabase,
    input: {
      orgId: string;
      assistantId: string;
      version: number;
      schemaVersion: number;
      normalized: AssistantPayload;
      publishedBy: string;
      rollbackOf: string | null;
      /** P6: content lineage (draft fork point, or restored version). */
      parentVersionId: string | null;
      acknowledgeDegradedKnowledge: boolean;
    },
  ): Promise<AssistantVersion> {
    const hash = hashPayload(input.normalized);
    // P4: manifest resolves BEFORE the no-op guard — the guard compares
    // RESOLVED SETS, not content. Identical content over a drifted catalog
    // (perimeter, pins, model refs) is a legitimate re-publish (re-pin),
    // not a no-op. Eval gates below stay content-hash keyed (decisions judge
    // content, and a bad payload must not re-enter under a fresh manifest).
    const manifest = await this.manifests.resolveForPublish(
      tx,
      input.orgId,
      input.assistantId,
      input.normalized,
    );
    await this.rejectNoOpPublish(tx, input.assistantId, hash, manifest.manifestHash);
    await this.rejectBlockedContent(tx, input.orgId, input.assistantId, hash);
    // REL-3.2 (D1 adopted): a template release_policy that declares required
    // checks makes a fresh PASS evaluation a publish precondition — the
    // BLOCK gate alone was vacuous while nothing executed (GAP-04).
    await this.rejectUnmetRequiredChecks(tx, input.orgId, input.assistantId, hash);
    // Degraded-knowledge gate: unresolved pins mean the agent would ship
    // without context the maker assumes it has (retrieval fails closed).
    // Refuse with the slugs — unless explicitly acknowledged (audited at the
    // call site from the committed snapshot).
    // P0 (GAP-1): undercovered pins join the same gate. A READY document
    // whose pinned version is not fully embedded for the active model scores
    // NOTHING at retrieval — shipping it is the same class of silent context
    // loss as an unresolved slug. Same flag acknowledges both; the message
    // names which slugs and how many chunks are still indexing.
    const degraded = unresolvedPinSlugs(manifest);
    const undercovered = undercoveredPinSlugs(manifest);
    if ((degraded.length > 0 || undercovered.length > 0) && !input.acknowledgeDegradedKnowledge) {
      const parts: string[] = [];
      if (degraded.length > 0) {
        parts.push(`unresolved knowledge sources cannot publish: ${degraded.join(', ')}`);
      }
      for (const pin of undercovered) {
        parts.push(
          `${pin.slug}: vectors indexing for model ${pin.model} (${pin.embedded}/${pin.total} chunks)`,
        );
      }
      throw ApiError.validation({
        knowledge_pins: `${parts.join('; ')} — ingest and map the documents (or wait for indexing), or acknowledge degraded knowledge explicitly`,
      });
    }
    const rows = await tx
      .insert(assistantVersions)
      .values({
        assistantId: input.assistantId,
        organizationId: input.orgId,
        version: input.version,
        schemaVersion: input.schemaVersion,
        status: 'PUBLISHED',
        modelPolicy: input.normalized.model_policy,
        contextPolicy: input.normalized.context_policy,
        toolPolicy: input.normalized.tool_policy,
        knowledgePolicy: input.normalized.knowledge_policy ?? null,
        guardrailPolicy: input.normalized.guardrail_policy,
        instructions: input.normalized.instructions ?? null,
        modelParams: input.normalized.model_params ?? null,
        budgetPolicy: input.normalized.budget_policy ?? null,
        brand: input.normalized.brand ?? null,
        rollbackOf: input.rollbackOf,
        parentVersionId: input.parentVersionId,
        hash,
        publishedAt: new Date().toISOString(),
        publishedBy: input.publishedBy,
      })
      .returning();
    const inserted = rows[0];

    // Snapshot materialized in the same TX as publish — the pinning
    // authority Phase 4 runs reference (pinned decision, ledger 3.1),
    // now carrying the fully resolved set (TPL-5.2 … TPL-5.5).
    await tx.insert(policySnapshots).values({
      organizationId: input.orgId,
      assistantVersionId: inserted.id,
      snapshotVersion: POLICY_SNAPSHOT_SCHEMA_VERSION,
      modelPolicy: input.normalized.model_policy,
      contextPolicy: input.normalized.context_policy,
      toolPolicy: input.normalized.tool_policy,
      guardrailPolicy: input.normalized.guardrail_policy,
      knowledgePolicy: input.normalized.knowledge_policy ?? null,
      instructions: input.normalized.instructions ?? null,
      modelParams: input.normalized.model_params ?? null,
      budgetPolicy: input.normalized.budget_policy ?? null,
      brand: input.normalized.brand ?? null,
      hash,
      toolBindings: manifest.toolBindings,
      knowledgePins: manifest.knowledgePins,
      modelRef: manifest.modelRef,
      templateRef: manifest.templateRef,
      manifestHash: manifest.manifestHash,
    });

    // P5 (degraded lifecycle): a publish that WAIVED degraded pins starts a
    // 7-day clock instead of a silent waiver; a healthy publish clears it.
    // Reaching here with degraded/undercovered non-empty implies the bypass
    // flag (the gate above threw otherwise).
    const waived = degraded.length > 0 || undercovered.length > 0;
    if (waived) {
      const waivedSlugs = [
        ...degraded.map((s) => `unresolved:${s}`),
        ...undercovered.map((p) => `${p.slug}:${p.embedded}/${p.total}`),
      ];
      await tx
        .update(assistants)
        .set({
          activeVersionId: inserted.id,
          degradedUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(),
          degradedReason: waivedSlugs.join('; ').slice(0, 512),
          degradedAlertedAt: null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(assistants.id, input.assistantId));
    } else {
      await tx
        .update(assistants)
        .set({
          activeVersionId: inserted.id,
          degradedUntil: null,
          degradedReason: null,
          degradedAlertedAt: null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(assistants.id, input.assistantId));
    }

    return inserted;
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
    const orgFilter = (alias: string) =>
      input.orgId === undefined
        ? sql``
        : sql`and ${sql.raw(alias)}.organization_id = ${input.orgId}::uuid`;
    const overdue = await this.db.withBypass(async (tx) => {
      const rows = await tx.execute(sql`
        select id, organization_id, name from assistants
        where degraded_until is not null
          and degraded_until < now()
          and disabled_at is null
          ${orgFilter('assistants')}
        limit 100
        for update skip locked
      `);
      return rows.rows as Array<{ id: string; organization_id: string; name: string }>;
    });
    for (const row of overdue) {
      try {
        await this.setDisabled({
          orgId: row.organization_id,
          assistantId: row.id,
          disabled: true,
          reason:
            'degraded knowledge unresolved past the 7-day waiver — fix the pins and re-enable',
          actorId: 'system:degraded-sweep',
        });
        suspended.push({ orgId: row.organization_id, assistantId: row.id, name: row.name });
      } catch {
        // Per-candidate isolation (a concurrent disable/rename just skips).
      }
    }
    const soon = await this.db.withBypass(async (tx) => {
      const rows = await tx.execute(sql`
        select id, organization_id, name from assistants
        where degraded_until is not null
          and degraded_until >= now()
          and degraded_until < now() + interval '24 hours'
          and degraded_alerted_at is null
          and disabled_at is null
          ${orgFilter('assistants')}
        limit 100
        for update skip locked
      `);
      return rows.rows as Array<{ id: string; organization_id: string; name: string }>;
    });
    for (const row of soon) {
      try {
        await this.db.withBypass(async (tx) => {
          await tx.execute(sql`
            update assistants set degraded_alerted_at = now()
            where id = ${row.id}::uuid and degraded_alerted_at is null
          `);
        });
        await this.audit.add({
          action: 'assistant.degraded_warning',
          resourceType: 'assistant',
          resourceId: row.id,
          actorType: 'service',
          actorId: 'system:degraded-sweep',
          tenantId: row.organization_id,
          details: {},
        });
        dueSoon.push({ orgId: row.organization_id, assistantId: row.id, name: row.name });
      } catch {
        // Per-candidate isolation.
      }
    }
    return { suspended, dueSoon };
  }

  /**
   * REL-3.2 — the release-policy publish gate (D1 adopted, report §6.4.1).
   * When the version's source template declares `required` checks in its
   * release_policy, publishing demands the latest eval decision on THIS
   * content hash to be PASS (WARN/BLOCK/absent all refuse). Templates
   * without declared checks keep the legacy posture (BLOCK gate only) —
   * the policy declares the bar; the gate enforces it. Canary WARN
   * leniency is moot at publish time: a canary promotes a version that
   * already had to PASS here.
   */
  private async rejectUnmetRequiredChecks(
    tx: NodePgDatabase,
    orgId: string,
    assistantId: string,
    hash: string,
  ): Promise<void> {
    // Rule lives in release-gate.ts (REL-3.3 matrix) — this stays a thin
    // throw-wrapper so the publish path and the tested evaluator cannot drift.
    // Throwing on either refusal is behavior-preserving here: the BLOCK gate
    // runs first in the publish sequence, so by the time this runs the BLOCK
    // branch cannot fire — unless the caller sequence changes, in which case
    // refusing is still the fail-closed answer.
    const refusal = await evaluatePublishGate(tx, orgId, assistantId, hash);
    if (refusal) {
      throwGateRefusal(refusal, assistantId);
    }
  }

  /**
   * BLOCK gate (TPL-6.1): the LATEST completed eval decision for this content
   * hash must not be BLOCK — critical failures are mathematically unpublishable
   * while they stand. Keyed by CONTENT hash (not row id), so the same bad
   * payload cannot re-enter through rollback-as-new or a fresh draft either.
   * "Latest wins" is deliberate: a re-evaluation that passes clears an earlier
   * BLOCK — publishability tracks the current verdict, not history.
   */
  private async rejectBlockedContent(
    tx: NodePgDatabase,
    orgId: string,
    assistantId: string,
    hash: string,
  ): Promise<void> {
    // Same evaluator as the required-checks gate (REL-3.3): in publish
    // sequence this runs first, so a BLOCK refusal surfaces here with the
    // BLOCK message before the required-checks rule is ever consulted.
    const refusal = await evaluatePublishGate(tx, orgId, assistantId, hash);
    if (refusal && refusal.gate === 'blocked_content') {
      throwGateRefusal(refusal, assistantId);
    }
  }

  /**
   * Publish/rollback that would change NOTHING is a no-op — rejected as a
   * conflict. Compared on content hash AND resolved-set hash jointly:
   * - same content + same manifest → true no-op (the concurrent-publish
   *   race lands here deterministically);
   * - same content + drifted manifest (perimeter widened, pins re-resolved,
   *   model refs moved) → legitimate re-publish that re-pins the world
   *   (refusing it would strand operators with no path to re-pin);
   * - different content → legitimate publish even when the resolved set is
   *   untouched (the manifest hash covers pins/bindings/refs, NOT the
   *   prompt or params — prompt-only iteration must always publish).
   * Restoring a payload that exists on a non-active PUBLISHED row is
   * legitimate (that is what rollback is for), so only the active pointer
   * is compared. Legacy snapshots without a manifest hash fall back to the
   * content comparison (their historical behavior, unchanged).
   */
  private async rejectNoOpPublish(
    tx: NodePgDatabase,
    assistantId: string,
    hash: string,
    manifestHash: string | null,
  ): Promise<void> {
    const rows = await tx.execute(sql`
      select av.hash as active_hash, ps.manifest_hash as active_manifest_hash
      from assistants a
      left join assistant_versions av on av.id = a.active_version_id
      left join policy_snapshots ps on ps.assistant_version_id = av.id and ps.hash = av.hash
      where a.id = ${assistantId}::uuid
      limit 1
    `);
    const row = (
      rows.rows as Array<{ active_hash: string | null; active_manifest_hash: string | null }>
    )[0];
    if (!row || row.active_hash === null) {
      return;
    }
    if (row.active_hash !== hash) {
      return;
    }
    if (row.active_manifest_hash === null || manifestHash === null) {
      throw ApiError.conflict('assistant active version already carries this payload', {
        assistant_id: assistantId,
      });
    }
    if (row.active_manifest_hash === manifestHash) {
      throw ApiError.conflict(
        'assistant active version already carries this payload and resolved set',
        {
          assistant_id: assistantId,
        },
      );
    }
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
 * Unique-violation mapping for the assistant identity plane (never leak a raw
 * 23505): the org-name unique index is a caller-fixable conflict; the draft
 * sentinel collision (uq_assistant_versions_assistant_version on version=0)
 * means a DRAFT already exists — publish or delete it first.
 */
function mapAssistantUniqueViolation(err: unknown, name: string): unknown {
  // drizzle wraps driver errors (DrizzleQueryError.cause) — read code via pgViolation or raw 23505s escape.
  const pg = pgViolation(err);
  if (pg.code !== '23505') {
    return err;
  }
  if (pg.constraint === 'uq_assistants_org_name') {
    return ApiError.conflict(
      'assistant name already taken in this organization — supply a distinct name',
      { name },
    );
  }
  if (pg.constraint === 'uq_assistant_versions_assistant_version') {
    return ApiError.conflict(
      'a draft version already exists for this assistant — publish or delete it before drafting another',
      { reason: 'draft_exists' },
    );
  }
  return err;
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
