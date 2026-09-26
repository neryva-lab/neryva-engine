/**
 * MongoDB implementation of the eval-dataset repository port (P3) — the
 * eval dataset and case lifecycle.
 *
 * PostgreSQL FK cascades (`eval_cases.dataset_id`, `eval_case_executions.*`)
 * are emulated explicitly: mongo has no FKs, so every delete that cascades
 * on the pg lane removes dependent rows in the same transaction here.
 */
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { TenantScopedCollection } from '../../../common/infra/db/mongo/concurrency/tenant-guard';
import { ApiError } from '../../../common/http/api-error';
import type {
  EvalCaseExecutionMongoDoc,
  EvalCaseMongoDoc,
  EvalDatasetMongoDoc,
  EvalRunMongoDoc,
} from './mongo-documents';
import type {
  EvalCaseBody,
  EvalCaseRow,
  EvalDatasetRow,
  NewEvalCase,
  NewEvalDataset,
} from './repository-types';
import type { IEvalDatasetRepository } from './eval-dataset.repository';
import {
  binUuid,
  ensureKnowledgeIndexes,
  newId,
  nowIso,
  sessionOf,
  uuidOf,
} from './mongo-knowledge-shared';
import { isDuplicateKey } from './mongo-documents';

const EVAL_DATASETS = 'eval_datasets';
const EVAL_CASES = 'eval_cases';
const EVAL_RUNS = 'eval_runs';
const EVAL_CASE_EXECUTIONS = 'eval_case_executions';

function toDatasetRow(doc: EvalDatasetMongoDoc, orgId: string): EvalDatasetRow {
  return {
    id: uuidOf(doc.id),
    organizationId: orgId,
    name: doc.name,
    description: doc.description,
    createdBy: doc.created_by,
    createdAt: doc.created_at,
  };
}

function toCaseRow(doc: EvalCaseMongoDoc, orgId: string): EvalCaseRow {
  return {
    id: uuidOf(doc.id),
    organizationId: orgId,
    datasetId: uuidOf(doc.dataset_id),
    input: doc.input as EvalCaseRow['input'],
    expected: doc.expected as EvalCaseRow['expected'],
    rubric: doc.rubric as EvalCaseRow['rubric'],
    sequence: doc.sequence,
    createdAt: doc.created_at,
  };
}

export class MongoEvalDatasetRepository implements IEvalDatasetRepository {
  constructor(private readonly mongo: MongoDbService) {}

  async create(orgId: string, dataset: NewEvalDataset): Promise<EvalDatasetRow | null> {
    const db = this.mongo.root;
    await ensureKnowledgeIndexes(db);
    // The duplicate-key translation sits OUTSIDE the transaction: on a
    // concurrent create race the loser's upsert can hit the unique index
    // (Mongo upserts are not conflict-proof), aborting its TX — the null
    // mapping happens after the abort, never inside it.
    try {
      return await this.mongo.withOrg(orgId, async (ctx) => {
        const datasets = new TenantScopedCollection<EvalDatasetMongoDoc>(db.collection(EVAL_DATASETS));
        const now = nowIso();
        // Atomic create-or-null on uq_eval_datasets_org_name: the upsert
        // either inserts (winner) or matches the existing row (loser →
        // null). `organization_id` rides in on the scoped filter equality
        // (upsert-from-filter), matching the pg row's org.
        const upserted = await datasets.updateOne(
          orgId,
          { name: dataset.name },
          {
            $setOnInsert: {
              id: binUuid(dataset.id ?? newId(), 'dataset.id'),
              name: dataset.name,
              description: dataset.description ?? null,
              created_by: dataset.createdBy,
              created_at: now,
            },
          },
          { ...sessionOf(ctx), upsert: true },
        );
        // Loser: a row with this name already exists — null, never 500.
        if (upserted.upsertedCount === 0) return null;
        // Winner: read back inside the same TX (snapshot-stable).
        const inserted = await datasets.findOne(orgId, { name: dataset.name }, sessionOf(ctx));
        if (!inserted) throw new Error('mongo repository: eval dataset upsert lost its row');
        return toDatasetRow(inserted, orgId);
      });
    } catch (err) {
      // uq_eval_datasets_org_name — the caller maps this to 409, not 500.
      if (isDuplicateKey(err)) return null;
      throw err;
    }
  }

