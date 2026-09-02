import { and, desc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import {
  assistants,
  assistantVersions,
  policySnapshots,
  Assistant,
  AssistantVersion,
  PolicySnapshot,
  AssistantVersionExport,
  POLICY_SNAPSHOT_SCHEMA_VERSION,
} from './schema';
import { validateAssistantPayload, AssistantPayload } from './validation';
import { canonicalHash } from '../../common/crypto/canonical-hash';

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

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  // ── Assistants (identity) ────────────────────────────────────────────────

  async create(input: { orgId: string; name: string; description?: string | null; createdBy: string }): Promise<Assistant> {
    assertOrgId(input.orgId);
    assertName(input.name);
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
    const row = rows[0];
    await this.audit.add({
      action: 'assistant.created',
      resourceType: 'assistant',
      resourceId: row.id,
      actorType: 'account',
      actorId: input.createdBy,
      tenantId: input.orgId,
      details: { name: row.name },
    });
    return row;
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
    return this.db.withOrg(orgId, (tx) => tx.select().from(assistants).where(eq(assistants.organizationId, orgId)));
  }

  // ── Versions ─────────────────────────────────────────────────────────────

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

    // DRAFT is always a new row; version is assigned only on publish.
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
          hash,
        })
        .returning(),
    );
    const row = rows[0];
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
        .orderBy(desc(assistantVersions.version), desc(assistantVersions.createdAt)),
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
    // Re-validate before publish — domain invariants must hold at publish time.
    const payload: AssistantPayload = {
      model_policy: draft.modelPolicy as AssistantPayload['model_policy'],
      context_policy: draft.contextPolicy as AssistantPayload['context_policy'],
      tool_policy: draft.toolPolicy as AssistantPayload['tool_policy'],
      knowledge_policy: draft.knowledgePolicy as AssistantPayload['knowledge_policy'],
      guardrail_policy: draft.guardrailPolicy as AssistantPayload['guardrail_policy'],
    };
    const validated = validateAssistantPayload(payload);
    if (!validated.ok) {
      throw ApiError.validation({ assistant: validated.issues });
    }

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

      const hash = hashPayload(validated.normalized);
      await this.rejectNoOpPublish(tx, input.assistantId, hash);
      const rows = await tx
        .insert(assistantVersions)
        .values({
          assistantId: input.assistantId,
          organizationId: input.orgId,
          version: nextVersion,
          schemaVersion: draft.schemaVersion,
          status: 'PUBLISHED',
          modelPolicy: validated.normalized.model_policy,
          contextPolicy: validated.normalized.context_policy,
          toolPolicy: validated.normalized.tool_policy,
          knowledgePolicy: validated.normalized.knowledge_policy ?? null,
          guardrailPolicy: validated.normalized.guardrail_policy,
          hash,
          publishedAt: new Date().toISOString(),
          publishedBy: input.publishedBy,
        })
        .returning();
      const inserted = rows[0];

      // Snapshot materialized in the same TX as publish — the pinning
      // authority Phase 4 runs will reference (pinned decision, ledger 3.1).
      await tx.insert(policySnapshots).values({
        organizationId: input.orgId,
        assistantVersionId: inserted.id,
        snapshotVersion: POLICY_SNAPSHOT_SCHEMA_VERSION,
        modelPolicy: validated.normalized.model_policy,
        contextPolicy: validated.normalized.context_policy,
        toolPolicy: validated.normalized.tool_policy,
        guardrailPolicy: validated.normalized.guardrail_policy,
        knowledgePolicy: validated.normalized.knowledge_policy ?? null,
        hash,
      });

      await tx.update(assistants).set({ activeVersionId: inserted.id, updatedAt: new Date().toISOString() }).where(eq(assistants.id, input.assistantId));

      return inserted;
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
    const version = await this.getVersion(input.orgId, input.versionId);
    if (!version || version.assistantId !== input.assistantId) {
      throw ApiError.notFound('assistant version');
    }
    if (version.status !== 'PUBLISHED') {
      throw ApiError.validation({ status: 'only PUBLISHED versions can be retired' });
    }
    const rows = await this.db.withOrg(input.orgId, (tx) =>
      tx.update(assistantVersions).set({ status: 'RETIRED', updatedAt: new Date().toISOString() }).where(eq(assistantVersions.id, version.id)).returning(),
    );
    const row = rows[0];
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
    // Rollback = NEW PUBLISHED version restoring target's payload.
    const payload: AssistantPayload = {
      model_policy: target.modelPolicy as AssistantPayload['model_policy'],
      context_policy: target.contextPolicy as AssistantPayload['context_policy'],
      tool_policy: target.toolPolicy as AssistantPayload['tool_policy'],
      knowledge_policy: target.knowledgePolicy as AssistantPayload['knowledge_policy'],
      guardrail_policy: target.guardrailPolicy as AssistantPayload['guardrail_policy'],
    };
    const validated = validateAssistantPayload(payload);
    if (!validated.ok) {
      throw ApiError.validation({ assistant: validated.issues });
    }
    const published = await this.db.withOrg(input.orgId, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`assistant:${input.assistantId}`}))`);
      const maxAll = await tx
        .select({ version: assistantVersions.version })
        .from(assistantVersions)
        .where(and(eq(assistantVersions.assistantId, input.assistantId), sql`${assistantVersions.version} > 0`))
        .orderBy(desc(assistantVersions.version))
        .limit(1);
      const nextVersion = (maxAll[0]?.version ?? 0) + 1;
      const hash = hashPayload(validated.normalized);
      await this.rejectNoOpPublish(tx, input.assistantId, hash);
      const rows = await tx
        .insert(assistantVersions)
        .values({
          assistantId: input.assistantId,
          organizationId: input.orgId,
          version: nextVersion,
          schemaVersion: target.schemaVersion,
          status: 'PUBLISHED',
          modelPolicy: validated.normalized.model_policy,
          contextPolicy: validated.normalized.context_policy,
          toolPolicy: validated.normalized.tool_policy,
          knowledgePolicy: validated.normalized.knowledge_policy ?? null,
          guardrailPolicy: validated.normalized.guardrail_policy,
          rollbackOf: target.id,
          hash,
          publishedAt: new Date().toISOString(),
          publishedBy: input.publishedBy,
        })
        .returning();
      const inserted = rows[0];
      await tx.insert(policySnapshots).values({
        organizationId: input.orgId,
        assistantVersionId: inserted.id,
        snapshotVersion: POLICY_SNAPSHOT_SCHEMA_VERSION,
        modelPolicy: validated.normalized.model_policy,
        contextPolicy: validated.normalized.context_policy,
        toolPolicy: validated.normalized.tool_policy,
        guardrailPolicy: validated.normalized.guardrail_policy,
        knowledgePolicy: validated.normalized.knowledge_policy ?? null,
        hash,
      });
      await tx.update(assistants).set({ activeVersionId: inserted.id, updatedAt: new Date().toISOString() }).where(eq(assistants.id, input.assistantId));
      return inserted;
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

  // ── Deterministic export / import (Phase 3 exit gate) ───────────────────

  /**
   * Export a version as a canonical envelope. Deterministic: identical payload
   * always serializes to the identical JSON string (sorted keys, schema_version included).
   */
  async exportVersion(orgId: string, versionId: string): Promise<AssistantVersionExport> {
    const version = await this.getVersion(orgId, versionId);
    if (!version || version.status === 'DRAFT') {
      throw ApiError.notFound('assistant version');
    }
    return {
      schema_version: version.schemaVersion,
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
    const recomputed = hashPayload({
      model_policy: exported.model_policy,
      context_policy: exported.context_policy,
      tool_policy: exported.tool_policy,
      // DB stores knowledge_policy as null; the canonical hash drops absent
      // keys, so null normalizes to undefined before the digest is recomputed.
      knowledge_policy: exported.knowledge_policy ?? undefined,
      guardrail_policy: exported.guardrail_policy,
    });
    if (recomputed !== exported.hash) {
      throw ApiError.validation({ hash: 'export envelope hash mismatch — payload is not canonical' });
    }
    return this.createVersion({
      orgId: input.orgId,
      assistantId: input.assistantId,
      payload: exported as unknown as AssistantPayload,
      createdBy: input.createdBy,
    });
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

function assertName(name: string): void {
  if (!name || name.trim().length < 2 || name.trim().length > 128) {
    throw ApiError.validation({ name: 'must be 2..128 chars' });
  }
}

function hashPayload(value: unknown): string {
  return canonicalHash(value);
}
