/**
 * PostgreSQL careers repository (P3) — `career_jobs` + `career_applications`.
 * Mechanical move of the `CareersService` persistence. Corporate tables are
 * global (non-tenant, no RLS) — every method runs through `withBypass`,
 * matching the original `db.root` usage.
 *
 * The `career_jobs.slug` unique violation is mapped to the client-facing
 * conflict here (the DB never returns raw 23505s).
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { ApiError } from '../../../common/http/api-error';
import { pgViolation } from '../../../common/infra/db/pg-types';
import { careerApplications, careerJobs } from '../public.schema';
import type {
  CareerApplicationRow,
  CareerJobRow,
  ICareersRepository,
  ListApplicationsFilter,
  SubmitCareerApplicationInput,
  TransitionApplicationInput,
  UpsertCareerJobInput,
} from './careers.repository';

function mapJobSlugViolation(err: unknown): never {
  if (pgViolation(err).code === '23505') {
    throw ApiError.conflict('slug already exists');
  }
  throw err as Error;
}

export class PgCareersRepository implements ICareersRepository {
  constructor(private readonly db: DbService) {}

  async publishedJobs(): Promise<CareerJobRow[]> {
    return this.db.withBypass((tx) =>
      tx
        .select()
        .from(careerJobs)
        .where(eq(careerJobs.status, 'published'))
        .orderBy(desc(careerJobs.publishedAt))
        .limit(200),
    );
  }

  async publishedJobBySlug(slug: string): Promise<CareerJobRow | null> {
    const rows = await this.db.withBypass((tx) =>
      tx
        .select()
        .from(careerJobs)
        .where(and(eq(careerJobs.slug, slug), eq(careerJobs.status, 'published')))
        .limit(1),
    );
    return rows[0] ?? null;
  }

  async listJobs(): Promise<CareerJobRow[]> {
    return this.db.withBypass((tx) =>
      tx.select().from(careerJobs).orderBy(desc(careerJobs.createdAt)).limit(200),
    );
  }

  async findJobIdBySlug(slug: string): Promise<string | null> {
    const rows = await this.db.withBypass((tx) =>
      tx.select({ id: careerJobs.id }).from(careerJobs).where(eq(careerJobs.slug, slug)).limit(1),
    );
    return rows[0]?.id ?? null;
  }

  async findPublishedJobIdBySlug(slug: string): Promise<string | null> {
    const rows = await this.db.withBypass((tx) =>
      tx
        .select({ id: careerJobs.id })
        .from(careerJobs)
        .where(and(eq(careerJobs.slug, slug), eq(careerJobs.status, 'published')))
        .limit(1),
    );
    return rows[0]?.id ?? null;
  }

  async getJobBySlug(slug: string): Promise<CareerJobRow | null> {
    const rows = await this.db.withBypass((tx) =>
      tx.select().from(careerJobs).where(eq(careerJobs.slug, slug)).limit(1),
    );
    return rows[0] ?? null;
  }

  async upsertJob(input: UpsertCareerJobInput): Promise<{ row: CareerJobRow; created: boolean }> {
    try {
      return await this.db.withBypass(async (tx) => {
        const existing = await tx.select().from(careerJobs).where(eq(careerJobs.slug, input.slug)).limit(1);
        if (existing[0]) {
          const updated = await tx
            .update(careerJobs)
            .set({
              title: input.title,
              department: input.department,
              location: input.location,
              employmentType: input.employmentType,
              descriptionMd: input.descriptionMd,
              applyInstructions: input.applyInstructions,
              updatedAt: new Date().toISOString(),
            })
            .where(eq(careerJobs.id, existing[0].id))
            .returning();
          return { row: updated[0], created: false };
        }
        const inserted = await tx
          .insert(careerJobs)
          .values({
            slug: input.slug,
            title: input.title,
            department: input.department,
            location: input.location,
            employmentType: input.employmentType,
            descriptionMd: input.descriptionMd,
            applyInstructions: input.applyInstructions,
          })
          .onConflictDoNothing({ target: careerJobs.slug })
          .returning();
        if (!inserted[0]) {
          throw ApiError.conflict('slug already exists');
        }
        return { row: inserted[0], created: true };
      });
    } catch (err) {
      mapJobSlugViolation(err);
    }
  }

  async setJobStatus(input: { jobId: string; status: 'draft' | 'published' | 'archived'; keepPublishedAt: string | null }): Promise<void> {
    const nowIso = new Date().toISOString();
    await this.db.withBypass((tx) =>
      tx
        .update(careerJobs)
        .set({
          status: input.status,
          publishedAt: input.status === 'published' ? (input.keepPublishedAt ?? nowIso) : input.keepPublishedAt,
          updatedAt: nowIso,
        })
        .where(eq(careerJobs.id, input.jobId)),
    );
  }

  async insertApplication(input: SubmitCareerApplicationInput): Promise<void> {
    await this.db.withBypass((tx) =>
      tx.insert(careerApplications).values({
        name: input.name,
        email: input.email,
        position: input.position,
        jobId: input.jobId,
        phone: input.phone,
        linkedinUrl: input.linkedinUrl,
        portfolioUrl: input.portfolioUrl,
        coverNote: input.coverNote,
        fileRef: input.fileRef,
        requestIp: input.requestIp,
      }),
    );
  }

  async listApplications(filter: ListApplicationsFilter): Promise<{ applications: Record<string, unknown>[]; total: number; limit: number; offset: number }> {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const offset = Math.max(filter.offset ?? 0, 0);
    return this.db.withBypass(async (tx) => {
      const rows = await tx.execute<Record<string, unknown>>(sql`
        select a.id, a.name, a.email, a.position, j.slug as job_slug, a.phone, a.linkedin_url,
               a.portfolio_url, a.cover_note, a.file_ref, a.status, a.notes, a.created_at
        from career_applications a
        left join career_jobs j on j.id = a.job_id
        where (${filter.status ?? null}::varchar is null or a.status = ${filter.status ?? null})
          and (${filter.jobSlug ?? null}::varchar is null or j.slug = ${filter.jobSlug ?? null})
        order by a.created_at desc
        limit ${limit} offset ${offset}
      `);
      const total = await tx.execute<{ count: number }>(sql`
        select count(*)::int as count from career_applications a
        left join career_jobs j on j.id = a.job_id
        where (${filter.status ?? null}::varchar is null or a.status = ${filter.status ?? null})
          and (${filter.jobSlug ?? null}::varchar is null or j.slug = ${filter.jobSlug ?? null})
      `);
      return { applications: rows.rows, total: total.rows[0]?.count ?? 0, limit, offset };
    });
  }

  async getApplicationById(applicationId: string): Promise<CareerApplicationRow | null> {
    const rows = await this.db.withBypass((tx) =>
      tx.select().from(careerApplications).where(eq(careerApplications.id, applicationId)).limit(1),
    );
    return rows[0] ?? null;
  }

  async transitionApplication(input: TransitionApplicationInput): Promise<void> {
    await this.db.withBypass((tx) =>
      tx
        .update(careerApplications)
        .set({
          status: input.target,
          ...(input.notes !== undefined ? { notes: input.notes.slice(0, 8000) } : {}),
        })
        .where(eq(careerApplications.id, input.applicationId)),
    );
  }
}
