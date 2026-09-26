/**
 * PostgreSQL `IAssistantVersionRepository` — the `assistant_versions`
 * aggregate.
 *
 * Transaction ownership: `createDraftVersion`, `updateDraftContent`,
 * `discardDraftVersion`, `publishVersion`, and `retireVersion` each own
 * their `withOrg` unit of work. `publishVersion` is the extracted
 * `insertPublishedVersion` commit: advisory-lock serialization
 * (`assistant:<id>`), in-TX manifest resolution, the no-op guard, the
 * BLOCK + required-checks gates (via the module's `evaluatePublishGate`
 * row readers, whose pure decision functions are shared), the
 * degraded-knowledge gate, the PUBLISHED row insert, the policy-snapshot
 * insert of the resolved set, and the active-pointer move with degraded
 * columns — all in one commit. Rollback flows through the same commit
 * with `rollbackOf`/`parentVersionId` set (the service's rollback
 * pre-checks stay in the service).
 *
 * The service keeps: input validation, the draft-status pre-checks, the
 * OCC miss classification (`updateDraftContent` returns null on miss),
 * audits, and logging.
 */
import { Injectable } from '@nestjs/common';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DbService } from '../../../common/infra/db/db.service';
import { canonicalHash } from '../../../common/crypto/canonical-hash';
import { ApiError } from '../../../common/http/api-error';
import { evalRuns } from '../../knowledge/eval.schema';
import { runs } from '../../conversations/schema';
import type { AssistantPayload } from '../validation';
import { evaluatePublishGate, throwGateRefusal } from '../release-gate';
import { ConfigPublishService } from '../../config-publish/config-publish.service';
import {
  undercoveredPinSlugs,
  unresolvedPinSlugs,
} from '../manifest-resolution.service';
import { resolveForPublishPg } from './pg-manifest-resolution';
import type { AssistantVersion } from '../schema';
import {
  assistants,
  assistantVersions,
  POLICY_SNAPSHOT_SCHEMA_VERSION,
  policySnapshots,
} from '../schema';
import type {
  IAssistantVersionRepository,
} from './assistant-version.repository';
import type { VersionPayloadValues } from './assistant.repository';
import { mapAssistantUniqueViolation } from './pg-assistant.repository';

const VERSION_LIST_CAP = 500;

/** Advisory-lock key domain, byte-identical to the pre-extraction service. */
function advisoryLockKey(assistantId: string): string {
  return `assistant:${assistantId}`;
}

@Injectable()
export class PgAssistantVersionRepository implements IAssistantVersionRepository {
  constructor(
    private readonly db: DbService,
    private readonly configPublish: ConfigPublishService,
  ) {}

  async createDraftVersion(input: {
    orgId: string;
    assistantId: string;
    payloadValues: VersionPayloadValues;
  }): Promise<AssistantVersion> {
    // DRAFT is always a new row; version is assigned only on publish. The
    // (assistant_id, version=0) sentinel is unique — a second draft before
    // the first is published surfaces as a typed 409, never a raw 23505.
    try {
      const rows = await this.db.withOrg(input.orgId, (tx) =>
        tx
          .insert(assistantVersions)
          .values({
            assistantId: input.assistantId,
            organizationId: input.orgId,
            version: 0, // sentinel for DRAFT — publish assigns monotonic version
            status: 'DRAFT',
            modelPolicy: input.payloadValues.modelPolicy,
            contextPolicy: input.payloadValues.contextPolicy,
            toolPolicy: input.payloadValues.toolPolicy,
            knowledgePolicy: input.payloadValues.knowledgePolicy ?? null,
            guardrailPolicy: input.payloadValues.guardrailPolicy,
            instructions: input.payloadValues.instructions ?? null,
            modelParams: input.payloadValues.modelParams ?? null,
            budgetPolicy: input.payloadValues.budgetPolicy ?? null,
            brand: input.payloadValues.brand ?? null,
            parentVersionId: input.payloadValues.parentVersionId ?? null,
            hash: input.payloadValues.hash,
          })
          .returning(),
      );
      return rows[0];
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw mapAssistantUniqueViolation(err, '');
    }
  }

