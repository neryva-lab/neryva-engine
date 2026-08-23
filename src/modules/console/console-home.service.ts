import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DbService } from '../../common/infra/db/db.service';
import { ApiError } from '../../common/http/api-error';
import { L1Principal } from '../../common/auth/principal';
import { EntitlementsService } from '../organizations/entitlements.service';
import { MembershipsService } from '../organizations/memberships.service';
import { ProjectsService } from '../organizations/projects.service';
import { OrgAccessService } from '../organizations/org-access.service';
import { ManifestRegistryService } from './manifest-registry.service';
import { SummaryProviderRegistry } from './summary-provider.registry';
import { ProductManifest, resolveCta } from './manifest.schema';

/**
 * The console home payload (C-3/C-4): org header with context resolution,
 * product cards for EVERY registered product (owned or not — discovery is
 * the growth loop), and the nav model the shell renders.
 *
 * Card composition rule: manifest (static) + entitlement state (platform
 * machine) + cached provider summary + role-derived CTA. Products never
 * assert status; the platform never invents KPIs.
 */
export interface ConsoleHomeResponse {
  org: {
    id: string;
    name: string;
    role: string;
    projects: Array<{ id: string; name: string }>;
  } | null;
  orgs: Array<{ orgId: string; role: string; name: string | null }>;
  products: Array<{
    key: string;
    display_name: string;
    category: string;
    icon: string;
    brief: string;
    stage: ProductManifest['stage'];
    entitlement_state: 'none' | 'trial' | 'active' | 'past_due' | 'suspended' | 'expired';
    card: { kpis: unknown[]; alerts: unknown[]; primary_cta?: { label: string; route: string } };
    cta: ReturnType<typeof resolveCta>;
    portal_path: string | null;
    docs_url: string | null;
  }>;
  nav: {
    furniture: Array<{ label: string; route: string }>;
    products: Array<{ key: string; base_route: string | null; sections: Array<{ section: string; items: string[] }> }>;
  };
}

const FURNITURE_NAV = [
  { label: 'Members', route: '/console/org/members' },
  { label: 'Invites', route: '/console/org/invites' },
  { label: 'Projects', route: '/console/org/projects' },
  { label: 'Usage & billing', route: '/platform/usage' },
  { label: 'Audit', route: '/console/org/audit' },
];

@Injectable()
export class ConsoleHomeService {
  constructor(
    private readonly db: DbService,
    private readonly manifests: ManifestRegistryService,
    private readonly summaries: SummaryProviderRegistry,
    private readonly entitlements: EntitlementsService,
    private readonly memberships: MembershipsService,
    private readonly projects: ProjectsService,
    private readonly orgAccess: OrgAccessService,
  ) {}

  async home(principal: L1Principal, requestedOrgId: string | null): Promise<ConsoleHomeResponse> {
    const orgs = await this.orgAccess.listContexts(principal.id);

    // Context resolution (overview.md): no org → the account lands on the
    // org-creation/invitation page — the payload says so with org: null.
    if (orgs.length === 0) {
      return this.noOrgPayload();
    }

    const orgId = requestedOrgId ?? orgs[0].orgId;
    if (!orgs.some((o) => o.orgId === orgId)) {
      throw ApiError.forbidden('Not a member of this organization');
    }
    const role = (await this.memberships.getRole(principal.id, orgId))!;
    const orgName = await this.orgName(orgId);
    const projects = (await this.projects.list(orgId)).slice(0, 50).map((p) => ({ id: p.id, name: p.name }));

    const products = await Promise.all(
      this.manifests.list().map(async (manifest) => {
        const state = await this.entitlements.getState(orgId, manifest.key);
        const card = await this.summaries.cardFor(orgId, manifest.key);
        return {
          key: manifest.key,
          display_name: manifest.display_name,
          category: manifest.category,
          icon: manifest.icon,
          brief: manifest.brief,
          stage: manifest.stage,
          entitlement_state: state,
          card: {
            kpis: card.kpis,
            alerts: card.alerts,
            ...(card.primary_cta ? { primary_cta: card.primary_cta } : {}),
          },
          cta: resolveCta({ stage: manifest.stage, state, role }),
          portal_path: manifest.portal?.base_path ?? null,
          docs_url: manifest.docs_url ?? null,
        };
      }),
    );

    return {
      org: { id: orgId, name: orgName, role, projects },
      orgs,
      products,
      nav: {
        furniture: FURNITURE_NAV,
        products: this.manifests
          .list()
          .filter((m) => m.faces.control && m.console)
          .map((m) => ({
            key: m.key,
            base_route: m.console!.base_route,
            sections: m.console!.nav,
          })),
      },
    };
  }

  private noOrgPayload(): ConsoleHomeResponse {
    // Every product still renders (state none, no card) so the create-org
    // page can preview what the platform offers.
    return {
      org: null,
      orgs: [],
      products: this.manifests.list().map((manifest) => ({
        key: manifest.key,
        display_name: manifest.display_name,
        category: manifest.category,
        icon: manifest.icon,
        brief: manifest.brief,
        stage: manifest.stage,
        entitlement_state: 'none' as const,
        card: { kpis: [], alerts: [] },
        cta: resolveCta({ stage: manifest.stage, state: 'none', role: null }),
        portal_path: manifest.portal?.base_path ?? null,
        docs_url: manifest.docs_url ?? null,
      })),
      nav: { furniture: [], products: [] },
    };
  }

  private async orgName(orgId: string): Promise<string> {
    const rows = await this.db.root.execute<{ name: string }>(sql`select name from tenants where id = ${orgId} limit 1`);
    return rows.rows[0]?.name ?? 'your organization';
  }
}
