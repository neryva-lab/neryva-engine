import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { evalCases, evalDatasets, evalRuns } from '../eval.schema';
import type {
  EvalCaseBody,
  EvalCaseRow,
  EvalDatasetRow,
  NewEvalCase,
  NewEvalDataset,
} from './repository-types';
import type { IEvalDatasetRepository } from './eval-dataset.repository';

/**
 * PostgreSQL implementation of `IEvalDatasetRepository` (P3).
 *
 * Mechanical move of the eval dataset/case SQL from `EvalService`. Each
 * method owns its transaction; no transaction handle leaks.
 *
 * Known race, preserved — NOT fixed: `appendCases` and `promoteCandidate`
 * allocate sequences as `max(sequence) + 1` with no lock, so concurrent
 * appends can mint the same sequence. Documenting, not fixing — behavior
 * parity with the current code.
 *
 * `deleteIfNoRuns` is best-effort under READ COMMITTED (documented on the
 * interface): a run inserted between the guard read and the delete still
 * loses to the FK; the FK violation propagates and the service maps it to
 * `has_runs`.
 *
 * `listCases` returns `{ cases: [], total: 0 }` when the dataset does not
 * exist (the interface has no not-found outcome); the service preserves
 * the 404 by checking `findById` first.
 *
 * What stays OUT (still the service's job): input validation
 * (`assertUuid`, Zod parsing, limit/offset clamps), name trimming/slicing,
 * CSV/JSON export formatting, the candidate-name convention
 * (`targetDatasetName` — the service resolves `targetDatasetId` before
 * calling `promoteCandidate`), audit writes.
 */
export class PgEvalDatasetRepository implements IEvalDatasetRepository {
  constructor(private readonly db: DbService) {}

  async create(orgId: string, dataset: NewEvalDataset): Promise<EvalDatasetRow | null> {
    return this.db.withOrg(orgId, async (tx) => {
      const rows = await tx
        .insert(evalDatasets)
        .values({ ...dataset, organizationId: orgId })
        .onConflictDoNothing()
        .returning();
      // Null on name conflict (uq_eval_datasets_org_name) — the service
      // maps this to 409, not 500.
      return rows[0] ?? null;
    });
  }

  async list(orgId: string, limit: number): Promise<EvalDatasetRow[]> {
    return this.db.withOrg(orgId, (tx) =>
      tx.select().from(evalDatasets).orderBy(desc(evalDatasets.createdAt)).limit(limit),
    );
  }

  async findById(orgId: string, datasetId: string): Promise<EvalDatasetRow | null> {
    return this.db.withOrg(orgId, async (tx) => {
      const rows = await tx
        .select()
        .from(evalDatasets)
        .where(and(eq(evalDatasets.id, datasetId), eq(evalDatasets.organizationId, orgId)))
        .limit(1);
      return rows[0] ?? null;
    });
  }

  async findByName(orgId: string, name: string): Promise<EvalDatasetRow | null> {
    return this.db.withOrg(orgId, async (tx) => {
      const rows = await tx
        .select()
        .from(evalDatasets)
        .where(and(eq(evalDatasets.organizationId, orgId), eq(evalDatasets.name, name)))
        .limit(1);
      return rows[0] ?? null;
    });
  }

  async listCases(
    orgId: string,
    datasetId: string,
    opts: { limit: number; offset: number },
  ): Promise<{ cases: EvalCaseRow[]; total: number }> {
    return this.db.withOrg(orgId, async (tx) => {
      const ds = await tx
        .select({ id: evalDatasets.id })
        .from(evalDatasets)
        .where(and(eq(evalDatasets.id, datasetId), eq(evalDatasets.organizationId, orgId)))
        .limit(1);
      if (ds.length === 0) {
        // No not-found outcome on the interface; the service checks
        // findById first to preserve the 404.
        return { cases: [], total: 0 };
      }
      const totalRows = await tx.execute(sql`
        select count(*)::int as total from eval_cases
        where organization_id = ${orgId}::uuid and dataset_id = ${datasetId}::uuid
      `);
      const total = Number((totalRows.rows[0] as { total: number }).total);
      const rows = await tx
        .select()
        .from(evalCases)
        .where(and(eq(evalCases.organizationId, orgId), eq(evalCases.datasetId, datasetId)))
        .orderBy(asc(evalCases.sequence))
        .limit(opts.limit)
        .offset(opts.offset);
      return { cases: rows, total };
    });
  }

  async appendCases(orgId: string, datasetId: string, cases: NewEvalCase[]): Promise<number> {
    return this.db.withOrg(orgId, async (tx) => {
      // Known race (documented above): max(sequence)+1 with no lock.
      const next = await tx.execute(sql`
        select coalesce(max(sequence), 0) + 1 as next from eval_cases where dataset_id = ${datasetId}::uuid
      `);
      let sequence = Number((next.rows[0] as { next: number | string }).next);
      for (const c of cases) {
        await tx.insert(evalCases).values({
          ...c,
          organizationId: orgId,
          datasetId,
          sequence: sequence++,
        });
      }
      return cases.length;
    });
  }