  async updateDraftContent(input: {
    orgId: string;
    assistantId: string;
    versionId: string;
    expectedHash: string;
    payloadValues: VersionPayloadValues;
  }): Promise<AssistantVersion | null> {
    // Single-statement OCC: id + DRAFT status + expected hash. A miss
    // returns null — the service classifies it (404 / 409-not-draft /
    // 412-stale) via getVersion + draftWriteMissError.
    const rows = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .update(assistantVersions)
        .set({
          modelPolicy: input.payloadValues.modelPolicy,
          contextPolicy: input.payloadValues.contextPolicy,
          toolPolicy: input.payloadValues.toolPolicy,
          knowledgePolicy: input.payloadValues.knowledgePolicy ?? null,
          guardrailPolicy: input.payloadValues.guardrailPolicy,
          instructions: input.payloadValues.instructions ?? null,
          modelParams: input.payloadValues.modelParams ?? null,
          budgetPolicy: input.payloadValues.budgetPolicy ?? null,
          brand: input.payloadValues.brand ?? null,
          parentVersionId: input.payloadValues.parentVersionId ?? null,
          hash: input.payloadValues.hash,
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
    return rows[0] ?? null;
  }

  async discardDraftVersion(input: {
    orgId: string;
    assistantId: string;
    versionId: string;
  }): Promise<void> {
    await this.db.withOrg(input.orgId, async (tx) => {
      const evalProbe = await tx
        .select({ id: evalRuns.id })
        .from(evalRuns)
        .where(
          and(
            eq(evalRuns.organizationId, input.orgId),
            eq(evalRuns.assistantVersionId, input.versionId),
          ),
        )
        .limit(1);
      if (evalProbe.length > 0) {
        throw ApiError.conflict(
          'draft cannot be discarded: it has evaluation runs (durable release provenance)',
          { assistant_version_id: input.versionId, eval_run_id: evalProbe[0].id },
        );
      }
      const nonTestProbe = await tx
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            eq(runs.organizationId, input.orgId),
            eq(runs.assistantVersionId, input.versionId),
            ne(runs.runKind, 'test'),
          ),
        )
        .limit(1);
      if (nonTestProbe.length > 0) {
        throw ApiError.conflict('draft cannot be discarded: non-test runs are pinned to this version', {
          assistant_version_id: input.versionId,
          run_id: nonTestProbe[0].id,
        });
      }
      // A2-21: the builder's Try console leaves test runs pinned to the
      // draft; delete them here (same TX) instead of letting the FK explode
      // into a 500. Migration-declared cascades clean run_events /
      // approvals / tool_effects / checkpoints / memory_proposals /
      // run_manifests / run_judgments (escalations SET NULL).
      await tx
        .delete(runs)
        .where(and(eq(runs.organizationId, input.orgId), eq(runs.assistantVersionId, input.versionId)));
      await tx.delete(assistantVersions).where(eq(assistantVersions.id, input.versionId));
    });
  }

