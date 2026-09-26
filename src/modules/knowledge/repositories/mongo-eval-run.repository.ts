/**
 * MongoDB implementation of the eval-run repository port (P3) — the eval
 * run lifecycle.
 *
 * `createWithOutboxEvent` co-commits the run and its transactional-outbox
 * event (invariant 7: the outbox row is written in the SAME transaction as
 * the fact it announces). The outbox writer itself is common infra; this
 * port only guarantees the co-commit.
 */
import { Binary } from 'mongodb';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { TenantScopedCollection } from '../../../common/infra/db/mongo/concurrency/tenant-guard';
import type {
  EvalCaseExecutionMongoDoc,
  EvalCaseMongoDoc,
  EvalRunMongoDoc,
  OutboxEventMongoDoc,
} from './mongo-documents';
import type {
  EvalCaseContent,
  EvalRunCompletion,
  EvalRunRow,
  NewEvalRun,
  OutboxEventDraft,
} from './repository-types';
import type { IEvalRunRepository } from './eval-run.repository';
import {
  binUuid,
  ensureKnowledgeIndexes,
  newId,
  nowIso,
  sessionOf,
  toIso,
  uuidOf,
} from './mongo-knowledge-shared';

const EVAL_RUNS = 'eval_runs';
const EVAL_CASES = 'eval_cases';
const EVAL_CASE_EXECUTIONS = 'eval_case_executions';
const OUTBOX_EVENTS = 'outbox_events';
/** Cross-module reads (documented in the interface). */
const RUNS = 'runs';
const POLICY_SNAPSHOTS = 'policy_snapshots';

interface ConversationRunMongoDoc {
  id: Binary;
  organization_id: Binary;
  policy_snapshot_id: Binary | null;
}

interface PolicySnapshotMongoDoc {
  id: Binary;
  hash: string;
}

function toEvalRunRow(doc: EvalRunMongoDoc, orgId: string): EvalRunRow {
  return {
    id: uuidOf(doc.id),
    organizationId: orgId,
    datasetId: uuidOf(doc.dataset_id),
    assistantVersionId: uuidOf(doc.assistant_version_id),
    state: doc.state,
    attemptsPerCase: doc.attempts_per_case,
    results: doc.results as EvalRunRow['results'],
    score: doc.score,
    startedBy: doc.started_by,
    startedAt: doc.started_at,
    finishedAt: doc.finished_at,
    provenance: doc.provenance as EvalRunRow['provenance'],
    decision: doc.decision,
    releasePolicyVersion: doc.release_policy_version,
    isShadow: doc.is_shadow,
    policySnapshotId: doc.policy_snapshot_id ? uuidOf(doc.policy_snapshot_id) : null,
  };
}

export class MongoEvalRunRepository implements IEvalRunRepository {
  constructor(private readonly mongo: MongoDbService) {}

