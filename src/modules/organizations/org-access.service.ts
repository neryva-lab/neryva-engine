import { randomUUID } from 'node:crypto';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { EntitlementState, OrgAccessPort } from '../../common/auth/ports';
import { EventBus, EngineEvents, AccountCreatedEvent } from '../../common/events/event-bus';
import { AuditService } from '../../common/audit/audit.service';
import { legacyTenants } from '../../common/infra/db/legacy-schema';
import { EntitlementsService } from './entitlements.service';
import { MembershipsService } from './memberships.service';
import { orgMemberships } from './schema';

/**
 * OrgAccessPort implementation (the kernel's entitlement/roles guards bind
 * here) + the personal-org autocreation listener (ADR-001: signup creates
 * a personal org with an owner membership).
 *
 * tenants is the Python-owned table (ownership map: engine may INSERT new
 * orgs using the TenantModel column set — the DDL authority stays Python
 * until handover A-1). Defaults below mirror Python's model defaults so
 * the runtime reads these rows without surprises.
 */
@Injectable()
export class OrgAccessService implements OrgAccessPort, OnModuleInit {
  private readonly logger = new Logger(OrgAccessService.name);

  constructor(
    private readonly db: DbService,
    private readonly events: EventBus,
    private readonly audit: AuditService,
    private readonly memberships: MembershipsService,
    private readonly entitlements: EntitlementsService,
  ) {}

  onModuleInit(): void {
    this.events.on<AccountCreatedEvent>(EngineEvents.AccountCreated, async (event) => {
      await this.createPersonalOrg(event.accountId, event.email);
    });
  }

  async getMembershipRole(accountId: string, orgId: string): Promise<'owner' | 'admin' | 'billing' | 'developer' | 'reader' | null> {
    return this.memberships.getRole(accountId, orgId);
  }

  async getEntitlementState(orgId: string, product: string): Promise<EntitlementState> {
    return this.entitlements.getState(orgId, product);
  }

  /** ADR-001: personal org, individual tier, sole owner. */
  async createPersonalOrg(accountId: string, email: string): Promise<string> {
    const orgId = randomUUID();
    const slugBase = email.split('@')[0]?.replace(/[^a-z0-9-]/gi, '').slice(0, 24) || 'org';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const slug = `pers-${slugBase}-${randomUUID().slice(0, 8)}`;
      try {
        await this.db.root.insert(legacyTenants).values({
          id: orgId,
          slug,
          name: `${email.split('@')[0]}'s org`,
          allowed_topics: [],
          blocked_topics: [],
          escalation_threshold: 0.7,
          knowledge_allowlist: [],
          default_provider: 'openai',
          default_model: 'gpt-4',
          features: {},
          guardrail_config: {},
          guardrail_thresholds: {},
          version: 1,
        });
        break;
      } catch (err) {
        if (attempt === 4) {
          this.logger.error(`personal org creation failed for ${accountId}: ${(err as Error).message}`);
          throw err;
        }
      }
    }

    await this.db.root.insert(orgMemberships).values({
      accountId,
      orgId,
      role: 'owner',
      invitedBy: null,
    });
    await this.audit.add({
      action: 'org.created',
      resourceType: 'tenant',
      resourceId: orgId,
      actorType: 'system',
      tenantId: orgId,
      details: { kind: 'personal' },
    });
    return orgId;
  }

  /** The org picker payload for login/context resolution (ADR-001 contexts). */
  async listContexts(accountId: string): Promise<Array<{ orgId: string; role: string; name: string | null }>> {
    const memberships = await this.memberships.listForAccount(accountId);
    if (memberships.length === 0) {
      return [];
    }
    const orgRows = await this.db.withBypass((tx) =>
      // Justification (withBypass): cross-org read for exactly the caller's
      // memberships; ids come from the filtered membership query above.
      tx
        .select({ id: legacyTenants.id, name: legacyTenants.name })
        .from(legacyTenants),
    );
    const nameById = new Map(orgRows.map((row) => [row.id, row.name]));
    return memberships.map((m) => ({ orgId: m.orgId, role: m.role, name: nameById.get(m.orgId) ?? null }));
  }
}