  async getVersion(orgId: string, versionId: string): Promise<AssistantVersion | null> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx.select().from(assistantVersions).where(eq(assistantVersions.id, versionId)).limit(1),
    );
    return rows[0] ?? null;
  }

  async listVersions(orgId: string, assistantId: string): Promise<AssistantVersion[]> {
    return this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(assistantVersions)
        .where(eq(assistantVersions.assistantId, assistantId))
        .orderBy(desc(assistantVersions.version), desc(assistantVersions.createdAt))
        .limit(VERSION_LIST_CAP),
    );
  }

  async publishVersion(input: {
    orgId: string;
    assistantId: string;
    version: number;
    schemaVersion: number;
    normalized: AssistantPayload;
    publishedBy: string;
    rollbackOf: string | null;
    parentVersionId: string | null;
    acknowledgeDegradedKnowledge: boolean;
  }): Promise<AssistantVersion> {
    return this.db.withOrg(input.orgId, async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${advisoryLockKey(input.assistantId)}))`,
      );
      // The caller's `version` is advisory: the next version number is
      // computed inside this lock (no TOCTOU against concurrent publishes
      // of this assistant).
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
        schemaVersion: input.schemaVersion,
        normalized: input.normalized,
        publishedBy: input.publishedBy,
        rollbackOf: input.rollbackOf,
        parentVersionId: input.parentVersionId,
        acknowledgeDegradedKnowledge: input.acknowledgeDegradedKnowledge,
      });
    });
  }

  async retireVersion(
    orgId: string,
    assistantId: string,
    versionId: string,
  ): Promise<AssistantVersion> {
    // Serialize against publish/rollback (same advisory lock domain) so a
    // concurrent publish cannot re-activate the version mid-retire, and a
    // concurrent rollback cannot point `active_version_id` at the retiring row.
    return this.db.withOrg(orgId, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${advisoryLockKey(assistantId)}))`);
      const active = await tx
        .select({ activeVersionId: assistants.activeVersionId })
        .from(assistants)
        .where(eq(assistants.id, assistantId))
        .limit(1);
      if (active[0]?.activeVersionId === versionId) {
        // The active pointer must never reference a RETIRED version — runs
        // started after retire would pin a version the org has withdrawn.
        // Withdraw by publishing/rolling back to a successor first.
        throw ApiError.conflict(
          'cannot retire the active version — publish or roll back to a successor first',
          {
            assistant_id: assistantId,
            version_id: versionId,
          },
        );
      }
      const rows = await tx
        .update(assistantVersions)
        .set({ status: 'RETIRED', updatedAt: new Date().toISOString() })
        .where(and(eq(assistantVersions.id, versionId), eq(assistantVersions.status, 'PUBLISHED')))
        .returning();
      if (rows.length === 0) {
        throw ApiError.conflict('assistant version was retired concurrently');
      }
      return rows[0];
    });
  }

  /**
   * Shared publish/rollback commit — version row + resolved snapshot +
   * active pointer in ONE transaction (caller holds the advisory lock).
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
      parentVersionId: string | null;
      acknowledgeDegradedKnowledge: boolean;
    },
  ): Promise<AssistantVersion> {
    const hash = canonicalHash(input.normalized);
    // P4: manifest resolves BEFORE the no-op guard — the guard compares
    // RESOLVED SETS, not content. Identical content over a drifted catalog
    // (perimeter, pins, model refs) is a legitimate re-publish (re-pin),
    // not a no-op. Eval gates below stay content-hash keyed (decisions judge
    // content, and a bad payload must not re-enter under a fresh manifest).
    const manifest = await resolveForPublishPg(
      tx,
      { db: this.db, configPublish: this.configPublish },
      input.orgId,
      input.assistantId,
      input.normalized,
    );
    await this.rejectNoOpPublish(tx, input.assistantId, hash, manifest.manifestHash);
    await this.rejectGateRefusal(tx, input.orgId, input.assistantId, hash);
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

  /**
   * BLOCK gate (TPL-6.1) + required-checks gate (REL-3.2) via the module's
   * shared `evaluatePublishGate`. Precedence is load-bearing (BLOCK wins
   * over missing-PASS) and lives in that function. The pre-extraction
   * service evaluated the gate twice (once per rule); a single evaluation
   * inside this TX snapshot is observably identical — both rules read the
   * same rows, and the single read is snapshot-consistent.
   */
  private async rejectGateRefusal(
    tx: NodePgDatabase,
    orgId: string,
    assistantId: string,
    hash: string,
  ): Promise<void> {
    const refusal = await evaluatePublishGate(tx, orgId, assistantId, hash);
    if (refusal) {
      throwGateRefusal(refusal, assistantId);
    }
  }
}