  async createWithOutboxEvent(
    orgId: string,
    run: NewEvalRun,
    event: OutboxEventDraft,
  ): Promise<EvalRunRow> {
    const db = this.mongo.root;
    await ensureKnowledgeIndexes(db);
    return this.mongo.withOrg(orgId, async (ctx) => {
      const runs = new TenantScopedCollection<EvalRunMongoDoc>(db.collection(EVAL_RUNS));
      const outbox = new TenantScopedCollection<OutboxEventMongoDoc>(db.collection(OUTBOX_EVENTS));
      const s = sessionOf(ctx);
      const now = nowIso();
      const runDoc: EvalRunMongoDoc = {
        id: binUuid(run.id ?? newId(), 'run.id'),
        organization_id: binUuid(orgId, 'orgId'),
        dataset_id: binUuid(run.datasetId, 'run.datasetId'),
        assistant_version_id: binUuid(run.assistantVersionId, 'run.assistantVersionId'),
        state: run.state ?? 'pending',
        attempts_per_case: run.attemptsPerCase ?? 1,
        results: run.results ?? null,
        score: run.score ?? null,
        started_by: run.startedBy,
        started_at: run.startedAt == null ? now : toIso(run.startedAt),
        finished_at: run.finishedAt == null ? null : toIso(run.finishedAt),
        provenance: run.provenance ?? null,
        decision: run.decision ?? null,
        release_policy_version: run.releasePolicyVersion ?? null,
        is_shadow: run.isShadow ?? false,
        policy_snapshot_id:
          run.policySnapshotId == null ? null : binUuid(run.policySnapshotId, 'run.policySnapshotId'),
      };
      await runs.insertOne(orgId, runDoc, s);
      // Transactional outbox — the event commits with the run (invariant 7).
      const eventDoc: OutboxEventMongoDoc = {
        event_id: binUuid(newId()),
        organization_id: binUuid(orgId, 'orgId'),
        aggregate_type: event.aggregateType,
        aggregate_id: binUuid(event.aggregateId, 'event.aggregateId'),
        event_type: event.eventType,
        event_version: event.eventVersion ?? 1,
        payload: event.payload ?? null,
        partition_key: event.partitionKey,
        status: 'PENDING',
        attempt_count: 0,
        next_attempt_at: now,
        trace_id: event.traceId ?? null,
        correlation_id: event.correlationId == null ? null : binUuid(event.correlationId, 'event.correlationId'),
        created_at: now,
        published_at: null,
        claimed_at: null,
        // pg caps last_error at varchar(4096) — the slice keeps the insert
        // from ever diverging on oversized payloads (mirrors the connector
        // account's error recording).
        last_error: event.lastError == null ? null : event.lastError.slice(0, 4096),
      };
      await outbox.insertOne(orgId, eventDoc, s);
      return toEvalRunRow(runDoc, orgId);
    });
  }

