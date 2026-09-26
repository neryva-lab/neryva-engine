import { eq, sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { accountOnboarding } from '../schema';
import type {
  AccountOnboarding,
  IOnboardingRepository,
  OnboardingState,
} from './onboarding.repository';

/**
 * PostgreSQL implementation of `IOnboardingRepository` (P3).
 *
 * Mechanical move of the `account_onboarding` units from
 * `OnboardingService`.
 *
 * `complete` preserves the upsert-with-coalesce semantics: the FIRST
 * completion stamp wins (never overwritten), the skip flag and consent
 * columns always carry the LATEST acceptance. The terms-version gate
 * (refusing a stale version) stays with the caller.
 *
 * Identity tables are platform-plane / GLOBAL — no RLS, no tenant
 * dimension — so every method goes through `db.root`.
 */
export class PgOnboardingRepository implements IOnboardingRepository {
  constructor(private readonly db: DbService) {}

  async findState(accountId: string): Promise<AccountOnboarding | null> {
    const rows = await this.db.root
      .select()
      .from(accountOnboarding)
      .where(eq(accountOnboarding.accountId, accountId))
      .limit(1);
    return rows[0] ? toAccountOnboarding(rows[0]) : null;
  }

  async complete(
    accountId: string,
    input: {
      welcomeCompletedAt: string;
      skipped: boolean;
      termsVersion: string;
      consentAcceptedAt: string;
      consentSource: string;
      updatedAt: string;
    },
  ): Promise<OnboardingState> {
    const rows = await this.db.root
      .insert(accountOnboarding)
      .values({
        accountId,
        welcomeCompletedAt: input.welcomeCompletedAt,
        welcomeSkipped: input.skipped,
        consentVersion: input.termsVersion,
        consentAcceptedAt: input.consentAcceptedAt,
        consentSource: input.consentSource,
        updatedAt: input.updatedAt,
      })
      .onConflictDoUpdate({
        target: accountOnboarding.accountId,
        set: {
          welcomeCompletedAt: sql`coalesce(${accountOnboarding.welcomeCompletedAt}, excluded.welcome_completed_at)`,
          welcomeSkipped: input.skipped,
          consentVersion: input.termsVersion,
          consentAcceptedAt: input.consentAcceptedAt,
          consentSource: input.consentSource,
          updatedAt: input.updatedAt,
        },
      })
      .returning({
        welcomeCompletedAt: accountOnboarding.welcomeCompletedAt,
        welcomeSkipped: accountOnboarding.welcomeSkipped,
        consentVersion: accountOnboarding.consentVersion,
      });
    if (!rows[0]) {
      throw new Error('onboarding complete produced no row');
    }
    return rows[0];
  }
}

function toAccountOnboarding(row: typeof accountOnboarding.$inferSelect): AccountOnboarding {
  return {
    accountId: row.accountId,
    welcomeCompletedAt: row.welcomeCompletedAt,
    welcomeSkipped: row.welcomeSkipped,
    consentVersion: row.consentVersion,
    consentAcceptedAt: row.consentAcceptedAt,
    consentSource: row.consentSource,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
