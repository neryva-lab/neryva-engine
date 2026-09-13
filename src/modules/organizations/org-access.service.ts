import { randomUUID } from 'node:crypto';
import { inArray, sql, and, eq } from 'drizzle-orm';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { EntitlementState, OrgAccessPort } from '../../common/auth/ports';
import { EventBus, EngineEvents, AccountCreatedEvent } from '../../common/events/event-bus';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { env } from '../../common/config/env';
import { legacyTenants } from '../../common/infra/db/legacy-schema';
import { EntitlementsService } from './entitlements.service';
import { MembershipsService } from './memberships.service';
import { orgMemberships, orgSettings } from './schema';

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

  /**
   * ADR-001: personal org, individual tier, sole owner. The whole creation —
   * tenants row, owner membership — is one transaction via insertOrgWithOwner
   * (AUTH-2.2 refactor): a membership failure can no longer strand an orphan
   * tenants row the way two separate root writes could.
   */
  async createPersonalOrg(accountId: string, email: string): Promise<string> {
    const orgId = randomUUID();
    const slugBase = email.split('@')[0]?.replace(/[^a-z0-9-]/gi, '').slice(0, 24) || 'org';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const slug = `pers-${slugBase}-${randomUUID().slice(0, 8)}`;
      try {
        await this.insertOrgWithOwner({ orgId, slug, name: `${email.split('@')[0]}'s org`, accountId, kind: 'personal' });
        break;
      } catch (err) {
        if (attempt === 4) {
          this.logger.error(`personal org creation failed for ${accountId}: ${(err as Error).message}`);
          throw err;
        }
      }
    }

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

  /**
   * AUTH-2.2 (auth_plan.md D3): explicit team-workspace creation — the path
   * that was missing entirely (the only org creation before was the ADR-001
   * personal autocreation). Same documented tenants INSERT seam, same owner
   * membership, plus an eager org_settings row with kind='team'. User-chosen
   * slugs are immutable and collide with a 409; derived slugs retry with a
   * fresh suffix. New team orgs start with no entitlements — the owner
   * proceeds through the existing StartTrial flow.
   */
  async createTeamOrg(input: { accountId: string; name: string; slug: string | null }): Promise<{ orgId: string; slug: string }> {
    const name = input.name.trim();
    if (name.length < 1 || name.length > 128) {
      throw ApiError.validation({ name: 'must be 1-128 characters' });
    }
    if (input.slug !== null) {
      normalizeTeamSlug(input.slug); // fail fast on malformed user-chosen slugs
      if (RESERVED_SLUGS.has(normalizeTeamSlug(input.slug))) {
        throw ApiError.conflict('that workspace address is reserved', { reason: 'slug_reserved' });
      }
    }
    await this.assertOwnershipCapacity(input.accountId);

    const attempts = input.slug ? 1 : 5;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const orgId = randomUUID();
      const slug = input.slug ? normalizeTeamSlug(input.slug) : deriveTeamSlug(name, attempt > 0);
      try {
        await this.insertOrgWithOwner({ orgId, slug, name, accountId: input.accountId, kind: 'team' });
        await this.audit.add({
          action: 'org.created',
          resourceType: 'tenant',
          resourceId: orgId,
          actorType: 'account',
          actorId: input.accountId,
          tenantId: orgId,
          details: { kind: 'team', slug },
        });
        await this.events.emit(EngineEvents.OrgCreated, { orgId, slug, kind: 'team', accountId: input.accountId });
        return { orgId, slug };
      } catch (err) {
        lastErr = err;
        const pg = err as { code?: string };
        if (input.slug && pg?.code === '23505') {
          // A user-chosen slug is an immutable choice: collision is a 409, never a retry.
          throw ApiError.conflict('that workspace address is already taken', { reason: 'slug_taken' });
        }
        // Derived slug: loop retries with a fresh random suffix.
      }
    }
    throw lastErr ?? ApiError.internal();
  }

  /**
   * The shared creation transaction (personal + team): the Python-owned
   * tenants row (documented INSERT seam — engine inserts, Python owns DDL
   * until handover A-1), the owner membership, and (team only) the eager
   * org_settings row, all atomic. Tenant context is set transaction-locally
   * so the RLS-guarded membership/settings inserts admit the new org.
   */
  private async insertOrgWithOwner(input: { orgId: string; slug: string; name: string; accountId: string; kind: 'personal' | 'team' }): Promise<void> {
    const now = new Date().toISOString();
    await this.db.root.transaction(async (tx) => {
      await tx.execute(sql`select set_config('statement_timeout', '10000', true)`);
      await tx.execute(sql`select set_config('idle_in_transaction_session_timeout', '30000', true)`);
      await tx.execute(sql`select set_config('app.current_tenant', ${input.orgId}, true)`);
      await tx.insert(legacyTenants).values({
        id: input.orgId,
        slug: input.slug,
        name: input.name,
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
        // The Python TenantModel supplies these; the mirror carries no
        // defaults, so the engine passes them explicitly.
        created_at: now,
        updated_at: now,
      });
      await tx.insert(orgMemberships).values({ accountId: input.accountId, orgId: input.orgId, role: 'owner', invitedBy: null });
      if (input.kind === 'team') {
        await tx.insert(orgSettings).values({ orgId: input.orgId, kind: 'team' }).onConflictDoNothing({ target: orgSettings.orgId });
      }
    });
  }

  /**
   * AUTH-2.2: abuse cap — an account may own at most
   * ORGS__MAX_OWNED_PER_ACCOUNT orgs with an active owner membership.
   */
  private async assertOwnershipCapacity(accountId: string): Promise<void> {
    const rows = await this.db.withBypass((tx) =>
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(orgMemberships)
        .where(and(eq(orgMemberships.accountId, accountId), eq(orgMemberships.role, 'owner'), eq(orgMemberships.status, 'active'))),
    );
    // Justification (withBypass): the caller's own ownership rows span orgs
    // by definition; the query filters account_id explicitly.
    if (Number(rows[0]?.n ?? 0) >= env.ORGS__MAX_OWNED_PER_ACCOUNT) {
      throw ApiError.conflict(`you already own the maximum number of workspaces (${env.ORGS__MAX_OWNED_PER_ACCOUNT})`, { reason: 'ownership_cap_reached' });
    }
  }

  /**
   * The org picker payload for login/context resolution (ADR-001 contexts).
   * The tenants read is bounded to exactly the caller's membership orgs —
   * never an unbounded table scan (at 10k orgs the old read-everything
   * shape would have been the most expensive query in the console).
   */
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
        .from(legacyTenants)
        .where(
          inArray(
            legacyTenants.id,
            memberships.map((m) => m.orgId),
          ),
        ),
    );
    const nameById = new Map(orgRows.map((row) => [row.id, row.name]));
    return memberships.map((m) => ({ orgId: m.orgId, role: m.role, name: nameById.get(m.orgId) ?? null }));
  }
}

