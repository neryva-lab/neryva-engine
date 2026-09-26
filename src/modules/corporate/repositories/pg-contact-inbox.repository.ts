/**
 * PostgreSQL contact-inbox repository (P3) — `contact_submissions`.
 * Mechanical move of the `ContactInboxService` persistence. Corporate tables
 * are global (non-tenant, no RLS) — every method runs through `withBypass`,
 * matching the original `db.root` usage.
 */
import { eq, sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { contactSubmissions } from '../public.schema';
import type {
  ContactSubmissionRow,
  IContactInboxRepository,
  IntakeContactSubmissionInput,
  ListSubmissionsFilter,
  TransitionSubmissionInput,
} from './contact-inbox.repository';

export class PgContactInboxRepository implements IContactInboxRepository {
  constructor(private readonly db: DbService) {}

  async insertSubmission(input: IntakeContactSubmissionInput): Promise<void> {
    await this.db.withBypass((tx) =>
      tx.insert(contactSubmissions).values({
        name: input.name,
        email: input.email,
        company: input.company,
        message: input.message,
        requestIp: input.requestIp,
        optInUpdates: input.optInUpdates,
      }),
    );
  }

  async listSubmissions(filter: ListSubmissionsFilter): Promise<{ submissions: Record<string, unknown>[]; total: number; limit: number; offset: number }> {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const offset = Math.max(filter.offset ?? 0, 0);
    const like = filter.q ? `%${filter.q.replace(/[%_]/g, '')}%` : null;
    return this.db.withBypass(async (tx) => {
      const rows = await tx.execute<Record<string, unknown>>(sql`
        select id, name, email, company, message, status, notes, replied_at, opt_in_updates, created_at
        from contact_submissions
        where (${filter.status ?? null}::varchar is null or status = ${filter.status ?? null})
          and (${like}::varchar is null or email like ${like} or name ilike ${like} or company ilike ${like})
        order by created_at desc
        limit ${limit} offset ${offset}
      `);
      const total = await tx.execute<{ count: number }>(sql`
        select count(*)::int as count from contact_submissions
        where (${filter.status ?? null}::varchar is null or status = ${filter.status ?? null})
          and (${like}::varchar is null or email like ${like} or name ilike ${like} or company ilike ${like})
      `);
      return { submissions: rows.rows, total: total.rows[0]?.count ?? 0, limit, offset };
    });
  }

  async getSubmissionById(submissionId: string): Promise<ContactSubmissionRow | null> {
    const rows = await this.db.withBypass((tx) =>
      tx.select().from(contactSubmissions).where(eq(contactSubmissions.id, submissionId)).limit(1),
    );
    return rows[0] ?? null;
  }

  async transitionSubmission(input: TransitionSubmissionInput): Promise<void> {
    await this.db.withBypass((tx) =>
      tx
        .update(contactSubmissions)
        .set({
          status: input.target,
          ...(input.notes !== undefined ? { notes: input.notes.slice(0, 8000) } : {}),
          ...(input.markReplied ? { repliedAt: new Date().toISOString() } : {}),
        })
        .where(eq(contactSubmissions.id, input.submissionId)),
    );
  }
}
