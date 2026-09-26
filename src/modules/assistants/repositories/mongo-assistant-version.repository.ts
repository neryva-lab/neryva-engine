/**
 * MongoDB `IAssistantVersionRepository` — the `assistant_versions`
 * aggregate on the mongo lane.
 *
 * Tenant discipline: every tenant-scoped access goes through
 * `TenantScopedCollection` (explicit `organization_id` predicates — there
 * is no RLS on this lane). UUIDs are BSON Binary subtype 4; timestamps
 * are ISO-8601 strings matching the pg lane's `mode: 'string'` columns.
 *
 * Serialization: `publishVersion` and `retireVersion` acquire the
 * `assistant:<id>` distributed lease BEFORE opening their `withOrg`
 * transaction and release it after commit/rollback (the lease replaces
 * `pg_advisory_xact_lock`; the key domain is identical). The lease TTL
 * (30s) bounds how long a crashed holder blocks the assistant; a stolen
 * lease mid-TX fails closed via the unique version index, never silently.
 *
 * The service keeps: input validation, the draft-status pre-checks, the
 * OCC miss classification (`updateDraftContent` returns null on miss),
 * audits, and logging.
 */
import { Injectable } from '@nestjs/common';
import type { Binary, ClientSession, Db } from 'mongodb';
import { env } from '../../../common/config/env';
import { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import {
  PlatformCollection,
  TenantScopedCollection,
} from '../../../common/infra/db/mongo/concurrency';
import { acquireLease } from '../../../common/infra/db/mongo/concurrency/lease-lock';
import { canonicalHash } from '../../../common/crypto/canonical-hash';
import { ApiError } from '../../../common/http/api-error';
import { uuidv7 } from '../../../common/ids/uuidv7';
import type { AssistantPayload } from '../validation';
import {
  decideBlockedContent,
  decideRequiredChecks,
  throwGateRefusal,
} from '../release-gate';
import {
  undercoveredPinSlugs,
  unresolvedPinSlugs,
} from '../manifest-resolution.service';
import type { AssistantVersion } from '../schema';
import type { IAssistantVersionRepository } from './assistant-version.repository';
import type { VersionPayloadValues } from './assistant.repository';
import { resolveForPublishMongo } from './mongo-manifest-resolution';
import {
  binToUuid,
  binUuid,
  draftExistsConflict,
  isDuplicateKeyError,
  nowIsoString,
  toAssistantVersion,
  uuidToBinary,
  type AssistantMongoDoc,
  type AssistantVersionMongoDoc,
  type PolicySnapshotMongoDoc,
} from './mongo-assistant-documents';

/** Must stay in sync with `POLICY_SNAPSHOT_SCHEMA_VERSION` in `../schema`. */
const POLICY_SNAPSHOT_SCHEMA_VERSION = 1;

const VERSION_LIST_CAP = 500;
/**
 * Lease TTL for the `assistant:<id>` distributed lock, read from the parsed
 * runtime configuration (`MONGODB_PUBLISH_LEASE_TTL_MS`, default 30s) at
 * each acquisition — read per call (never snapshotted at import) so it
 * always reflects the process configuration. Bounds how long a crashed
 * publish/retire holder blocks the assistant. Trade-off (see env.ts): too
 * low → a slow legitimate publish loses its lease mid-flight (fails closed
 * via the unique version index); too high → a crashed publisher holds the
 * lease longer before stale-lease recovery.
 */
const publishLeaseTtlMs = (): number => env.MONGODB_PUBLISH_LEASE_TTL_MS;
/** How long to wait for a contended assistant lock before failing. */
const ASSISTANT_LOCK_TIMEOUT_MS = 30_000;

/** Advisory-lock key domain, identical to the pg lane. */
function lockKey(assistantId: string): string {
  return `assistant:${assistantId}`;
}

// ── Minimal BSON shapes for the cross-domain reads in this file ──────────

interface EvalRunMongoDoc {
  id: unknown;
  assistant_version_id: Binary;
  decision: string | null;
  state: string;
  is_shadow: boolean;
  finished_at: string | null;
  started_at: string | null;
  provenance: { evaluated_content_hash?: string } | null;
}

interface RunMongoDoc {
  id: unknown;
  assistant_version_id: Binary;
  run_kind: string;
}

interface AssistantInstallMongoDoc {
  slug: string;
  template_version: string;
}

interface AssistantTemplateMongoDoc {
  release_policy: unknown;
}

@Injectable()
export class MongoAssistantVersionRepository implements IAssistantVersionRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private collections(db: Db) {
    return {
      assistants: new TenantScopedCollection<AssistantMongoDoc>(
        db.collection<AssistantMongoDoc>('assistants'),
      ),
      versions: new TenantScopedCollection<AssistantVersionMongoDoc>(
        db.collection<AssistantVersionMongoDoc>('assistant_versions'),
      ),
      snapshots: new TenantScopedCollection<PolicySnapshotMongoDoc>(
        db.collection<PolicySnapshotMongoDoc>('policy_snapshots'),
      ),
      evalRuns: new TenantScopedCollection<EvalRunMongoDoc>(
        db.collection<EvalRunMongoDoc>('eval_runs'),
      ),
      runs: new TenantScopedCollection<RunMongoDoc>(db.collection<RunMongoDoc>('runs')),
      installs: new TenantScopedCollection<AssistantInstallMongoDoc>(
        db.collection<AssistantInstallMongoDoc>('assistant_installs'),
      ),
      templates: new PlatformCollection<AssistantTemplateMongoDoc>(
        db.collection<AssistantTemplateMongoDoc>('assistant_templates'),
      ),
    };
  }

  private draftValuesDoc(
    orgId: string,
    assistantId: string,
    values: VersionPayloadValues,
  ): AssistantVersionMongoDoc {
    const now = nowIsoString();
    return {
      id: uuidToBinary(uuidv7()),
      assistant_id: binUuid(assistantId, 'assistantId'),
      organization_id: binUuid(orgId, 'orgId'),
      version: 0, // sentinel for DRAFT — publish assigns the monotonic version
      schema_version: 1,
      status: 'DRAFT',
      model_policy: values.modelPolicy,
      context_policy: values.contextPolicy,
      tool_policy: values.toolPolicy,
      knowledge_policy: values.knowledgePolicy ?? null,
      guardrail_policy: values.guardrailPolicy,
      instructions: values.instructions ?? null,
      model_params: values.modelParams ?? null,
      budget_policy: values.budgetPolicy ?? null,
      brand: values.brand ?? null,
      rollback_of: null,
      parent_version_id: values.parentVersionId ? binUuid(values.parentVersionId, 'parentVersionId') : null,
      hash: values.hash,
      published_at: null,
      published_by: null,
      retention_class: 'business-history',
      created_at: now,
      updated_at: now,
    };
  }

  async createDraftVersion(input: {
    orgId: string;
    assistantId: string;
    payloadValues: VersionPayloadValues;
  }): Promise<AssistantVersion> {
    const db = this.mongo.root;
    const { versions } = this.collections(db);
    // DRAFT is always a new row; version is assigned only on publish. The
    // (assistant_id, version=0) sentinel is unique — a second draft before
    // the first is published surfaces as a typed 409, never a raw 11000.
    const doc = this.draftValuesDoc(input.orgId, input.assistantId, input.payloadValues);
    try {
      await versions.insertOne(input.orgId, doc);
    } catch (err) {
      if (isDuplicateKeyError(err)) throw draftExistsConflict();
      throw err;
    }
    return toAssistantVersion(doc);
  }

  async updateDraftContent(input: {
    orgId: string;
    assistantId: string;
    versionId: string;
    expectedHash: string;
    payloadValues: VersionPayloadValues;
  }): Promise<AssistantVersion | null> {
    const db = this.mongo.root;
    const { versions } = this.collections(db);
    // Single-statement OCC: id + DRAFT status + expected hash. A miss
    // returns null — the service classifies it (404 / 409-not-draft /
    // 412-stale) via getVersion + draftWriteMissError.
    const updated = await versions.findOneAndUpdate(
      input.orgId,
      {
        id: binUuid(input.versionId, 'versionId'),
        assistant_id: binUuid(input.assistantId, 'assistantId'),
        status: 'DRAFT',
        hash: input.expectedHash,
      },
      {
        $set: {
          model_policy: input.payloadValues.modelPolicy,
          context_policy: input.payloadValues.contextPolicy,
          tool_policy: input.payloadValues.toolPolicy,
          knowledge_policy: input.payloadValues.knowledgePolicy ?? null,
          guardrail_policy: input.payloadValues.guardrailPolicy,
          instructions: input.payloadValues.instructions ?? null,
          model_params: input.payloadValues.modelParams ?? null,
          budget_policy: input.payloadValues.budgetPolicy ?? null,
          brand: input.payloadValues.brand ?? null,
          parent_version_id: input.payloadValues.parentVersionId
            ? binUuid(input.payloadValues.parentVersionId, 'parentVersionId')
            : null,
          hash: input.payloadValues.hash,
          updated_at: nowIsoString(),
        },
      },
      { returnDocument: 'after' },
    );
    return updated ? toAssistantVersion(updated) : null;
  }

  async discardDraftVersion(input: {
    orgId: string;
    assistantId: string;
    versionId: string;
  }): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withOrg(input.orgId, async (ctx: MongoTxContext) => {
      const { versions, evalRuns, runs } = this.collections(db);
      const session = { session: ctx.session };
      const versionBin = binUuid(input.versionId, 'versionId');
      const evalProbe = await evalRuns.findOne(
        input.orgId,
        { assistant_version_id: versionBin },
        { ...session, projection: { id: 1 } },
      );
      if (evalProbe) {
        throw ApiError.conflict(
          'draft cannot be discarded: it has evaluation runs (durable release provenance)',
          { assistant_version_id: input.versionId, eval_run_id: binToUuid(evalProbe.id as Binary) },
        );
      }
      const nonTestProbe = await runs.findOne(
        input.orgId,
        { assistant_version_id: versionBin, run_kind: { $ne: 'test' } },
        { ...session, projection: { id: 1 } },
      );
      if (nonTestProbe) {
        throw ApiError.conflict(
          'draft cannot be discarded: non-test runs are pinned to this version',
          { assistant_version_id: input.versionId, run_id: binToUuid(nonTestProbe.id as Binary) },
        );
      }
      // A2-21: the builder's Try console leaves test runs pinned to the
      // draft; delete them here (same TX) instead of failing. The pg lane
      // relies on migration-declared FK cascades — the mongo lane has none,
      // so the cascade set is deleted explicitly.
      const testRuns = await runs
        .find(input.orgId, { assistant_version_id: versionBin }, { ...session, projection: { id: 1 } })
        .toArray();
      const testRunIds = testRuns.map((r) => r.id as Binary);
      if (testRunIds.length > 0) {
        const runIdFilter = { run_id: { $in: testRunIds } };
        for (const name of [
          'run_events',
          'approvals',
          'tool_effects',
          'checkpoints',
          'memory_proposals',
          'run_manifests',
          'run_judgments',
        ]) {
          await new TenantScopedCollection(db.collection(name)).deleteMany(
            input.orgId,
            runIdFilter,
            session,
          );
        }
        // Escalations are SET NULL on the pg lane — same here.
        await new TenantScopedCollection(db.collection('escalations')).updateMany(
          input.orgId,
          { run_id: { $in: testRunIds } },
          { $set: { run_id: null } },
          session,
        );
        await runs.deleteMany(input.orgId, { id: { $in: testRunIds } }, session);
      }
      await versions.deleteOne(input.orgId, { id: versionBin }, session);
    });
  }

  async getVersion(orgId: string, versionId: string): Promise<AssistantVersion | null> {
    const db = this.mongo.root;
    const { versions } = this.collections(db);
    const doc = await versions.findOne(orgId, { id: binUuid(versionId, 'versionId') });
    return doc ? toAssistantVersion(doc) : null;
  }

  async listVersions(orgId: string, assistantId: string): Promise<AssistantVersion[]> {
    const db = this.mongo.root;
    const { versions } = this.collections(db);
    const docs = await versions
      .find(
        orgId,
        { assistant_id: binUuid(assistantId, 'assistantId') },
        { sort: { version: -1, created_at: -1 }, limit: VERSION_LIST_CAP },
      )
      .toArray();
    return docs.map(toAssistantVersion);
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
    const db = this.mongo.root;
    // Serialize against publish/retire/rollback on this assistant — the
    // lease is acquired BEFORE the transaction and released after
    // commit/rollback (lease-lock.ts: "a transaction-scoped advisory lock
    // maps to acquire before the TX, release after commit, owned by the
    // caller").
    const lease = await acquireLease(db, lockKey(input.assistantId), publishLeaseTtlMs(), {
      timeoutMs: ASSISTANT_LOCK_TIMEOUT_MS,
    });
    try {
      return await this.mongo.withOrg(input.orgId, async (ctx: MongoTxContext) => {
        const { assistants, versions, snapshots } = this.collections(db);
        const session = { session: ctx.session };
        const assistant = await assistants.findOne(
          input.orgId,
          { id: binUuid(input.assistantId, 'assistantId') },
          session,
        );
        if (!assistant) {
          throw ApiError.notFound('assistant');
        }
        // The caller's `version` is advisory: the next version number is
        // computed inside this lock (no TOCTOU against concurrent publishes
        // of this assistant).
        const maxRow = await versions.findOne(
          input.orgId,
          { assistant_id: binUuid(input.assistantId, 'assistantId'), version: { $gt: 0 } },
          { ...session, sort: { version: -1 }, projection: { version: 1 } },
        );
        const nextVersion = (maxRow?.version ?? 0) + 1;

        const hash = canonicalHash(input.normalized);
        // P4: manifest resolves BEFORE the no-op guard — the guard compares
        // RESOLVED SETS, not content (see the pg implementation's comment).
        const manifest = await resolveForPublishMongo(
          db,
          ctx.session,
          input.orgId,
          input.assistantId,
          input.normalized,
        );
        await this.rejectNoOpPublish(db, session, input.orgId, input.assistantId, hash, manifest.manifestHash);
        await this.rejectGateRefusal(db, session, input.orgId, input.assistantId, hash);
        // Degraded-knowledge gate (same message contract as the pg lane).
        const degraded = unresolvedPinSlugs({ knowledgePins: manifest.knowledgePins });
        const undercovered = undercoveredPinSlugs({ knowledgePins: manifest.knowledgePins });
        if (
          (degraded.length > 0 || undercovered.length > 0) &&
          !input.acknowledgeDegradedKnowledge
        ) {
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

        const now = nowIsoString();
        const versionDoc: AssistantVersionMongoDoc = {
          id: uuidToBinary(uuidv7()),
          assistant_id: binUuid(input.assistantId, 'assistantId'),
          organization_id: binUuid(input.orgId, 'orgId'),
          version: nextVersion,
          schema_version: input.schemaVersion,
          status: 'PUBLISHED',
          model_policy: input.normalized.model_policy,
          context_policy: input.normalized.context_policy,
          tool_policy: input.normalized.tool_policy,
          knowledge_policy: input.normalized.knowledge_policy ?? null,
          guardrail_policy: input.normalized.guardrail_policy,
          instructions: input.normalized.instructions ?? null,
          model_params: input.normalized.model_params ?? null,
          budget_policy: input.normalized.budget_policy ?? null,
          brand: input.normalized.brand ?? null,
          rollback_of: input.rollbackOf ? binUuid(input.rollbackOf, 'rollbackOf') : null,
          parent_version_id: input.parentVersionId
            ? binUuid(input.parentVersionId, 'parentVersionId')
            : null,
          hash,
          published_at: now,
          published_by: input.publishedBy,
          retention_class: 'business-history',
          created_at: now,
          updated_at: now,
        };
        try {
          await versions.insertOne(input.orgId, versionDoc, session);
        } catch (err) {
          // A stolen lease mid-TX is the only way here: the unique
          // (assistant_id, version) index turns the race into a typed 409,
          // never a silent duplicate version number.
          if (isDuplicateKeyError(err)) {
            throw ApiError.conflict('assistant version was published concurrently', {
              assistant_id: input.assistantId,
            });
          }
          throw err;
        }

        // Snapshot materialized in the same TX as publish — the pinning
        // authority runs reference, carrying the fully resolved set.
        const snapshotDoc: PolicySnapshotMongoDoc = {
          id: uuidToBinary(uuidv7()),
          organization_id: binUuid(input.orgId, 'orgId'),
          assistant_version_id: versionDoc.id,
          snapshot_version: POLICY_SNAPSHOT_SCHEMA_VERSION,
          model_policy: input.normalized.model_policy,
          context_policy: input.normalized.context_policy,
          tool_policy: input.normalized.tool_policy,
          guardrail_policy: input.normalized.guardrail_policy,
          knowledge_policy: input.normalized.knowledge_policy ?? null,
          instructions: input.normalized.instructions ?? null,
          model_params: input.normalized.model_params ?? null,
          budget_policy: input.normalized.budget_policy ?? null,
          brand: input.normalized.brand ?? null,
          hash,
          tool_bindings: manifest.toolBindings,
          knowledge_pins: manifest.knowledgePins,
          model_ref: manifest.modelRef,
          template_ref: manifest.templateRef,
          manifest_hash: manifest.manifestHash,
          created_at: now,
        };
        await snapshots.insertOne(input.orgId, snapshotDoc, session);

        // P5 (degraded lifecycle): a publish that WAIVED degraded pins
        // starts a 7-day clock instead of a silent waiver; a healthy publish
        // clears it.
        const waived = degraded.length > 0 || undercovered.length > 0;
        const waivedSlugs = [
          ...degraded.map((s) => `unresolved:${s}`),
          ...undercovered.map((p) => `${p.slug}:${p.embedded}/${p.total}`),
        ];
        await assistants.updateOne(
          input.orgId,
          { id: binUuid(input.assistantId, 'assistantId') },
          {
            $set: waived
              ? {
                  active_version_id: versionDoc.id,
                  degraded_until: nowIsoString(new Date(Date.now() + 7 * 86_400_000)),
                  degraded_reason: waivedSlugs.join('; ').slice(0, 512),
                  degraded_alerted_at: null,
                  updated_at: now,
                }
              : {
                  active_version_id: versionDoc.id,
                  degraded_until: null,
                  degraded_reason: null,
                  degraded_alerted_at: null,
                  updated_at: now,
                },
          },
          session,
        );
        return toAssistantVersion(versionDoc);
      });
    } finally {
      await lease.release();
    }
  }

  async retireVersion(
    orgId: string,
    assistantId: string,
    versionId: string,
  ): Promise<AssistantVersion> {
    const db = this.mongo.root;
    // Serialize against publish/rollback (same lock domain) so a concurrent
    // publish cannot re-activate the version mid-retire.
    const lease = await acquireLease(db, lockKey(assistantId), publishLeaseTtlMs(), {
      timeoutMs: ASSISTANT_LOCK_TIMEOUT_MS,
    });
    try {
      return await this.mongo.withOrg(orgId, async (ctx: MongoTxContext) => {
        const { assistants, versions } = this.collections(db);
        const session = { session: ctx.session };
        const versionBin = binUuid(versionId, 'versionId');
        const version = await versions.findOne(orgId, { id: versionBin }, session);
        if (!version) {
          throw ApiError.notFound('assistant version');
        }
        const assistant = await assistants.findOne(
          orgId,
          { id: binUuid(assistantId, 'assistantId') },
          { ...session, projection: { active_version_id: 1 } },
        );
        if (
          assistant?.active_version_id &&
          (assistant.active_version_id as Binary).toUUID().toString() === versionId
        ) {
          // The active pointer must never reference a RETIRED version —
          // runs started after retire would pin a version the org has
          // withdrawn. Withdraw by publishing/rolling back to a successor
          // first.
          throw ApiError.conflict(
            'cannot retire the active version — publish or roll back to a successor first',
            { assistant_id: assistantId, version_id: versionId },
          );
        }
        // Conditional PUBLISHED→RETIRED flip — the status predicate is the
        // fence; a lost race surfaces as a typed 409, never a silent
        // overwrite.
        const updated = await versions.findOneAndUpdate(
          orgId,
          { id: versionBin, status: 'PUBLISHED' },
          { $set: { status: 'RETIRED', updated_at: nowIsoString() } },
          { ...session, returnDocument: 'after' },
        );
        if (!updated) {
          throw ApiError.conflict('assistant version was retired concurrently');
        }
        return toAssistantVersion(updated);
      });
    } finally {
      await lease.release();
    }
  }

  /**
   * Publish/rollback that would change NOTHING is a no-op — rejected as a
   * conflict. Compared on content hash AND resolved-set hash jointly (same
   * rules as the pg lane: only the active pointer is compared, so restoring
   * a payload that exists on a non-active PUBLISHED row stays legitimate).
   */
  private async rejectNoOpPublish(
    db: Db,
    session: { session: ClientSession },
    orgId: string,
    assistantId: string,
    hash: string,
    manifestHash: string | null,
  ): Promise<void> {
    const { assistants, versions, snapshots } = this.collections(db);
    const assistant = await assistants.findOne(
      orgId,
      { id: binUuid(assistantId, 'assistantId') },
      { ...session, projection: { active_version_id: 1 } },
    );
    const activeId = assistant?.active_version_id as Binary | null;
    if (!activeId) {
      return;
    }
    const active = await versions.findOne(
      orgId,
      { id: activeId },
      { ...session, projection: { hash: 1 } },
    );
    if (!active || active.hash !== hash) {
      return;
    }
    const snapshot = await snapshots.findOne(
      orgId,
      { assistant_version_id: activeId, hash },
      { ...session, projection: { manifest_hash: 1 } },
    );
    const activeManifestHash = snapshot?.manifest_hash ?? null;
    if (activeManifestHash === null || manifestHash === null) {
      throw ApiError.conflict('assistant active version already carries this payload', {
        assistant_id: assistantId,
      });
    }
    if (activeManifestHash === manifestHash) {
      throw ApiError.conflict(
        'assistant active version already carries this payload and resolved set',
        { assistant_id: assistantId },
      );
    }
  }

  /**
   * BLOCK gate (TPL-6.1) + required-checks gate (REL-3.2) against the
   * mongo lane's session reads. The decision lookup is keyed by CONTENT
   * hash against the latest completed non-shadow decision for this
   * assistant's versions (the pg lane's join, expressed as an
   * `$in` over the assistant's version ids). Precedence lives in the
   * shared pure decision functions.
   */
  private async rejectGateRefusal(
    db: Db,
    session: { session: ClientSession },
    orgId: string,
    assistantId: string,
    hash: string,
  ): Promise<void> {
    const { versions, evalRuns, installs, templates } = this.collections(db);
    const assistantBin = binUuid(assistantId, 'assistantId');
    const versionIds = (
      await versions
        .find(orgId, { assistant_id: assistantBin }, { ...session, projection: { id: 1 } })
        .toArray()
    ).map((v) => v.id);

    let required: string[] = [];
    const install = await installs.findOne(orgId, { assistant_id: assistantBin }, session);
    if (install) {
      const template = await templates.findOne(
        { slug: install.slug, version: install.template_version },
        session,
      );
      const raw = template?.release_policy;
      const policy: { required?: unknown } | null =
        typeof raw === 'string'
          ? (() => {
              try {
                return JSON.parse(raw) as { required?: unknown };
              } catch {
                return null;
              }
            })()
          : ((raw as { required?: unknown } | undefined) ?? null);
      required = Array.isArray(policy?.required)
        ? (policy.required as unknown[]).filter((c): c is string => typeof c === 'string')
        : [];
    }

    let decision: string | null = null;
    if (versionIds.length > 0) {
      const latest = await evalRuns.findOne(
        orgId,
        {
          assistant_version_id: { $in: versionIds },
          'provenance.evaluated_content_hash': hash,
          state: 'completed',
          decision: { $ne: null },
          is_shadow: false,
        },
        { ...session, sort: { finished_at: -1, started_at: -1 } },
      );
      decision = latest?.decision ?? null;
    }

    const refusal = decideBlockedContent(decision) ?? decideRequiredChecks(required, decision);
    if (refusal && refusal.gate === 'blocked_content') {
      throwGateRefusal(refusal, assistantId);
    }
    if (refusal) {
      throwGateRefusal(refusal, assistantId);
    }
  }
}