  async list(orgId: string, limit: number): Promise<EvalDatasetRow[]> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const datasets = new TenantScopedCollection<EvalDatasetMongoDoc>(db.collection(EVAL_DATASETS));
      const docs = await datasets
        .find(orgId, {}, { ...sessionOf(ctx), sort: { created_at: -1 }, limit: Math.max(limit, 0) })
        .toArray();
      return docs.map((d) => toDatasetRow(d, orgId));
    });
  }

  async findById(orgId: string, datasetId: string): Promise<EvalDatasetRow | null> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const datasets = new TenantScopedCollection<EvalDatasetMongoDoc>(db.collection(EVAL_DATASETS));
      const doc = await datasets.findOne(
        orgId,
        { id: binUuid(datasetId, 'datasetId') },
        sessionOf(ctx),
      );
      return doc ? toDatasetRow(doc, orgId) : null;
    });
  }

  async findByName(orgId: string, name: string): Promise<EvalDatasetRow | null> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const datasets = new TenantScopedCollection<EvalDatasetMongoDoc>(db.collection(EVAL_DATASETS));
      const doc = await datasets.findOne(orgId, { name }, sessionOf(ctx));
      return doc ? toDatasetRow(doc, orgId) : null;
    });
  }

  async listCases(
    orgId: string,
    datasetId: string,
    opts: { limit: number; offset: number },
  ): Promise<{ cases: EvalCaseRow[]; total: number }> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const datasets = new TenantScopedCollection<EvalDatasetMongoDoc>(db.collection(EVAL_DATASETS));
      const cases = new TenantScopedCollection<EvalCaseMongoDoc>(db.collection(EVAL_CASES));
      const s = sessionOf(ctx);
      // Atomic existence + count + page: the total cannot drift between
      // the count and the page.
      const datasetIdBin = binUuid(datasetId, 'datasetId');
      const exists = await datasets.countDocuments(orgId, { id: datasetIdBin }, { ...s, limit: 1 });
      if (exists === 0) {
        // No not-found outcome on the interface; the service checks
        // findById first to preserve the 404.
        return { cases: [], total: 0 };
      }
      const total = await cases.countDocuments(orgId, { dataset_id: datasetIdBin }, s);
      const docs = await cases
        .find(orgId, { dataset_id: datasetIdBin }, {
          ...s,
          sort: { sequence: 1 },
          limit: Math.max(opts.limit, 0),
          skip: Math.max(opts.offset, 0),
        })
        .toArray();
      return { cases: docs.map((d) => toCaseRow(d, orgId)), total };
    });
  }

  async appendCases(orgId: string, datasetId: string, cases: NewEvalCase[]): Promise<number> {
    const db = this.mongo.root;
    await ensureKnowledgeIndexes(db);
    return this.mongo.withOrg(orgId, async (ctx) => {
      const datasets = new TenantScopedCollection<EvalDatasetMongoDoc>(db.collection(EVAL_DATASETS));
      const caseCol = new TenantScopedCollection<EvalCaseMongoDoc>(db.collection(EVAL_CASES));
      const s = sessionOf(ctx);
      const datasetIdBin = binUuid(datasetId, 'datasetId');
      const exists = await datasets.countDocuments(orgId, { id: datasetIdBin }, { ...s, limit: 1 });
      // Documented divergence: the pg lane has no existence check — a
      // missing dataset fails on the eval_cases FK (error). Mongo has no
      // FK, so the check prevents orphaned case rows; the 404 names the
      // actual problem instead of an FK violation.
      if (exists === 0) throw ApiError.notFound('eval dataset');
      // Known race, preserved: sequences are allocated as max(sequence) + 1
      // with no lock, so concurrent appends can mint the same sequence.
      const top = await caseCol
        .find(orgId, { dataset_id: datasetIdBin }, { ...s, sort: { sequence: -1 }, limit: 1 })
        .toArray();
      let sequence = (top[0]?.sequence ?? 0) + 1;
      const now = nowIso();
      const docs: EvalCaseMongoDoc[] = cases.map((c) => ({
        id: binUuid(c.id ?? newId(), 'case.id'),
        organization_id: binUuid(orgId, 'orgId'),
        dataset_id: datasetIdBin,
        input: c.input,
        expected: c.expected,
        rubric: c.rubric ?? null,
        sequence: sequence++,
        created_at: now,
      }));
      if (docs.length > 0) {
        await caseCol.insertMany(orgId, docs, s);
      }
      return docs.length;
    });
  }

  async updateCase(
    orgId: string,
    datasetId: string,
    caseId: string,
    body: EvalCaseBody,
  ): Promise<EvalCaseRow | null> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const cases = new TenantScopedCollection<EvalCaseMongoDoc>(db.collection(EVAL_CASES));
      // Sequence and identity are preserved — run provenance anchors on the
      // same case id.
      const doc = await cases.findOneAndUpdate(
        orgId,
        {
          id: binUuid(caseId, 'caseId'),
          dataset_id: binUuid(datasetId, 'datasetId'),
        },
        { $set: { input: body.input, expected: body.expected, rubric: body.rubric ?? null } },
        { ...sessionOf(ctx), returnDocument: 'after' },
      );
      return doc ? toCaseRow(doc, orgId) : null;
    });
  }

  async deleteCase(orgId: string, datasetId: string, caseId: string): Promise<boolean> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const cases = new TenantScopedCollection<EvalCaseMongoDoc>(db.collection(EVAL_CASES));
      const executions = new TenantScopedCollection<EvalCaseExecutionMongoDoc>(
        db.collection(EVAL_CASE_EXECUTIONS),
      );
      const s = sessionOf(ctx);
      const caseIdBin = binUuid(caseId, 'caseId');
      const res = await cases.deleteOne(
        orgId,
        { id: caseIdBin, dataset_id: binUuid(datasetId, 'datasetId') },
        s,
      );
      if (res.deletedCount === 0) return false;
      // Emulate the pg cascade eval_case_executions.case_id → eval_cases.
      await executions.deleteMany(orgId, { case_id: caseIdBin }, s);
      return true;
    });
  }

  async deleteIfNoRuns(
    orgId: string,
    datasetId: string,
  ): Promise<'deleted' | 'not_found' | 'has_runs'> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const datasets = new TenantScopedCollection<EvalDatasetMongoDoc>(db.collection(EVAL_DATASETS));
      const cases = new TenantScopedCollection<EvalCaseMongoDoc>(db.collection(EVAL_CASES));
      const runs = new TenantScopedCollection<EvalRunMongoDoc>(db.collection(EVAL_RUNS));
      const executions = new TenantScopedCollection<EvalCaseExecutionMongoDoc>(
        db.collection(EVAL_CASE_EXECUTIONS),
      );
      const s = sessionOf(ctx);
      const datasetIdBin = binUuid(datasetId, 'datasetId');
      const dataset = await datasets.findOne(orgId, { id: datasetIdBin }, { ...s, projection: { id: 1 } });
      if (!dataset) return 'not_found';
      // Run-count guard: runs are append-only history behind publish
      // decisions — the refusal names the outcome so the service can map it.
      const runCount = await runs.countDocuments(orgId, { dataset_id: datasetIdBin }, s);
      if (runCount > 0) return 'has_runs';
      // Emulate the pg cascades (eval_cases.dataset_id, then executions).
      // NOTE (documented divergence): best-effort under READ COMMITTED on
      // pg too — a run inserted between the guard read and the delete loses
      // to the FK there and the service maps that to `has_runs`. Mongo has
      // no FK backstop: such a racing run would survive as an orphaned row
      // referencing the deleted dataset instead of being refused.
      const caseIds = (
        await cases.find(orgId, { dataset_id: datasetIdBin }, { ...s, projection: { id: 1 } }).toArray()
      ).map((c) => c.id);
      if (caseIds.length > 0) {
        await executions.deleteMany(orgId, { case_id: { $in: caseIds } }, s);
        await cases.deleteMany(orgId, { dataset_id: datasetIdBin }, s);
      }
      await datasets.deleteOne(orgId, { id: datasetIdBin }, s);
      return 'deleted';
    });
  }

  async exportAll(
    orgId: string,
    datasetId: string,
  ): Promise<{ dataset: EvalDatasetRow; cases: EvalCaseRow[] } | null> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const datasets = new TenantScopedCollection<EvalDatasetMongoDoc>(db.collection(EVAL_DATASETS));
      const cases = new TenantScopedCollection<EvalCaseMongoDoc>(db.collection(EVAL_CASES));
      const s = sessionOf(ctx);
      const dataset = await datasets.findOne(
        orgId,
        { id: binUuid(datasetId, 'datasetId') },
        s,
      );
      if (!dataset) return null;
      const caseDocs = await cases
        .find(orgId, { dataset_id: dataset.id }, { ...s, sort: { sequence: 1 } })
        .toArray();
      return {
        dataset: toDatasetRow(dataset, orgId),
        cases: caseDocs.map((c) => toCaseRow(c, orgId)),
      };
    });
  }

  async promoteCandidate(
    orgId: string,
    sourceDatasetId: string,
    targetDatasetId: string,
    caseId: string,
  ): Promise<{ promotedCaseId: string } | null> {
    const db = this.mongo.root;
    await ensureKnowledgeIndexes(db);
    return this.mongo.withOrg(orgId, async (ctx) => {
      const datasets = new TenantScopedCollection<EvalDatasetMongoDoc>(db.collection(EVAL_DATASETS));
      const cases = new TenantScopedCollection<EvalCaseMongoDoc>(db.collection(EVAL_CASES));
      const s = sessionOf(ctx);
      // Atomic copy + delete. Null when the candidate (or either dataset)
      // does not exist.
      const candidate = await cases.findOne(
        orgId,
        { id: binUuid(caseId, 'caseId'), dataset_id: binUuid(sourceDatasetId, 'sourceDatasetId') },
        s,
      );
      if (!candidate) return null;
      const targetBin = binUuid(targetDatasetId, 'targetDatasetId');
      const targetExists = await datasets.countDocuments(orgId, { id: targetBin }, { ...s, limit: 1 });
      if (targetExists === 0) return null;
      const top = await cases
        .find(orgId, { dataset_id: targetBin }, { ...s, sort: { sequence: -1 }, limit: 1 })
        .toArray();
      const promotedCaseId = newId();
      const now = nowIso();
      await cases.insertOne(
        orgId,
        {
          id: binUuid(promotedCaseId),
          organization_id: binUuid(orgId, 'orgId'),
          dataset_id: targetBin,
          input: candidate.input,
          expected: candidate.expected,
          rubric: candidate.rubric,
          sequence: (top[0]?.sequence ?? 0) + 1,
          created_at: now,
        },
        s,
      );
      await cases.deleteOne(orgId, { id: candidate.id }, s);
      // Emulate the pg cascade eval_case_executions.case_id → eval_cases
      // (ON DELETE CASCADE): the promoted candidate's executions go with it.
      const executions = new TenantScopedCollection<EvalCaseExecutionMongoDoc>(
        db.collection(EVAL_CASE_EXECUTIONS),
      );
      await executions.deleteMany(orgId, { case_id: candidate.id }, s);
      return { promotedCaseId };
    });
  }
}
