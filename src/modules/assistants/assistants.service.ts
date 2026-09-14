import { and, desc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
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
import { validateAssistantPayload, assertPublishable, assistantPayloadSchema, rejectUnknownPayloadKeys, AssistantPayload } from './validation';
import { evaluatePublishGate, throwGateRefusal } from './release-gate';
import { TemplatesService } from './templates.service';
import { ManifestResolutionService } from './manifest-resolution.service';
import { ConversationsService } from '../conversations/conversations.service';
import { evalRuns, evalDatasets } from '../knowledge/eval.schema';
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
  }): Promise<{ assistant: Assistant; version_id: string | null; template: string | null; hash: string | null }> {
    assertOrgId(input.orgId);
    assertName(input.name);
    if (input.template && input.definition) {
      throw ApiError.validation({ template: 'template and definition are mutually exclusive — install copies from exactly one source' });
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
  async remove(input: { orgId: string; assistantId: string; actorId: string }): Promise<{ ok: true }> {
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
  async setDisabled(input: { orgId: string; assistantId: string; disabled: boolean; reason?: string; actorId: string }): Promise<Assistant> {
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
            : { disabledAt: null, disabledBy: null, disabledReason: null, updatedAt: new Date().toISOString() },
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
    void assistant;

    const validated = validateAssistantPayload(input.payload);
    if (!validated.ok) {
      throw ApiError.validation({ assistant: validated.issues });
    }
    const hash = hashPayload(validated.normalized);

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
  async publish(input: { orgId: string; assistantId: string; versionId: string; publishedBy: string }): Promise<AssistantVersion> {
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
    // Re-validate the FULL draft row — instructions/model_params/budget live
    // on the version row, not just the policy columns. (A policies-only
    // rebuild silently drops the prompt and can never satisfy
    // assertPublishable — that path is why every publish must start here.)
    const payload: AssistantPayload = {
      model_policy: draft.modelPolicy as AssistantPayload['model_policy'],
      context_policy: draft.contextPolicy as AssistantPayload['context_policy'],
      tool_policy: draft.toolPolicy as AssistantPayload['tool_policy'],
      knowledge_policy: draft.knowledgePolicy as AssistantPayload['knowledge_policy'],
      guardrail_policy: draft.guardrailPolicy as AssistantPayload['guardrail_policy'],
      instructions: (draft.instructions ?? undefined) as AssistantPayload['instructions'],
      model_params: (draft.modelParams ?? undefined) as AssistantPayload['model_params'],
      budget_policy: (draft.budgetPolicy ?? undefined) as AssistantPayload['budget_policy'],
    };
    const validated = validateAssistantPayload(payload);
    if (!validated.ok) {
      throw ApiError.validation({ assistant: validated.issues });
    }
    await this.rejectUnknownModels(input.orgId, validated.normalized);
    assertPublishable(validated.normalized);
    await this.assertToolPins(input.orgId, validated.normalized);

    const published = await this.db.withOrg(input.orgId, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`assistant:${input.assistantId}`}))`);

      const latest = await tx
        .select({ version: assistantVersions.version })
        .from(assistantVersions)
        .where(and(eq(assistantVersions.assistantId, input.assistantId), eq(assistantVersions.status, 'PUBLISHED')))
        .orderBy(desc(assistantVersions.version))
        .limit(1);
      // Also consider non-PUBLISHED but already versioned rows (RETIRED, etc.)
      const maxAll = await tx
        .select({ version: assistantVersions.version })
        .from(assistantVersions)
        .where(and(eq(assistantVersions.assistantId, input.assistantId), sql`${assistantVersions.version} > 0`))
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
      });
    });

    await this.audit.add({
      action: 'assistant.published',
      resourceType: 'assistant_version',
      resourceId: published.id,
      actorType: 'account',
      actorId: input.publishedBy,
      tenantId: input.orgId,
      details: { assistant_id: input.assistantId, version: published.version, hash: published.hash.slice(0, 16) },
    });
    AssistantsService.logger.log(`assistant ${input.assistantId} published v${published.version} for org ${input.orgId}`);
    return published;
  }

  async retire(input: { orgId: string; assistantId: string; versionId: string; retiredBy: string }): Promise<AssistantVersion> {
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
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`assistant:${input.assistantId}`}))`);
      const active = await tx
        .select({ activeVersionId: assistants.activeVersionId })
        .from(assistants)
        .where(eq(assistants.id, input.assistantId))
        .limit(1);
      if (active[0]?.activeVersionId === version.id) {
        // The active pointer must never reference a RETIRED version — runs
        // started after retire would pin a version the org has withdrawn.
        // Withdraw by publishing/rolling back to a successor first.
        throw ApiError.conflict('cannot retire the active version — publish or roll back to a successor first', {
          assistant_id: input.assistantId,
          version_id: version.id,
        });
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
  }): Promise<AssistantVersion> {
    const target = await this.getVersion(input.orgId, input.toVersionId);
    if (!target || target.assistantId !== input.assistantId) {
      throw ApiError.notFound('assistant version');
    }
    if (target.status === 'DRAFT') {
      throw ApiError.validation({ rollback: 'cannot rollback to a DRAFT' });
    }
    // Rollback = NEW PUBLISHED version restoring target's payload (full row —
    // same always-throw trap as publish: instructions/model_params/budget
    // live on the version row and must round-trip, or rollback 500s).
    const payload: AssistantPayload = {
      model_policy: target.modelPolicy as AssistantPayload['model_policy'],
      context_policy: target.contextPolicy as AssistantPayload['context_policy'],
      tool_policy: target.toolPolicy as AssistantPayload['tool_policy'],
      knowledge_policy: target.knowledgePolicy as AssistantPayload['knowledge_policy'],
      guardrail_policy: target.guardrailPolicy as AssistantPayload['guardrail_policy'],
      instructions: (target.instructions ?? undefined) as AssistantPayload['instructions'],
      model_params: (target.modelParams ?? undefined) as AssistantPayload['model_params'],
      budget_policy: (target.budgetPolicy ?? undefined) as AssistantPayload['budget_policy'],
    };
    const validated = validateAssistantPayload(payload);
    if (!validated.ok) {
      throw ApiError.validation({ assistant: validated.issues });
    }
    await this.rejectUnknownModels(input.orgId, validated.normalized);
    assertPublishable(validated.normalized);
    await this.assertToolPins(input.orgId, validated.normalized);
    const published = await this.db.withOrg(input.orgId, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`assistant:${input.assistantId}`}))`);
      const maxAll = await tx
        .select({ version: assistantVersions.version })
        .from(assistantVersions)
        .where(and(eq(assistantVersions.assistantId, input.assistantId), sql`${assistantVersions.version} > 0`))
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
      });
    });
    await this.audit.add({
      action: 'assistant.rolled_back',
      resourceType: 'assistant_version',
      resourceId: published.id,
      actorType: 'account',
      actorId: input.publishedBy,
      tenantId: input.orgId,
      details: { assistant_id: input.assistantId, to_version: target.version, new_version: published.version },
    });
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

  async getSnapshotForVersion(orgId: string, assistantId: string, versionId: string): Promise<PolicySnapshot | null> {
    assertOrgId(orgId);
    assertUuid(assistantId);
    assertUuid(versionId);
    return this.db.withOrg(orgId, async (tx) => {
      const version = await tx
        .select({ id: assistantVersions.id, assistantId: assistantVersions.assistantId })
        .from(assistantVersions)
        .where(and(eq(assistantVersions.id, versionId), eq(assistantVersions.assistantId, assistantId)))
        .limit(1);
      if (version.length === 0) {
        return null;
      }
      const rows = await tx.select().from(policySnapshots).where(eq(policySnapshots.assistantVersionId, versionId)).limit(1);
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
          dataset_id: 'no template dataset for this assistant — install from a template or pass dataset_id explicitly',
        });
      }
      datasetId = resolved;
    }
    return this.evals.startRun({
      orgId: input.orgId,
      datasetId,
      assistantVersionId: input.versionId,
      attemptsPerCase: input.attemptsPerCase ?? 1,
      actor: input.actor,
      ...(input.environment ? { environment: input.environment } : {}),
    });
  }

  /** Template-seeded dataset id for an assistant (`template:<slug>@<version>`), if installed. */
  private async resolveTemplateDataset(orgId: string, assistantId: string): Promise<string | null> {
    const name = await this.db.withOrg(orgId, async (tx) => {
      const installs = await tx.select().from(assistantInstalls).where(eq(assistantInstalls.assistantId, assistantId)).limit(1);
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
      tx.select({ id: evalDatasets.id }).from(evalDatasets).where(and(eq(evalDatasets.organizationId, orgId), eq(evalDatasets.name, name))).limit(1),
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
      const entry = updates.find((u) => u.slug === template.slug && u.installed_version === template.version);
      update_available = entry?.update_available ?? 'none';
    }
    const runs = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({ decision: evalRuns.decision, score: evalRuns.score, finishedAt: evalRuns.finishedAt })
        .from(evalRuns)
        .where(and(eq(evalRuns.organizationId, orgId), eq(evalRuns.assistantVersionId, versionId), eq(evalRuns.state, 'completed')))
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
    };
  }

  // ── Deterministic export / import (Phase 3 exit gate) ───────────────────

  /**
   * Export a version as a canonical envelope. Deterministic: identical payload
   * always serializes to the identical JSON string (sorted keys, schema_version included).
   */
  async exportVersion(orgId: string, assistantId: string, versionId: string): Promise<AssistantVersionExport> {
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
    if (!exported || typeof exported !== 'object' || typeof exported.hash !== 'string' || typeof exported.schema_version !== 'number') {
      throw ApiError.validation({ exported: 'must be an assistant version export envelope' });
    }
    // The hash covers the FULL normalized payload — the exact shape the
    // creation path hashes (canonicalHash over the parsed+defaulted payload).
    // Parse-normalize first so defaulted fields match; a legacy lossy
    // envelope (no instructions/model_params) then fails the hash check
    // instead of silently importing a v2 assistant without its prompt.
    const parsed = assistantPayloadSchema.safeParse(exported);
    if (!parsed.success) {
      throw ApiError.validation({
        exported: `payload failed schema validation: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
      });
    }
    const recomputed = hashPayload(parsed.data);
    if (recomputed !== exported.hash) {
      throw ApiError.validation({ hash: 'export envelope hash mismatch — payload is not canonical' });
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
    const loadCatalog = async (): Promise<{ models: Array<{ provider: string; model: string; enabled: boolean; regions?: string[] }> } | null> => {
      const latest = await this.configPublish.latest(orgId, 'model_catalog', null);
      return (latest?.payload ?? null) as { models: Array<{ provider: string; model: string; enabled: boolean; regions?: string[] }> } | null;
    };
    let catalog: { models: Array<{ provider: string; model: string; enabled: boolean; regions?: string[] }> } | null = null;
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
    const enabled = new Set(catalog.models.filter((m) => m.enabled).map((m) => `${m.provider}/${m.model}`));
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
    const rawResidency =
      String((residencyConfig?.payload as { residency?: string } | undefined)?.residency ?? 'default');
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
   * REL-2.4 — pre-publish test conversation: execute a version (DRAFT
   * included) through the real conversation plane without publishing it.
   * The run is run_kind='test': no quota reservation, no billable usage
   * entry, invisible to end users and rollups. A draft version gets its
   * policy snapshot materialized HERE (snapshots are publish artifacts —
   * the test path synthesizes the same resolved set from the draft row so
   * pinning has something to point at).
   *
   * Deliberately NOT one transaction: the snapshot must commit before
   * acceptMessage (a separate transaction) can pin it. A failure after the
   * snapshot leaves an orphan test conversation — harmless by construction.
   */
  async startTestRun(input: { orgId: string; assistantId: string; versionId: string; text: string; actor: string }): Promise<{
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

    await this.db.withOrg(input.orgId, async (tx) => {
      const versionRows = await tx
        .select()
        .from(assistantVersions)
        .where(and(eq(assistantVersions.id, input.versionId), eq(assistantVersions.organizationId, input.orgId)))
        .limit(1);
      const version = versionRows[0];
      if (!version || version.assistantId !== input.assistantId) {
        throw ApiError.notFound('assistant version');
      }
      const existing = await tx.select({ id: policySnapshots.id }).from(policySnapshots).where(eq(policySnapshots.assistantVersionId, input.versionId)).limit(1);
      if (existing.length === 0) {
        const payload: AssistantPayload = {
          model_policy: version.modelPolicy as AssistantPayload['model_policy'],
          context_policy: version.contextPolicy as AssistantPayload['context_policy'],
          tool_policy: version.toolPolicy as AssistantPayload['tool_policy'],
          knowledge_policy: version.knowledgePolicy as AssistantPayload['knowledge_policy'],
          guardrail_policy: version.guardrailPolicy as AssistantPayload['guardrail_policy'],
          instructions: (version.instructions ?? undefined) as AssistantPayload['instructions'],
          model_params: (version.modelParams ?? undefined) as AssistantPayload['model_params'],
          budget_policy: (version.budgetPolicy ?? undefined) as AssistantPayload['budget_policy'],
        };
        const validated = validateAssistantPayload(payload);
        if (!validated.ok) {
          throw ApiError.validation({ assistant: validated.issues });
        }
        const manifest = await this.manifests.resolveForPublish(tx, input.orgId, input.assistantId, validated.normalized);
        await tx.insert(policySnapshots).values({
          organizationId: input.orgId,
          assistantVersionId: input.versionId,
          snapshotVersion: POLICY_SNAPSHOT_SCHEMA_VERSION,
          modelPolicy: version.modelPolicy,
          contextPolicy: version.contextPolicy,
          toolPolicy: version.toolPolicy,
          guardrailPolicy: version.guardrailPolicy,
          knowledgePolicy: version.knowledgePolicy ?? null,
          instructions: version.instructions ?? null,
          modelParams: version.modelParams ?? null,
          budgetPolicy: version.budgetPolicy ?? null,
          hash: version.hash,
          toolBindings: manifest.toolBindings,
          knowledgePins: manifest.knowledgePins,
          modelRef: manifest.modelRef,
          templateRef: manifest.templateRef,
          manifestHash: manifest.manifestHash,
        });
      }
    });

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
    return { conversation_id: conversation.id, message_id: accepted.message_id, run_id: accepted.run_id };
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
    },
  ): Promise<AssistantVersion> {
    const hash = hashPayload(input.normalized);
    await this.rejectNoOpPublish(tx, input.assistantId, hash);
    await this.rejectBlockedContent(tx, input.orgId, input.assistantId, hash);
    // REL-3.2 (D1 adopted): a template release_policy that declares required
    // checks makes a fresh PASS evaluation a publish precondition — the
    // BLOCK gate alone was vacuous while nothing executed (GAP-04).
    await this.rejectUnmetRequiredChecks(tx, input.orgId, input.assistantId, hash);
    const manifest = await this.manifests.resolveForPublish(tx, input.orgId, input.assistantId, input.normalized);
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
        rollbackOf: input.rollbackOf,
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
      hash,
      toolBindings: manifest.toolBindings,
      knowledgePins: manifest.knowledgePins,
      modelRef: manifest.modelRef,
      templateRef: manifest.templateRef,
      manifestHash: manifest.manifestHash,
    });

    await tx.update(assistants).set({ activeVersionId: inserted.id, updatedAt: new Date().toISOString() }).where(eq(assistants.id, input.assistantId));

    return inserted;
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
  private async rejectUnmetRequiredChecks(tx: NodePgDatabase, orgId: string, assistantId: string, hash: string): Promise<void> {
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
  private async rejectBlockedContent(tx: NodePgDatabase, orgId: string, assistantId: string, hash: string): Promise<void> {
    // Same evaluator as the required-checks gate (REL-3.3): in publish
    // sequence this runs first, so a BLOCK refusal surfaces here with the
    // BLOCK message before the required-checks rule is ever consulted.
    const refusal = await evaluatePublishGate(tx, orgId, assistantId, hash);
    if (refusal && refusal.gate === 'blocked_content') {
      throwGateRefusal(refusal, assistantId);
    }
  }

  /**
   * Publish/rollback whose payload equals the assistant's CURRENT ACTIVE
   * version hash is a no-op — rejected as a conflict. Restoring a payload
   * that exists on a non-active PUBLISHED row is legitimate (that is what
   * rollback is for), so only the active pointer is compared.
   */
  private async rejectNoOpPublish(tx: NodePgDatabase, assistantId: string, hash: string): Promise<void> {
    const rows = await tx
      .select({ activeHash: assistantVersions.hash })
      .from(assistants)
      .leftJoin(assistantVersions, eq(assistantVersions.id, assistants.activeVersionId))
      .where(eq(assistants.id, assistantId))
      .limit(1);
    if (rows[0]?.activeHash === hash) {
      throw ApiError.conflict('assistant active version already carries this payload', { assistant_id: assistantId });
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
  const pg = err as { code?: string; constraint?: string };
  if (pg?.code !== '23505') {
    return err;
  }
  if (pg.constraint === 'uq_assistants_org_name') {
    return ApiError.conflict('assistant name already taken in this organization — supply a distinct name', { name });
  }
  if (pg.constraint === 'uq_assistant_versions_assistant_version') {
    return ApiError.conflict('a draft version already exists for this assistant — publish or delete it before drafting another', { reason: 'draft_exists' });
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