  async findById(orgId: string, runId: string): Promise<EvalRunRow | null> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const runs = new TenantScopedCollection<EvalRunMongoDoc>(db.collection(EVAL_RUNS));
      const doc = await runs.findOne(
        orgId,
        { id: binUuid(runId, 'runId') },
        sessionOf(ctx),
      );
      return doc ? toEvalRunRow(doc, orgId) : null;
    });
  }

  async list(orgId: string, opts: { datasetId?: string; limit: number }): Promise<EvalRunRow[]> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const runs = new TenantScopedCollection<EvalRunMongoDoc>(db.collection(EVAL_RUNS));
      const filter: Record<string, unknown> = {};
      if (opts.datasetId !== undefined) {
        filter.dataset_id = binUuid(opts.datasetId, 'datasetId');
      }
      const docs = await runs
        .find(orgId, filter, {
          ...sessionOf(ctx),
          sort: { started_at: -1 },
          limit: Math.max(opts.limit, 0),
        })
        .toArray();
      return docs.map((d) => toEvalRunRow(d, orgId));
    });
  }

  async hasRecentShadowRun(orgId: string, versionId: string, withinHours: number): Promise<boolean> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const runs = new TenantScopedCollection<EvalRunMongoDoc>(db.collection(EVAL_RUNS));
      const since = new Date(Date.now() - withinHours * 3600 * 1000).toISOString();
      const count = await runs.countDocuments(
        orgId,
        {
          assistant_version_id: binUuid(versionId, 'versionId'),
          is_shadow: true,
          started_at: { $gt: since },
        },
        { ...sessionOf(ctx), limit: 1 },
      );
      return count > 0;
    });
  }

  async listExecutedContentHashes(orgId: string, evalRunId: string): Promise<string[]> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      // DELIBERATE cross-module join (documented in the interface):
      // eval_case_executions ⨝ runs ⨝ policy_snapshots — the hash-
      // verification query the publish gate depends on.
      const executions = new TenantScopedCollection<EvalCaseExecutionMongoDoc>(
        db.collection(EVAL_CASE_EXECUTIONS),
      );
      const conversationRuns = new TenantScopedCollection<ConversationRunMongoDoc>(
        db.collection(RUNS),
      );
      const snapshots = new TenantScopedCollection<PolicySnapshotMongoDoc>(
        db.collection(POLICY_SNAPSHOTS),
      );
      const s = sessionOf(ctx);
      const runIds = (
        await executions
          .find(
            orgId,
            { eval_run_id: binUuid(evalRunId, 'evalRunId'), run_id: { $ne: null } },
            { ...s, projection: { run_id: 1 } },
          )
          .toArray()
      ).map((e) => e.run_id as Binary);
      if (runIds.length === 0) return [];
      const snapshotIds = (
        await conversationRuns
          .find(
            orgId,
            { id: { $in: runIds }, policy_snapshot_id: { $ne: null } },
            { ...s, projection: { policy_snapshot_id: 1 } },
          )
          .toArray()
      ).map((r) => r.policy_snapshot_id as Binary);
      if (snapshotIds.length === 0) return [];
      const hashes = (
        await snapshots
          .find(orgId, { id: { $in: snapshotIds } }, { ...s, projection: { hash: 1 } })
          .toArray()
      ).map((p) => p.hash);
      return [...new Set(hashes)];
    });
  }

  async completeIfOpen(
    orgId: string,
    runId: string,
    completion: EvalRunCompletion,
  ): Promise<EvalRunRow | null> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const runs = new TenantScopedCollection<EvalRunMongoDoc>(db.collection(EVAL_RUNS));
      // Compare-and-set terminal completion — the state fence makes the
      // consumer's duplicate delivery a null (not an error).
      const doc = await runs.findOneAndUpdate(
        orgId,
        { id: binUuid(runId, 'runId'), state: { $in: ['pending', 'running'] } },
        {
          $set: {
            state: completion.state,
            results: completion.results,
            score: completion.score,
            provenance: completion.provenance ?? null,
            decision: completion.decision,
            release_policy_version: completion.releasePolicyVersion,
            finished_at: toIso(completion.finishedAt),
          },
        },
        { ...sessionOf(ctx), returnDocument: 'after' },
      );
      return doc ? toEvalRunRow(doc, orgId) : null;
    });
  }

  async listCasesForHash(orgId: string, datasetId: string): Promise<EvalCaseContent[]> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const cases = new TenantScopedCollection<EvalCaseMongoDoc>(db.collection(EVAL_CASES));
      const docs = await cases
        .find(
          orgId,
          { dataset_id: binUuid(datasetId, 'datasetId') },
          { ...sessionOf(ctx), sort: { sequence: 1 } },
        )
        .toArray();
      return docs.map((c) => ({
        id: c.id.toUUID().toString(),
        input: c.input,
        expected: c.expected,
        rubric: c.rubric ?? null,
      }));
    });
  }

  async countRunsForDataset(orgId: string, datasetId: string): Promise<number> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const runs = new TenantScopedCollection<EvalRunMongoDoc>(db.collection(EVAL_RUNS));
      return runs.countDocuments(
        orgId,
        { dataset_id: binUuid(datasetId, 'datasetId') },
        sessionOf(ctx),
      );
    });
  }

  async latestCompletedRunScore(
    orgId: string,
    assistantVersionId: string,
    datasetId: string,
  ): Promise<string | null> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const runs = new TenantScopedCollection<EvalRunMongoDoc>(db.collection(EVAL_RUNS));
      const docs = await runs
        .find(
          orgId,
          {
            assistant_version_id: binUuid(assistantVersionId, 'assistantVersionId'),
            dataset_id: binUuid(datasetId, 'datasetId'),
            state: 'completed',
          },
          {
            ...sessionOf(ctx),
            sort: { finished_at: -1 },
            limit: 1,
            projection: { score: 1 },
          },
        )
        .toArray();
      return docs[0]?.score ?? null;
    });
  }
}
