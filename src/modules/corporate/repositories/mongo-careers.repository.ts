/**
 * MongoDB lane for `ICareersRepository` (P3).
 *
 * Plan D4: UUIDs as BSON Binary subtype 4, pg snake_case field names,
 * ISO-8601 timestamp strings. Corporate tables are global (non-tenant) —
 * every method is one `withBypass` unit with plain collection handles.
 *
 * The `career_jobs.slug` duplicate-key is mapped to the same client-facing
 * conflict the pg lane raises. On an insert race the duplicate-key is
 * caught and mapped to `conflict('slug already exists')` WITHOUT further
 * reads in the aborted transaction.
 */
import type { Db } from 'mongodb';
import { ApiError } from '../../../common/http/api-error';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { uuidv7 } from '../../../common/ids/uuidv7';
import type {
  CareerApplicationRow,
  CareerJobRow,
  ICareersRepository,
  ListApplicationsFilter,
  SubmitCareerApplicationInput,
  TransitionApplicationInput,
  UpsertCareerJobInput,
} from './careers.repository';
import {
  binUuid,
  corporateCollections,
  isDuplicateKey,
  toCareerApplication,
  toCareerJob,
} from './mongo-documents';

export class MongoCareersRepository implements ICareersRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private tx(db: Db, ctx: MongoTxContext) {
    return { session: { session: ctx.session }, ...corporateCollections(db) };
  }

  async publishedJobs(): Promise<CareerJobRow[]> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const docs = await t.careerJobs
        .find({ status: 'published' }, t.session)
        .sort({ published_at: -1 })
        .limit(200)
        .toArray();
      return docs.map(toCareerJob);
    });
  }

  async publishedJobBySlug(slug: string): Promise<CareerJobRow | null> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const doc = await t.careerJobs.findOne({ slug, status: 'published' }, t.session);
      return doc ? toCareerJob(doc) : null;
    });
  }

  async listJobs(): Promise<CareerJobRow[]> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const docs = await t.careerJobs.find({}, t.session).sort({ created_at: -1 }).limit(200).toArray();
      return docs.map(toCareerJob);
    });
  }

  async findJobIdBySlug(slug: string): Promise<string | null> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const doc = await t.careerJobs.findOne({ slug }, { ...t.session, projection: { id: 1 } });
      return doc ? doc.id.toUUID().toString() : null;
    });
  }

  async findPublishedJobIdBySlug(slug: string): Promise<string | null> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const doc = await t.careerJobs.findOne({ slug, status: 'published' }, { ...t.session, projection: { id: 1 } });
      return doc ? doc.id.toUUID().toString() : null;
    });
  }

  async getJobBySlug(slug: string): Promise<CareerJobRow | null> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const doc = await t.careerJobs.findOne({ slug }, t.session);
      return doc ? toCareerJob(doc) : null;
    });
  }

  async upsertJob(input: UpsertCareerJobInput): Promise<{ row: CareerJobRow; created: boolean }> {
    const db = this.mongo.root;
    const now = new Date().toISOString();
    try {
      return await this.mongo.withBypass(async (ctx) => {
        const t = this.tx(db, ctx);
        const existing = await t.careerJobs.findOne({ slug: input.slug }, t.session);
        if (existing) {
          const updated = await t.careerJobs.findOneAndUpdate(
            { id: existing.id },
            {
              $set: {
                title: input.title,
                department: input.department,
                location: input.location,
                employment_type: input.employmentType,
                description_md: input.descriptionMd,
                apply_instructions: input.applyInstructions,
                updated_at: now,
              },
            },
            { ...t.session, returnDocument: 'after' },
          );
          if (!updated) {
            throw ApiError.notFound('job');
          }
          return { row: toCareerJob(updated), created: false };
        }
        const doc = {
          id: binUuid(uuidv7()),
          slug: input.slug,
          title: input.title,
          department: input.department,
          location: input.location,
          employment_type: input.employmentType,
          description_md: input.descriptionMd,
          apply_instructions: input.applyInstructions,
          status: 'draft',
          published_at: null,
          created_by: null,
          created_at: now,
          updated_at: now,
        };
        await t.careerJobs.insertOne(doc, t.session);
        return { row: toCareerJob({ ...doc, _id: undefined as never }), created: true };
      });
    } catch (err) {
      // Insert race lost: the pg lane's onConflictDoNothing + empty-returning
      // maps to the same client-facing conflict. No reads in the aborted txn.
      if (isDuplicateKey(err)) {
        throw ApiError.conflict('slug already exists');
      }
      throw err as Error;
    }
  }

  async setJobStatus(input: { jobId: string; status: 'draft' | 'published' | 'archived'; keepPublishedAt: string | null }): Promise<void> {
    const db = this.mongo.root;
    const nowIso = new Date().toISOString();
    await this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      await t.careerJobs.updateOne(
        { id: binUuid(input.jobId, 'jobId') },
        {
          $set: {
            status: input.status,
            published_at: input.status === 'published' ? (input.keepPublishedAt ?? nowIso) : input.keepPublishedAt,
            updated_at: nowIso,
          },
        },
        t.session,
      );
    });
  }

  async insertApplication(input: SubmitCareerApplicationInput): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      await t.careerApplications.insertOne(
        {
          id: binUuid(uuidv7()),
          name: input.name,
          email: input.email,
          position: input.position,
          job_id: input.jobId ? binUuid(input.jobId, 'jobId') : null,
          phone: input.phone,
          linkedin_url: input.linkedinUrl,
          portfolio_url: input.portfolioUrl,
          cover_note: input.coverNote,
          file_ref: input.fileRef,
          request_ip: input.requestIp,
          status: 'new',
          notes: null,
          created_at: new Date().toISOString(),
        },
        t.session,
      );
    });
  }

  async listApplications(filter: ListApplicationsFilter): Promise<{ applications: Record<string, unknown>[]; total: number; limit: number; offset: number }> {
    const db = this.mongo.root;
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const offset = Math.max(filter.offset ?? 0, 0);
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const match: Record<string, unknown> = {};
      if (filter.status) {
        match['status'] = filter.status;
      }
      // Join with jobs for the slug filter + projection (the pg LEFT JOIN).
      const pipeline: Record<string, unknown>[] = [
        { $match: match },
        {
          $lookup: {
            from: 'career_jobs',
            localField: 'job_id',
            foreignField: 'id',
            as: '_job',
          },
        },
        { $unwind: { path: '$_job', preserveNullAndEmptyArrays: true } },
      ];
      if (filter.jobSlug) {
        pipeline.push({ $match: { '_job.slug': filter.jobSlug } });
      }
      const countPipeline = [...pipeline, { $count: 'total' }];
      const countDocs = await t.careerApplications.aggregate(countPipeline, t.session).toArray();
      const total = (countDocs[0] as { total?: number } | undefined)?.total ?? 0;
      pipeline.push({ $sort: { created_at: -1 } }, { $skip: offset }, { $limit: limit });
      const docs = await t.careerApplications.aggregate(pipeline, t.session).toArray();
      const applications = docs.map((d) => {
        const doc = d as Record<string, unknown> & { _job?: { slug?: string } | null };
        const app = doc as unknown as Parameters<typeof toCareerApplication>[0];
        return {
          id: app.id.toUUID().toString(),
          name: app.name,
          email: app.email,
          position: app.position,
          job_slug: doc._job?.slug ?? null,
          phone: app.phone,
          linkedin_url: app.linkedin_url,
          portfolio_url: app.portfolio_url,
          cover_note: app.cover_note,
          file_ref: app.file_ref,
          status: app.status,
          notes: app.notes,
          created_at: app.created_at,
        };
      });
      return { applications, total, limit, offset };
    });
  }

  async getApplicationById(applicationId: string): Promise<CareerApplicationRow | null> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const doc = await t.careerApplications.findOne({ id: binUuid(applicationId, 'applicationId') }, t.session);
      return doc ? toCareerApplication(doc) : null;
    });
  }

  async transitionApplication(input: TransitionApplicationInput): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const update: Record<string, unknown> = { status: input.target };
      if (input.notes !== undefined) {
        update['notes'] = input.notes.slice(0, 8000);
      }
      await t.careerApplications.updateOne(
        { id: binUuid(input.applicationId, 'applicationId') },
        { $set: update },
        t.session,
      );
    });
  }
}
