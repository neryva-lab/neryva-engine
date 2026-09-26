import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { templatePlatformBlocks } from '../template-blocks.schema';
import type { TemplatePlatformBlock } from '../template-blocks.schema';
import type { IFleetStaffRepository } from './fleet-staff.repository';

/**
 * PostgreSQL implementation of `IFleetStaffRepository` (P3).
 *
 * Mechanical move of the `FleetStaffController` persistence units: GLOBAL,
 * staff-scoped — no `orgId` anywhere (root posture; the staff guards above
 * this layer are the access control). The cross-org install inventory runs
 * in `withBypass` (the narrow, audited lane) with a server-side row cap;
 * the registry-syncs read is the global `audit_events` chain table
 * (foreign-owned by the common audit module — read here only because the
 * staff surface observes the template release job).
 *
 * What stays OUT (still the controller's job): staff authorization
 * (guards), input validation (slug presence/shape, limit clamps), tracing
 * spans, audit writes (replayed by the controller from inputs + results),
 * 409/404 mapping (null results mean "no active block" / "none active").
 */
export class PgFleetStaffRepository implements IFleetStaffRepository {
  private static readonly LIST_CAP = 200;
  private static readonly INVENTORY_CAP = 500;

  constructor(private readonly db: DbService) {}

  /**
   * Place a platform-wide block for the slug. Returns null when an active
   * block already exists (partial unique index on (slug) where
   * lifted_at is null).
   */
  async placePlatformBlock(input: {
    slug: string;
    reason: string;
    createdBy: string;
  }): Promise<TemplatePlatformBlock | null> {
    const rows = await this.db.root
      .insert(templatePlatformBlocks)
      .values({
        id: uuidv7(),
        slug: input.slug,
        reason: input.reason,
        createdBy: input.createdBy,
      })
      .onConflictDoNothing()
      .returning();
    return rows[0] ?? null;
  }

  /**
   * Lift the active platform-wide block for the slug. Returns null when
   * none is active.
   */
  async liftPlatformBlock(input: {
    slug: string;
    liftedBy: string;
  }): Promise<TemplatePlatformBlock | null> {
    const rows = await this.db.root
      .update(templatePlatformBlocks)
      .set({ liftedAt: new Date().toISOString(), liftedBy: input.liftedBy })
      .where(
        and(eq(templatePlatformBlocks.slug, input.slug), isNull(templatePlatformBlocks.liftedAt)),
      )
      .returning();
    return rows[0] ?? null;
  }

  async listPlatformBlocks(): Promise<TemplatePlatformBlock[]> {
    return this.db.root
      .select()
      .from(templatePlatformBlocks)
      .orderBy(desc(templatePlatformBlocks.createdAt))
      .limit(PgFleetStaffRepository.LIST_CAP);
  }

  /**
   * Cross-org install-base inventory for a template slug (optionally
   * pinned to a version). Bounded server-side. `assistant_installs` is a
   * tenant-owned table — this cross-org read is deliberate staff inventory
   * (the controller audits it).
   */
  async listInstallsBySlug(
    slug: string,
    templateVersion?: string,
  ): Promise<Array<Record<string, unknown>>> {
    const rows = await this.db.withBypass((tx) =>
      tx.execute<Record<string, unknown>>(
        templateVersion
          ? sql`select i.organization_id, i.slug, i.template_version, i.assistant_id, i.installed_by, i.installed_at
               from assistant_installs i
               where i.slug = ${slug} and i.template_version = ${templateVersion}
               order by i.installed_at desc limit ${PgFleetStaffRepository.INVENTORY_CAP}`
          : sql`select i.organization_id, i.slug, i.template_version, i.assistant_id, i.installed_by, i.installed_at
               from assistant_installs i
               where i.slug = ${slug}
               order by i.installed_at desc limit ${PgFleetStaffRepository.INVENTORY_CAP}`,
      ),
    );
    return rows.rows;
  }

  /**
   * Recent `template.registry_synced` audit rows, newest first. Bounded by
   * `limit` (default 50). FOREIGN-OWNED read on the common audit module's
   * global `audit_events` chain table — no bypass needed.
   */
  async listRegistrySyncs(limit = 50): Promise<Array<Record<string, unknown>>> {
    const rows = await this.db.root.execute<Record<string, unknown>>(sql`
      select created_at, details
      from audit_events
      where action = 'template.registry_synced'
      order by created_at desc
      limit ${limit}
    `);
    return rows.rows;
  }
}