  async updateCase(
    orgId: string,
    datasetId: string,
    caseId: string,
    body: EvalCaseBody,
  ): Promise<EvalCaseRow | null> {
    return this.db.withOrg(orgId, async (tx) => {
      const rows = await tx
        .update(evalCases)
        .set({ input: body.input, expected: body.expected, rubric: body.rubric ?? null })
        .where(
          and(
            eq(evalCases.id, caseId),
            eq(evalCases.datasetId, datasetId),
            eq(evalCases.organizationId, orgId),
          ),
        )
        .returning();
      return rows[0] ?? null;
    });
  }

  async deleteCase(orgId: string, datasetId: string, caseId: string): Promise<boolean> {
    return this.db.withOrg(orgId, async (tx) => {
      const rows = await tx
        .delete(evalCases)
        .where(
          and(
            eq(evalCases.id, caseId),
            eq(evalCases.datasetId, datasetId),
            eq(evalCases.organizationId, orgId),
          ),
        )
        .returning({ id: evalCases.id });
      return rows.length > 0;
    });
  }

  async deleteIfNoRuns(
    orgId: string,
    datasetId: string,
  ): Promise<'deleted' | 'not_found' | 'has_runs'> {
    return this.db.withOrg(orgId, async (tx) => {
      const ds = await tx
        .select({ id: evalDatasets.id })
        .from(evalDatasets)
        .where(and(eq(evalDatasets.id, datasetId), eq(evalDatasets.organizationId, orgId)))
        .limit(1);
      if (ds.length === 0) {
        return 'not_found';
      }
      const runRows = await tx.execute(sql`
        select count(*)::int as total from eval_runs
        where organization_id = ${orgId}::uuid and dataset_id = ${datasetId}::uuid
      `);
      const runCount = Number((runRows.rows[0] as { total: number }).total);
      if (runCount > 0) {
        return 'has_runs';
      }
      await tx
        .delete(evalDatasets)
        .where(and(eq(evalDatasets.id, datasetId), eq(evalDatasets.organizationId, orgId)));
      // Best-effort under READ COMMITTED: a run inserted between the guard
      // and the delete loses to the FK; the violation propagates and the
      // service maps it to `has_runs`.
      return 'deleted';
    });
  }

  async exportAll(
    orgId: string,
    datasetId: string,
  ): Promise<{ dataset: EvalDatasetRow; cases: EvalCaseRow[] } | null> {
    return this.db.withOrg(orgId, async (tx) => {
      const ds = await tx
        .select()
        .from(evalDatasets)
        .where(and(eq(evalDatasets.id, datasetId), eq(evalDatasets.organizationId, orgId)))
        .limit(1);
      if (ds.length === 0) {
        return null;
      }
      const rows = await tx
        .select()
        .from(evalCases)
        .where(and(eq(evalCases.organizationId, orgId), eq(evalCases.datasetId, datasetId)))
        .orderBy(asc(evalCases.sequence));
      return { dataset: ds[0], cases: rows };
    });
  }

  async promoteCandidate(
    orgId: string,
    sourceDatasetId: string,
    targetDatasetId: string,
    caseId: string,
  ): Promise<{ promotedCaseId: string } | null> {
    return this.db.withOrg(orgId, async (tx) => {
      const source = await tx
        .select({ id: evalDatasets.id })
        .from(evalDatasets)
        .where(and(eq(evalDatasets.id, sourceDatasetId), eq(evalDatasets.organizationId, orgId)))
        .limit(1);
      const target = await tx
        .select({ id: evalDatasets.id })
        .from(evalDatasets)
        .where(and(eq(evalDatasets.id, targetDatasetId), eq(evalDatasets.organizationId, orgId)))
        .limit(1);
      if (source.length === 0 || target.length === 0) {
        return null;
      }
      const cases = await tx
        .select()
        .from(evalCases)
        .where(
          and(
            eq(evalCases.id, caseId),
            eq(evalCases.datasetId, sourceDatasetId),
            eq(evalCases.organizationId, orgId),
          ),
        )
        .limit(1);
      const candidate = cases[0];
      if (!candidate) {
        return null;
      }
      // Known race (documented above): max(sequence)+1 with no lock.
      const next = await tx.execute(sql`
        select coalesce(max(sequence), 0) + 1 as next from eval_cases where dataset_id = ${targetDatasetId}::uuid
      `);
      const sequence = Number((next.rows[0] as { next: number | string }).next);
      const promotedId = uuidv7();
      await tx.insert(evalCases).values({
        id: promotedId,
        organizationId: orgId,
        datasetId: targetDatasetId,
        input: candidate.input,
        expected: candidate.expected,
        rubric: candidate.rubric,
        sequence,
      });
      await tx.delete(evalCases).where(eq(evalCases.id, caseId));
      return { promotedCaseId: promotedId };
    });
  }
}
