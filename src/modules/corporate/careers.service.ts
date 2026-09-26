import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { EmailService } from './email/email.service';
import { SuppressionService } from './suppression.service';
import { CAREERS_REPOSITORY } from './repositories/repository-tokens';
import type { CareerApplicationRow, CareerJobRow, ICareersRepository } from './repositories/careers.repository';

/**
 * Careers v2 (E-2 to production grade): JOB POSTINGS as managed content
 * (draft → published → archived; the careers page renders published jobs)
 * plus the full APPLICATIONS pipeline (new → reviewed → interviewed →
 * offered | rejected | withdrawn) with notes, filters, and an
 * acknowledgment email to every applicant (suppression-aware).
 *
 * Persistence-blind (P3): all storage goes through `ICareersRepository`.
 * Corporate tables are global (non-tenant).
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
    @Inject(CAREERS_REPOSITORY) private readonly careers: ICareersRepository,
    private readonly audit: AuditService,
    private readonly email: EmailService,
    private readonly suppressions: SuppressionService,
  ) {}

  // ── public: jobs ───────────────────────────────────────────────────────────

  async publishedJobs(): Promise<unknown[]> {
    const rows = await this.careers.publishedJobs();
    return rows.map((job) => this.jobView(job));
  }

  async publishedJobBySlug(slug: string): Promise<unknown> {
    const row = await this.careers.publishedJobBySlug(slug);
    if (!row) {
      throw ApiError.notFound('job');
    }
    return this.jobView(row);
  }

  // ── staff: jobs CRUD ───────────────────────────────────────────────────────

  async listJobs(): Promise<unknown[]> {
    const rows = await this.careers.listJobs();
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
    const { row, created } = await this.careers.upsertJob({
      slug: input.slug,
      title: input.title,
      department: input.department,
      location: input.location,
      employmentType,
      descriptionMd: input.descriptionMd,
      applyInstructions: input.applyInstructions ?? null,
    });
    await this.audit.add({
      action: created ? 'corporate.job_created' : 'corporate.job_updated',
      resourceType: 'career_job',
      resourceId: row.id,
      actorType: 'account',
      actorId: input.actorId,
      details: { slug: input.slug },
    });
    return this.jobView(row);
  }

  async setJobStatus(input: { slug: string; status: 'draft' | 'published' | 'archived'; actorId: string }) {
    if (!JOB_STATUSES.includes(input.status)) {
      throw ApiError.validation({ status: `one of ${JOB_STATUSES.join(', ')}` });
    }
    const row = await this.careers.getJobBySlug(input.slug);
    if (!row) {
      throw ApiError.notFound('job');
    }
    const keepPublishedAt =
      input.status === 'published' ? (row.publishedAt ?? new Date().toISOString()) : row.publishedAt;
    await this.careers.setJobStatus({ jobId: row.id, status: input.status, keepPublishedAt });
    await this.audit.add({
      action: `corporate.job_${input.status}`,
      resourceType: 'career_job',
      resourceId: row.id,
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
      const found = await this.careers.findPublishedJobIdBySlug(input.jobSlug);
      if (!found) {
        throw ApiError.validation({ job_slug: 'unknown or unpublished job' });
      }
      jobId = found;
    }
    // Anti-spam heuristics beyond the honeypot: link-stuffed cover notes die here.
    if (input.coverNote && (input.coverNote.match(/https?:\/\//g)?.length ?? 0) > 5) {
      throw ApiError.validation({ cover_note: 'rejected' });
    }

    const email = input.email.toLowerCase();
    await this.careers.insertApplication({
      name: input.name,
      email,
      position: input.position,
      jobId,
      phone: input.phone ?? null,
      linkedinUrl: input.linkedinUrl ?? null,
      portfolioUrl: input.portfolioUrl ?? null,
      coverNote: input.coverNote ?? null,
      fileRef: input.fileRef ?? null,
      requestIp: input.ip ?? null,
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
    return this.careers.listApplications(filter);
  }

  /** Single application for staff drill-down (attachment download source). */
  async applicationById(applicationId: string): Promise<CareerApplicationRow | null> {
    if (!/^[0-9a-f-]{36}$/i.test(applicationId)) {
      throw ApiError.validation({ application_id: 'must be a uuid' });
    }
    return this.careers.getApplicationById(applicationId);
  }

  /** Pipeline transition: validated against the explicit table, audited, noted. */
  async transitionApplication(input: { applicationId: string; target: ApplicationStatus; notes?: string; actorId: string }) {
    const application = await this.careers.getApplicationById(input.applicationId);
    if (!application) {
      throw ApiError.notFound('application');
    }
    if (!APPLICATION_STATUSES.includes(input.target)) {
      throw ApiError.validation({ status: `one of ${APPLICATION_STATUSES.join(', ')}` });
    }
    if (application.status !== input.target && !APPLICATION_TRANSITIONS[application.status as ApplicationStatus].includes(input.target)) {
      throw ApiError.conflict(`invalid application transition ${application.status} -> ${input.target}`);
    }
    await this.careers.transitionApplication({
      applicationId: input.applicationId,
      target: input.target,
      notes: input.notes,
    });
    await this.audit.add({
      action: 'corporate.application_transitioned',
      resourceType: 'career_application',
      resourceId: input.applicationId,
      actorType: 'account',
      actorId: input.actorId,
      details: { from: application.status, to: input.target },
    });
  }

  private jobView(job: CareerJobRow) {
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
