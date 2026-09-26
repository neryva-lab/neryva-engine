/**
 * MongoDB lane for `IOnboardingRepository` (P3) — the persistence port for
 * `account_onboarding`.
 *
 * `complete` preserves the upsert-with-coalesce semantics: the FIRST
 * completion stamp wins (never overwritten), the skip flag and consent
 * columns always carry the LATEST acceptance.
 *
 * Behavioral truth: `src/modules/identity/onboarding.service.ts`.
 */
import { randomUUID } from 'node:crypto';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { binUuid, toAccountOnboarding, type AccountOnboardingMongoDoc } from './mongo-documents';
import type { AccountOnboarding, IOnboardingRepository, OnboardingState } from './onboarding.repository';

export class MongoOnboardingRepository implements IOnboardingRepository {
  constructor(private readonly mongo: MongoDbService) {}

  async findState(accountId: string): Promise<AccountOnboarding | null> {
    const doc = await this.mongo.root
      .collection<AccountOnboardingMongoDoc>('account_onboarding')
      .findOne({ account_id: binUuid(accountId) });
    return doc ? toAccountOnboarding(doc) : null;
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
    const onboarding = this.mongo.root.collection<AccountOnboardingMongoDoc>('account_onboarding');
    // The FIRST completion stamp wins (never overwritten); the skip flag
    // and consent columns always carry the LATEST acceptance. The
    // aggregation-pipeline update makes the coalesce atomic in a single
    // statement — the mongo equivalent of the pg lane's
    // onConflictDoUpdate(coalesce(...)).
    await onboarding.updateOne(
      { account_id: binUuid(accountId) },
      [
        {
          $set: {
            // A fresh row id on insert only; $ifNull keeps the existing one.
            id: { $ifNull: ['$id', binUuid(randomUUID())] },
            welcome_completed_at: { $ifNull: ['$welcome_completed_at', input.welcomeCompletedAt] },
            welcome_skipped: input.skipped,
            consent_version: input.termsVersion,
            consent_accepted_at: input.consentAcceptedAt,
            consent_source: input.consentSource,
            updated_at: input.updatedAt,
            created_at: { $ifNull: ['$created_at', input.updatedAt] },
          },
        },
      ],
      { upsert: true },
    );
    const doc = await onboarding.findOne({ account_id: binUuid(accountId) });
    return {
      welcomeCompletedAt: doc?.welcome_completed_at ?? input.welcomeCompletedAt,
      welcomeSkipped: input.skipped,
      consentVersion: input.termsVersion,
    };
  }
}
