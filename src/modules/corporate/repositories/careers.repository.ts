/**
 * Careers repository port (P3) — `career_jobs` + `career_applications`.
 *
 * CORPORATE TABLES ARE GLOBAL (non-tenant): per `public.schema.ts`, the
 * corporate plane is "Platform-plane like accounts: NOT tenant-scoped, no
 * RLS — the engine is the only writer". There is no `organization_id` on
 * these tables, so no method takes an orgId. This is deliberate and
 * documented, not an omission.
 *
 * No DbService/Drizzle/Mongo types — plain domain types only.
 */
/** Plain domain view of a `career_jobs` row (drizzle-free). */
export interface CareerJobRow {
  id: string;
  slug: string;
  title: string;
  department: string;
  location: string;
  employmentType: string;
  descriptionMd: string;
  applyInstructions: string | null;
  status: string;
  publishedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Plain domain view of a `career_applications` row (drizzle-free). */
export interface CareerApplicationRow {
  id: string;
  name: string;
  email: string;
  position: string;
  jobId: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  portfolioUrl: string | null;
  coverNote: string | null;
  fileRef: string | null;
  requestIp: string | null;
  status: string;
  notes: string | null;
  createdAt: string;
}

export interface UpsertCareerJobInput {
  slug: string;
  title: string;
  department: string;
  location: string;
  employmentType: string;
  descriptionMd: string;
  applyInstructions: string | null;
}

export interface SubmitCareerApplicationInput {
  name: string;
  email: string;
  position: string;
  jobId: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  portfolioUrl: string | null;
  coverNote: string | null;
  fileRef: string | null;
  requestIp: string | null;
}

export interface ListApplicationsFilter {
  status?: string;
  jobSlug?: string;
  limit?: number;
  offset?: number;
}

export interface TransitionApplicationInput {
  applicationId: string;
  target: string;
  notes?: string;
}

export interface ICareersRepository {
  /** Published jobs for the public careers page, newest first. */
  publishedJobs(): Promise<CareerJobRow[]>;
  /** One published job by slug; null when unknown or unpublished. */
  publishedJobBySlug(slug: string): Promise<CareerJobRow | null>;
  /** Staff: all jobs, newest first. */
  listJobs(): Promise<CareerJobRow[]>;
  /** Find a job id by slug (any status); null when unknown. */
  findJobIdBySlug(slug: string): Promise<string | null>;
  /** Find a published job id by slug; null when unknown or unpublished. */
  findPublishedJobIdBySlug(slug: string): Promise<string | null>;
  /**
   * Insert or update a job by slug (slug validated by the caller).
   * Returns the row and whether it was created (true) or updated (false).
   * Throws `conflict('slug already exists')` when the insert loses a race.
   */
  upsertJob(input: UpsertCareerJobInput): Promise<{ row: CareerJobRow; created: boolean }>;
  /** Set job status (+ published_at anchoring on first publish). */
  setJobStatus(input: { jobId: string; status: 'draft' | 'published' | 'archived'; keepPublishedAt: string | null }): Promise<void>;
  /** Staff: get a job by slug for status transitions; null when unknown. */
  getJobBySlug(slug: string): Promise<CareerJobRow | null>;
  /** Public: store an application. */
  insertApplication(input: SubmitCareerApplicationInput): Promise<void>;
  /** Staff: filtered application list with total count. */
  listApplications(filter: ListApplicationsFilter): Promise<{ applications: Record<string, unknown>[]; total: number; limit: number; offset: number }>;
  /** Staff: one application by id; null when unknown. */
  getApplicationById(applicationId: string): Promise<CareerApplicationRow | null>;
  /** Staff: pipeline transition (status + optional notes). */
  transitionApplication(input: TransitionApplicationInput): Promise<void>;
}
