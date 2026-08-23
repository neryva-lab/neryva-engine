import { and, desc, eq, sql } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { EmailService } from './email/email.service';
import { SuppressionService } from './suppression.service';
import { careerApplications, careerJobs } from './public.schema';

/**
 * Careers v2 (E-2 to production grade): JOB POSTINGS as managed content
 * (draft → published → archived; the careers page renders published jobs)
 * plus the full APPLICATIONS pipeline (new → reviewed → interviewed →
 * offered | rejected | withdrawn) with notes, filters, and an
 * acknowledgment email to every applicant (suppression-aware).
 */
const JOB_STATUSES = ['draft', 'published', 'archived'] as const;
export const APPLICATION_STATUSES = ['new', 'reviewed', 'interviewed', 'offered', 'rejected', 'withdrawn'] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];
const APPLICATION_TRANSITIONS: Record<ApplicationStatus, readonly ApplicationStatus[]> = {
  new: ['reviewed', 'rejected', 'withdrawn'],
  reviewed: ['interviewed', 'rejected', 'withdrawn'],
  interviewed: ['offered', 'rejected', 'withdrawn'],
  offered: ['withdrawn'],
  rejected: [],
  withdrawn: [],
};
const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contract', 'internship'] as const;

@Injectable()
export class CareersService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
    private readonly suppressions: SuppressionService,
  ) {}

  // ── public: jobs ───────────────────────────────────────────────────────────

  async publishedJobs(): Promise<unknown[]> {
    const rows = await this.db.root
      .select()
      .from(careerJobs)
      .where(eq(careerJobs.status, 'published'))
      .orderBy(desc(careerJobs.publishedAt))
      .limit(200);
    return rows.map((job) => this.jobView(job));
  }

  async publishedJobBySlug(slug: string): Promise<unknown> {
    const rows = await this.db.root
      .select()
      .from(careerJobs)
      .where(and(eq(careerJobs.slug, slug), eq(careerJobs.status, 'published')))
      .limit(1);
    if (!rows[0]) {
      throw ApiError.notFound('job');
    }
    return this.jobView(rows[0]);
  }

  // ── staff: jobs CRUD ───────────────────────────────────────────────────────

  async listJobs(): Promise<unknown[]> {
    const rows = await this.db.root.select().from(careerJobs).orderBy(desc(careerJobs.createdAt)).limit(200);
    return rows.map((job) => this.jobView(job));
  }

  async upsertJob(input: {
    slug: string;
    title: string;
    department: string;
    location: string;
    employmentType?: string;
    descriptionMd: string;
    applyInstructions?: string;
    actorId: string;
  }) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.slug)) {
      throw ApiError.validation({ slug: 'lowercase kebab-case' });
    }
    const employmentType = EMPLOYMENT_TYPES.includes(input.employmentType as never) ? input.employmentType! : 'full_time';
    const existing = await this.db.root.select().from(careerJobs).where(eq(careerJobs.slug, input.slug)).limit(1);
    if (existing[0]) {
      const updated = await this.db.root
        .update(careerJobs)
        .set({
          title: input.title,
          department: input.department,
          location: input.location,
          employmentType,
          descriptionMd: input.descriptionMd,
          applyInstructions: input.applyInstructions ?? null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(careerJobs.id, existing[0].id))
        .returning();
      await this.audit.add({
        action: 'corporate.job_updated',
        resourceType: 'career_job',
        resourceId: existing[0].id,
        actorType: 'account',
        actorId: input.actorId,
        details: { slug: input.slug },
      });
      return this.jobView(updated[0]);
    }
    const inserted = await this.db.root
      .insert(careerJobs)
      .values({
        slug: input.slug,
        title: input.title,
        department: input.department,
        location: input.location,
        employmentType,
        descriptionMd: input.descriptionMd,
        applyInstructions: input.applyInstructions ?? null,
      })
      .onConflictDoNothing({ target: careerJobs.slug })
      .returning();
    if (!inserted[0]) {
      throw ApiError.conflict('slug already exists');
    }
    await this.audit.add({
      action: 'corporate.job_created',
      resourceType: 'career_job',
      resourceId: inserted[0].id,
      actorType: 'account',
      actorId: input.actorId,
      details: { slug: input.slug },
    });
    return this.jobView(inserted[0]);
  }

  async setJobStatus(input: { slug: string; status: 'draft' | 'published' | 'archived'; actorId: string }) {
    if (!JOB_STATUSES.includes(input.status)) {
      throw ApiError.validation({ status: `one of ${JOB_STATUSES.join(', ')}` });
    }
    const rows = await this.db.root.select().from(careerJobs).where(eq(careerJobs.slug, input.slug)).limit(1);
    if (!rows[0]) {
      throw ApiError.notFound('job');
    }
    await this.db.root
      .update(careerJobs)
      .set({
        status: input.status,
        publishedAt: input.status === 'published' ? rows[0].publishedAt ?? new Date().toISOString() : rows[0].publishedAt,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(careerJobs.id, rows[0].id));
    await this.audit.add({
      action: `corporate.job_${input.status}`,
      resourceType: 'career_job',
      resourceId: rows[0].id,
      actorType: 'account',
      actorId: input.actorId,
      details: { slug: input.slug },
    });
  }

  // ── applications ───────────────────────────────────────────────────────────

  async submitApplication(input: {
    name: string;
    email: string;
    position: string;
    jobSlug?: string;
    phone?: string;
    linkedinUrl?: string;
    portfolioUrl?: string;
    coverNote?: string;
    fileRef?: string;
    ip: string | null;
  }): Promise<void> {
    let jobId: string | null = null;
    if (input.jobSlug) {
      const jobRows = await this.db.root
        .select({ id: careerJobs.id })
        .from(careerJobs)
        .where(and(eq(careerJobs.slug, input.jobSlug), eq(careerJobs.status, 'published')))
        .limit(1);
      if (!jobRows[0]) {
        throw ApiError.validation({ job_slug: 'unknown or unpublished job' });
      }
      jobId = jobRows[0].id;
    }
    // Anti-spam heuristics beyond the honeypot: link-stuffed cover notes die here.
    if (input.coverNote && (input.coverNote.match(/https?:\/\//g)?.length ?? 0) > 5) {
      throw ApiError.validation({ cover_note: 'rejected' });
    }

    const email = input.email.toLowerCase();
    await this.db.root.insert(careerApplications).values({
      name: input.name,
      email,
      position: input.position,
      jobId,
      phone: input.phone ?? null,
      linkedinUrl: input.linkedinUrl ?? null,
      portfolioUrl: input.portfolioUrl ?? null,
      coverNote: input.coverNote ?? null,
      fileRef: input.fileRef ?? null,
      requestIp: input.ip,
    });
    await this.audit.add({
      action: 'corporate.submission',
      resourceType: 'career_application',
      actorType: 'system',
      details: { kind: 'career', position: input.position.slice(0, 128), job_slug: input.jobSlug ?? '' },
    });

    // Acknowledgment (skipped silently for suppressed addresses).
    if (!(await this.suppressions.isSuppressed(email))) {
      await this.email
        .sendTemplate({
          template: 'corporate.career-ack',
          to: email,
          vars: { name: input.name.split(' ')[0] ?? input.name, position: input.position },
          metadata: { kind: 'career_ack' },
        })
        .catch(() => undefined);
    }
  }

  async listApplications(filter: { status?: string; jobSlug?: string; limit?: number; offset?: number }) {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const offset = Math.max(filter.offset ?? 0, 0);
    const rows = await this.db.root.execute<Record<string, unknown>>(sql`
      select a.id, a.name, a.email, a.position, j.slug as job_slug, a.phone, a.linkedin_url,
             a.portfolio_url, a.cover_note, a.file_ref, a.status, a.notes, a.created_at
      from career_applications a
      left join career_jobs j on j.id = a.job_id
      where (${filter.status ?? null}::varchar is null or a.status = ${filter.status ?? null})
        and (${filter.jobSlug ?? null}::varchar is null or j.slug = ${filter.jobSlug ?? null})
      order by a.created_at desc
      limit ${limit} offset ${offset}
    `);
    const total = await this.db.root.execute<{ count: number }>(sql`
      select count(*)::int as count from career_applications a
      left join career_jobs j on j.id = a.job_id
      where (${filter.status ?? null}::varchar is null or a.status = ${filter.status ?? null})
        and (${filter.jobSlug ?? null}::varchar is null or j.slug = ${filter.jobSlug ?? null})
    `);
    return { applications: rows.rows, total: total.rows[0]?.count ?? 0, limit, offset };
  }

  /** Pipeline transition: validated against the explicit table, audited, noted. */
  async transitionApplication(input: { applicationId: string; target: ApplicationStatus; notes?: string; actorId: string }) {
    const rows = await this.db.root.select().from(careerApplications).where(eq(careerApplications.id, input.applicationId)).limit(1);
    const application = rows[0];
    if (!application) {
      throw ApiError.notFound('application');
    }
    if (!APPLICATION_STATUSES.includes(input.target)) {
      throw ApiError.validation({ status: `one of ${APPLICATION_STATUSES.join(', ')}` });
    }
    if (application.status !== input.target && !APPLICATION_TRANSITIONS[application.status as ApplicationStatus].includes(input.target)) {
      throw ApiError.conflict(`invalid application transition ${application.status} -> ${input.target}`);
    }
    await this.db.root
      .update(careerApplications)
      .set({
        status: input.target,
        ...(input.notes !== undefined ? { notes: input.notes.slice(0, 8000) } : {}),
      })
      .where(eq(careerApplications.id, input.applicationId));
    await this.audit.add({
      action: 'corporate.application_transitioned',
      resourceType: 'career_application',
      resourceId: input.applicationId,
      actorType: 'account',
      actorId: input.actorId,
      details: { from: application.status, to: input.target },
    });
  }

  private jobView(job: typeof careerJobs.$inferSelect) {
    return {
      slug: job.slug,
      title: job.title,
      department: job.department,
      location: job.location,
      employment_type: job.employmentType,
      description_md: job.descriptionMd,
      apply_instructions: job.applyInstructions,
      status: job.status,
      published_at: job.publishedAt,
    };
  }
}
