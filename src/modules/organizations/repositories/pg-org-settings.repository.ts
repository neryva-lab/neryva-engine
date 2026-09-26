import { eq } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { orgSettings } from '../schema';
import type { IOrgSettingsRepository, OrgSettingsRow } from './org-settings.repository';

/**
 * PostgreSQL implementation of `IOrgSettingsRepository` (P3) — the
 * engine-owned `org_settings` row only. The Python-owned `tenants` seam is
 * NOT here; it goes through `IOrgInfoRepository` in the service.
 *
 * Mechanical move of the `OrgSettingsService` persistence units: every
 * method owns its transaction via `DbService.withOrg`, runs all reads/writes
 * inside it, and commits or rolls back as one. No transaction handle leaks
 * through this interface.
 *
 * What stays OUT (still the caller's job): input validation, the
 * default-project active check, tenants-seam reads/writes, from→to audit
 * diffing, audit writes, event emission.
 */
export class PgOrgSettingsRepository implements IOrgSettingsRepository {
  constructor(private readonly db: DbService) {}

  /**
   * Settings row read, creating the lazy default on first touch:
   * insert-if-absent, then read. An existing row is returned untouched.
   */
  async ensureRow(orgId: string): Promise<OrgSettingsRow> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .insert(orgSettings)
        .values({ orgId })
        .onConflictDoNothing({ target: orgSettings.orgId })
        .returning(),
    );
    if (rows[0]) {
      return rows[0];
    }
    const existing = await this.db.withOrg(orgId, (tx) =>
      tx.select().from(orgSettings).where(eq(orgSettings.orgId, orgId)).limit(1),
    );
    return existing[0];
  }

  /**
   * Upsert presentation state — only the keys the caller supplies move
   * (plus `updatedAt`, always). Branding/preferences arrive pre-merged by
   * the service; the repository sets them whole.
   */
  async updateSettings(
    orgId: string,
    update: {
      supportEmail?: string | null;
      defaultProjectId?: string | null;
      branding?: Record<string, unknown>;
      preferences?: Record<string, unknown>;
      updatedAt: string;
    },
  ): Promise<void> {
    const settingsUpdate: Record<string, unknown> = { updatedAt: update.updatedAt };
    if (update.supportEmail !== undefined) {
      settingsUpdate.supportEmail = update.supportEmail;
    }
    if (update.defaultProjectId !== undefined) {
      settingsUpdate.defaultProjectId = update.defaultProjectId;
    }
    if (update.branding !== undefined) {
      settingsUpdate.branding = update.branding;
    }
    if (update.preferences !== undefined) {
      settingsUpdate.preferences = update.preferences;
    }
    await this.db.withOrg(orgId, (tx) =>
      tx
        .insert(orgSettings)
        .values({ orgId, ...settingsUpdate } as typeof orgSettings.$inferInsert)
        .onConflictDoUpdate({ target: orgSettings.orgId, set: settingsUpdate as never }),
    );
  }
}
