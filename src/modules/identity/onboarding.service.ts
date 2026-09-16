import { eq, sql } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { env } from '../../common/config/env';
import { accountOnboarding } from './schema';

/**
 * First-run onboarding state (first-run ledger F1-7): the ONE durable truth
 * read by the post-login router, the console route gate, and `/platform/welcome`.
 *
 * Why this exists — the measured failure it replaces: the previous gate derived
 * "this is a first login" from a 30-minute wall-clock window on
 * `accounts.created_at`. The first social account in this deployment completed
 * its first console token exchange 75.8 minutes after creation (logins before
 * that never produced a console grant), so by the time the browser could
 * actually reach the app the window had closed: the org existed, contexts
 * length was 1, and the screen was still never shown — and could never come
 * back. A wall clock cannot answer "has this account been onboarded yet".
 *
 * Invariants (all preserved by construction):
 *  - Server-authoritative. The browser holds no completion flag; it reads
 *    `needed` from `GET /auth/me` and re-reads it at every guarded route.
 *  - Absence of a row = gate OPEN (a first login has nothing written yet).
 *  - Consent is versioned: a terms bump re-opens the gate exactly once.
 *  - Consent is REQUIRED to close the gate (the controller refuses a body
 *    without it) — personalization can be skipped, agreement cannot.
 */
export interface OnboardingState {
  needed: boolean;
  welcome_completed_at: string | null;
  welcome_skipped: boolean;
  consent_version: string | null;
  /** The terms version that must be consented to right now. */
  terms_version: string;
  /** Consent-copy links; empty ⇒ render the statement with no link. */
  terms_url: string;
  privacy_url: string;
}

/** The columns the gate actually reads (keeps the resolver pure/testable). */
export interface OnboardingRow {
  welcomeCompletedAt: string | null;
  welcomeSkipped: boolean;
  consentVersion: string | null;
}

export interface CompleteOnboardingInput {
  accountId: string;
  /** User intent from the screen: personalization skipped (name/workspace). */
  skipped: boolean;
  /** The terms version the client believed it was consenting to. */
  termsVersion: string;
}

/**
 * Pure gate resolution — unit-covered without a database.
 *
 * Open when BOTH hold: a completion stamp exists AND the recorded consent
 * names the CURRENT terms version. So the three ways in are (1) first login
 * (no row), (2) a row that somehow predates completion, and (3) a terms bump
 * (an older version recorded). The old evidence stays readable until the new
 * consent overwrites the version column.
 */
export function resolveOnboardingState(
  row: OnboardingRow | null | undefined,
  currentTermsVersion: string,
): Pick<OnboardingState, 'needed' | 'welcome_completed_at' | 'welcome_skipped' | 'consent_version'> {
  const completedAt = row?.welcomeCompletedAt ?? null;
  const consentVersion = row?.consentVersion ?? null;
  const consentedToCurrent = consentVersion !== null && consentVersion === currentTermsVersion;
  return {
    needed: completedAt === null || !consentedToCurrent,
    welcome_completed_at: completedAt,
    welcome_skipped: row?.welcomeSkipped ?? false,
    consent_version: consentVersion,
  };
}

@Injectable()
export class OnboardingService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  /** The onboarding block carried by GET /auth/me (one primary-key lookup). */
  async stateFor(accountId: string): Promise<OnboardingState> {
    const rows = await this.db.root
      // Justification (db.root): platform-plane row filtered to the caller's
      // own account id — this table has no tenant dimension to isolate.
      .select({
        welcomeCompletedAt: accountOnboarding.welcomeCompletedAt,
        welcomeSkipped: accountOnboarding.welcomeSkipped,
        consentVersion: accountOnboarding.consentVersion,
      })
      .from(accountOnboarding)
      .where(eq(accountOnboarding.accountId, accountId))
      .limit(1);
    return this.withCopy(resolveOnboardingState(rows[0], env.LEGAL__TERMS_VERSION));
  }

  /**
   * Record consent + completion.
   *
   * Idempotence (this route also carries @Idempotent, but the row itself must
   * be safe on its own): the FIRST completion stamp wins — a retry, a stale
   * tab, or a double submit can never move when the account was onboarded —
   * while the consent columns always carry the LATEST acceptance, which is
   * exactly what a terms bump needs.
   */
  async complete(input: CompleteOnboardingInput): Promise<OnboardingState> {
    const current = env.LEGAL__TERMS_VERSION;
    if (input.termsVersion !== current) {
      // The client rendered older consent copy: refuse to record agreement to
      // text the account did not read (409 ⇒ the screen re-renders and asks
      // again against the current version).
      throw ApiError.conflict('The terms have been updated — review and accept the current version', {
        reason: 'terms_version_stale',
        current,
      });
    }
    const now = new Date().toISOString();
    const rows = await this.db.root
      .insert(accountOnboarding)
      .values({
        accountId: input.accountId,
        welcomeCompletedAt: now,
        welcomeSkipped: input.skipped,
        consentVersion: current,
        consentAcceptedAt: now,
        consentSource: 'welcome',
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: accountOnboarding.accountId,
        set: {
          welcomeCompletedAt: sql`coalesce(${accountOnboarding.welcomeCompletedAt}, excluded.welcome_completed_at)`,
          welcomeSkipped: input.skipped,
          consentVersion: current,
          consentAcceptedAt: now,
          consentSource: 'welcome',
          updatedAt: now,
        },
      })
      .returning({
        welcomeCompletedAt: accountOnboarding.welcomeCompletedAt,
        welcomeSkipped: accountOnboarding.welcomeSkipped,
        consentVersion: accountOnboarding.consentVersion,
      });

    // Evidence trail (append-only audit chain): which terms version this
    // account agreed to, and whether it personalized. Actor = the account.
    await this.audit.add({
      action: 'account.onboarding_completed',
      resourceType: 'account',
      resourceId: input.accountId,
      actorType: 'account',
      actorId: input.accountId,
      details: {
        skipped: input.skipped,
        consent_version: current,
        terms_version: current,
        source: 'welcome',
      },
    });

    return this.withCopy(resolveOnboardingState(rows[0], current));
  }

  /** Attach the deployment copy (version + links) to the resolved gate. */
  private withCopy(
    resolved: Pick<OnboardingState, 'needed' | 'welcome_completed_at' | 'welcome_skipped' | 'consent_version'>,
  ): OnboardingState {
    return {
      ...resolved,
      terms_version: env.LEGAL__TERMS_VERSION,
      terms_url: env.LEGAL__TERMS_URL,
      privacy_url: env.LEGAL__PRIVACY_URL,
    };
  }
}
