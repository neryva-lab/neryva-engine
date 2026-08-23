import { and, eq, isNull } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { legacyApiKeys } from '../../common/infra/db/legacy-schema';
import { projects } from '../organizations/schema';
import { EntitlementsService } from '../organizations/entitlements.service';
import { ManifestRegistryService } from './manifest-registry.service';
import { spendEvents } from '../billing/schema';

/**
 * Onboarding state (gap C-3 — the OpenAI/Anthropic "get started" checklist):
 * computes the first-run flags the shell renders as a guided-setup card.
 * Reads only what the engine owns (projects, keys, entitlements, first
 * usage) — no new state, so it can never drift out of sync with reality.
 */
export interface OnboardingStep {
  key: 'create_project' | 'create_api_key' | 'start_trial' | 'first_usage';
  title: string;
  hint: string;
  route: string;
  done: boolean;
}

export interface OnboardingState {
  complete: boolean;
  completed_steps: number;
  steps: OnboardingStep[];
}

@Injectable()
export class ConsoleOnboardingService {
  constructor(
    private readonly db: DbService,
    private readonly entitlements: EntitlementsService,
    private readonly manifests: ManifestRegistryService,
  ) {}

  async state(orgId: string): Promise<OnboardingState> {
    const [projectRows, keyRows, firstUsage, entitledProducts] = await Promise.all([
      this.db.withOrg(orgId, (tx) => tx.select({ id: projects.id }).from(projects).where(and(eq(projects.orgId, orgId), isNull(projects.archivedAt))).limit(1)),
      this.db.root.select({ id: legacyApiKeys.id }).from(legacyApiKeys).where(and(eq(legacyApiKeys.tenant_id, orgId), eq(legacyApiKeys.revoked, false))).limit(1),
      this.db.withOrg(orgId, (tx) => tx.select({ id: spendEvents.id }).from(spendEvents).where(eq(spendEvents.orgId, orgId)).limit(1)),
      Promise.all(this.manifests.list().map(async (m) => ({ key: m.key, state: await this.entitlements.getState(orgId, m.key) }))),
    ]);

    const hasTrialOrActive = entitledProducts.some((p) => p.state === 'trial' || p.state === 'active');
    const steps: OnboardingStep[] = [
      { key: 'create_project', title: 'Create a project', hint: 'Projects scope keys, limits, and usage.', route: '/platform/projects', done: projectRows.length > 0 },
      { key: 'start_trial', title: 'Start a product trial', hint: 'Pick a product from the home cards.', route: '/platform', done: hasTrialOrActive },
      { key: 'create_api_key', title: 'Create an API key', hint: 'One key per project keeps ledgers clean.', route: '/platform/api-keys', done: keyRows.length > 0 },
      { key: 'first_usage', title: 'Make your first call', hint: 'Point the SDK at the runtime API with your key.', route: '/platform/usage', done: firstUsage.length > 0 },
    ];
    const completed = steps.filter((s) => s.done).length;
    return { complete: completed === steps.length, completed_steps: completed, steps };
  }
}
