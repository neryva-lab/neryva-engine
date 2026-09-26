/**
 * Contact-inbox repository port (P3) — `contact_submissions`.
 *
 * CORPORATE TABLES ARE GLOBAL (non-tenant): per `public.schema.ts`, the
 * corporate plane is "Platform-plane like accounts: NOT tenant-scoped, no
 * RLS — the engine is the only writer". No orgId on these methods by design.
 *
 * No DbService/Drizzle/Mongo types — plain domain types only.
 */
/** Plain domain view of a `contact_submissions` row (drizzle-free). */
export interface ContactSubmissionRow {
  id: string;
  name: string;
  email: string;
  company: string | null;
  message: string;
  requestIp: string | null;
  status: string;
  notes: string | null;
  repliedAt: string | null;
  optInUpdates: boolean;
  createdAt: string;
}

export interface IntakeContactSubmissionInput {
  name: string;
  email: string;
  company: string | null;
  message: string;
  requestIp: string | null;
  optInUpdates: boolean;
}

export interface ListSubmissionsFilter {
  status?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

export interface TransitionSubmissionInput {
  submissionId: string;
  target: string;
  notes?: string;
  markReplied: boolean;
}

export interface IContactInboxRepository {
  /** Public intake: store a submission. */
  insertSubmission(input: IntakeContactSubmissionInput): Promise<void>;
  /** Staff: filtered submission list with total count. */
  listSubmissions(filter: ListSubmissionsFilter): Promise<{ submissions: Record<string, unknown>[]; total: number; limit: number; offset: number }>;
  /** Staff: one submission by id; null when unknown. */
  getSubmissionById(submissionId: string): Promise<ContactSubmissionRow | null>;
  /** Staff: pipeline transition (status + optional notes + replied_at). */
  transitionSubmission(input: TransitionSubmissionInput): Promise<void>;
}
