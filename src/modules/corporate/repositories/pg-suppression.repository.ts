/**
 * PostgreSQL suppression repository (P3) — `email_suppressions`.
 * Mechanical move of the `SuppressionService` persistence. Corporate tables
 * are global (non-tenant, no RLS) — every method runs through `withBypass`,
 * matching the original `db.root` usage.
 *
 * `suppress` with reason 'unsubscribe' also flips the newsletter_subs row —
 * the one chokepoint both flows share (kept here, as in the original).
 */
import { desc, eq, sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { ApiError } from '../../../common/http/api-error';
import { emailSuppressions } from '../public.schema';
import type { EmailSuppressionRow, ISuppressionRepository, SuppressInput } from './suppression.repository';

export class PgSuppressionRepository implements ISuppressionRepository {
  constructor(private readonly db: DbService) {}

  async isSuppressed(email: string): Promise<boolean> {
    const rows = await this.db.withBypass((tx) =>
      tx
        .select({ id: emailSuppressions.id })
        .from(emailSuppressions)
        .where(eq(emailSuppressions.email, email.toLowerCase()))
        .limit(1),
    );
    return !!rows[0];
  }

  async suppress(input: SuppressInput): Promise<void> {
    const email = input.email.toLowerCase();
    await this.db.withBypass(async (tx) => {
      await tx
        .insert(emailSuppressions)
        .values({ email, reason: input.reason, detail: input.detail?.slice(0, 512) })
        .onConflictDoNothing({ target: emailSuppressions.email });
      if (input.reason === 'unsubscribe') {
        await tx.execute(
          sql`update newsletter_subs set status = 'unsubscribed', unsubscribed_at = now() where email = ${email} and status <> 'unsubscribed'`,
        );
      }
    });
  }

  async listSuppressions(limit: number): Promise<EmailSuppressionRow[]> {
    return this.db.withBypass((tx) =>
      tx.select().from(emailSuppressions).orderBy(desc(emailSuppressions.createdAt)).limit(Math.min(limit, 1000)),
    );
  }

  async resolveSuppression(email: string): Promise<string> {
    const updated = await this.db.withBypass((tx) =>
      tx
        .update(emailSuppressions)
        .set({ resolvedAt: new Date().toISOString() })
        .where(eq(emailSuppressions.email, email.toLowerCase()))
        .returning({ id: emailSuppressions.id }),
    );
    if (!updated[0]) {
      throw ApiError.notFound('suppression entry');
    }
    return updated[0].id;
  }
}