/** AUTH-2.2: workspace addresses that belong to the platform, never to a tenant. */
const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'www', 'api', 'admin', 'app', 'console', 'neryva', 'support', 'mail', 'staff', 'root', 'billing',
  'dashboard', 'help', 'docs', 'status', 'blog', 'login', 'signup', 'auth', 'account', 'accounts',
  'org', 'orgs', 'platform', 'settings', 'profile', 'email', 'webhooks', 'webhook', 'static', 'assets', 'cdn',
]);

/** Normalize + validate a user-chosen slug: 3-63 chars, lowercase alnum + hyphens, no leading/trailing hyphen. */
function normalizeTeamSlug(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(slug)) {
    throw ApiError.validation({ slug: 'must be 3-63 characters: lowercase letters, digits, hyphens; starts and ends with a letter or digit' });
  }
  return slug;
}

/** Derive a slug from the workspace name; fall back to a random suffix when the name yields nothing usable. */
function deriveTeamSlug(name: string, forceSuffix: boolean): string {
  if (!forceSuffix) {
    try {
      const derived = normalizeTeamSlug(name);
      if (!RESERVED_SLUGS.has(derived)) {
        return derived;
      }
    } catch {
      // fall through to the random suffix
    }
  }
  return `team-${randomUUID().slice(0, 8)}`;
}
