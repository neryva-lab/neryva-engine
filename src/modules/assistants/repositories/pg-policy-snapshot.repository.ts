/**
 * PostgreSQL `IPolicySnapshotRepository` — the `policy_snapshots`
 * aggregate (content-addressed policy snapshots written in the publish TX
 * and pinned by run acceptance).
 *
 * Transaction ownership: each method owns its `withOrg` unit of work.
 * `synthesizeSnapshotForVersion` (the extracted `ensureVersionSnapshot`)
 * owns its OWN transaction and commits before any caller pins the row —
 * the snapshot is idempotent per (version, content hash), and the
 * manifest-resolution reads must not hold a caller's wide publish lock.
 */
import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { ApiError } from '../../../common/http/api-error';
import type { AssistantPayload } from '../validation';
import { validateAssistantPayload } from '../validation';
import { ConfigPublishService } from '../../config-publish/config-publish.service';
import { resolveForPublishPg } from './pg-manifest-resolution';
import type { PolicySnapshot } from '../schema';
import { assistantVersions, POLICY_SNAPSHOT_SCHEMA_VERSION, policySnapshots } from '../schema';
import type { IPolicySnapshotRepository } from './policy-snapshot.repository';

@Injectable()
export class PgPolicySnapshotRepository implements IPolicySnapshotRepository {
  constructor(
    private readonly db: DbService,
    private readonly configPublish: ConfigPublishService,
  ) {}

  async getSnapshot(orgId: string, snapshotId: string): Promise<PolicySnapshot | null> {
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

  async synthesizeSnapshotForVersion(input: {
    orgId: string;
    assistantId: string;
    versionId: string;
  }): Promise<void> {
    await this.db.withOrg(input.orgId, async (tx) => {
      const versionRows = await tx
        .select()
        .from(assistantVersions)
        .where(
          and(
            eq(assistantVersions.id, input.versionId),
            eq(assistantVersions.organizationId, input.orgId),
          ),
        )
        .limit(1);
      const version = versionRows[0];
      if (!version || version.assistantId !== input.assistantId) {
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
            eq(policySnapshots.assistantVersionId, input.versionId),
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
      const manifest = await resolveForPublishPg(
        tx,
        { db: this.db, configPublish: this.configPublish },
        input.orgId,
        input.assistantId,
        validated.normalized,
      );
      const snapshotValues = {
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
}
