/**
 * `IOnboardingRepository` — the persistence port for `account_onboarding`.
 *
 * Behavioral truth: `src/modules/identity/onboarding.service.ts`.
 * `complete` preserves the upsert-with-coalesce semantics: the FIRST
 * completion stamp wins (never overwritten), the skip flag and consent
 * columns always carry the LATEST acceptance.
 */
export interface OnboardingState {
  welcomeCompletedAt: string | null;
  welcomeSkipped: boolean;
  consentVersion: string | null;
}

export interface AccountOnboarding extends OnboardingState {
  accountId: string;
  consentAcceptedAt: string | null;
  consentSource: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IOnboardingRepository {
  findState(accountId: string): Promise<AccountOnboarding | null>;
  complete(
    accountId: string,
    input: {
      welcomeCompletedAt: string;
      skipped: boolean;
      termsVersion: string;
      consentAcceptedAt: string;
      consentSource: string;
      updatedAt: string;
    },
  ): Promise<OnboardingState>;
}
