import { and, eq, isNull, sql } from 'drizzle-orm';
import { Injectable, NotFoundException } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { EventBus, EngineEvents } from '../../common/events/event-bus';
import { ApiError } from '../../common/http/api-error';
import { legacyTenants } from '../../common/infra/db/legacy-schema';
import { getOrgBrief } from './org-info';
import { ProjectsService } from './projects.service';
import { orgSettings, projects } from './schema';

/**
 * Org profile + settings (eng-0009). The org's identity row is the
 * Python-owned `tenants` table (name, slug, region, retention) — the engine
 * writes name/region/retention through the documented dual-write seam
 * (same family as the deletion features-jsonb mark; DDL stays Python's
 * until handover A-1). Engine-owned presentation state (branding, support
 * email, default project, workspace preferences) lives in org_settings,
 * created lazily on first write.
 */
export interface BrandingInput {
  logo_dataurl?: string | null;
  brand_color?: string | null;
}

export interface PreferencesInput {
  default_runtime?: string;
  audit_retention_days?: number;
  log_retention_days?: number;
  auto_rollback?: boolean;
  canary_percentage?: number;
  /**
   * P3 (ai-native-review.md memory governance): semantic-memory PII posture.
   * off = current behavior (store verbatim); redact = store redacted +
   * audit the match count (never content); block = refuse PII-bearing
   * memories with 422. Absent = off (no behavior change for existing orgs).
   */
  memory_pii_scrubbing?: 'off' | 'redact' | 'block';
  /**
   * P3: default TTL (seconds) for new memory items lacking an explicit
   * expiry. Bounded 1h–10y. Absent = immortal unless set per item.
   */
  memory_ttl_default_seconds?: number;
}

const LOGO_MAX_CHARS = 2_000_000; // data URL, ~1.4MB binary after base64
const BRAND_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const ALLOWED_RUNTIMES = ['cloud', 'hybrid', 'byoc'];
const RETENTION_BOUNDS = { min: 1, max: 3650 };

@Injectable()
export class OrgSettingsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly projectsService: ProjectsService,
  ) {}

  /** The org profile the settings page renders (tenants row + settings + summary). */
  async profile(orgId: string): Promise<{
    org: {
      id: string;
      name: string;
      slug: string;
      region: string | null;
      retentionDays: number | null;
      createdAt: string | null;
      markedDeleted: boolean;
    };
    settings: {
      supportEmail: string | null;
      defaultProjectId: string | null;
      defaultProjectName: string | null;
      branding: Record<string, unknown>;
      preferences: Record<string, unknown>;
    };
  }> {
    const brief = await getOrgBrief(this.db, orgId);
    if (!brief) {
      throw new NotFoundException('organization');
    }
    const tenant = await this.db.root.execute<{
      region: string | null;
      retention_days: number | null;
    }>(sql`
      select region, retention_days from tenants where id = ${orgId} limit 1
    `);
    const settings = await this.ensureRow(orgId);
    const defaultProject = settings.defaultProjectId
      ? await this.projectsService.get(orgId, settings.defaultProjectId).catch(() => null)
      : null;
    return {
      org: {
        id: brief.id,
        name: brief.name,
        slug: brief.slug,
        region: tenant.rows[0]?.region ?? null,
        retentionDays: tenant.rows[0]?.retention_days ?? null,
        createdAt: brief.createdAt,
        markedDeleted: brief.markedDeleted,
      },
      settings: {
        supportEmail: settings.supportEmail ?? null,
        defaultProjectId: settings.defaultProjectId ?? null,
        defaultProjectName: defaultProject?.name ?? null,
        branding: (settings.branding ?? {}) as Record<string, unknown>,
        preferences: (settings.preferences ?? {}) as Record<string, unknown>,
      },
    };
  }

  /**
   * Patch profile + settings. Name/region/retention ride the tenants seam
   * (each change audited with from→to); presentation state upserts into
   * org_settings. The default project must be an active project of the org.
   */
  async update(input: {
    orgId: string;
    actorId: string;
    name?: string;
    region?: string;
    retentionDays?: number;
    supportEmail?: string | null;
    defaultProjectId?: string | null;
    branding?: BrandingInput;
    preferences?: PreferencesInput;
  }): Promise<void> {
    const changes: Record<string, unknown> = {};

    if (input.name !== undefined) {
      const name = input.name.trim().slice(0, 256);
      if (name.length < 1) {
        throw ApiError.validation({ name: 'organization name is required' });
      }
      const current = await getOrgBrief(this.db, input.orgId);
      if (!current) {
        throw ApiError.notFound('organization');
      }
      if (name !== current.name) {
        await this.db.root
          .update(legacyTenants)
          .set({ name, updated_at: new Date().toISOString() })
          .where(eq(legacyTenants.id, input.orgId));
        changes.name = { from: current.name, to: name };
      }
    }

    if (input.region !== undefined || input.retentionDays !== undefined) {
      const current = await this.db.root.execute<{
        region: string | null;
        retention_days: number | null;
      }>(sql`
        select region, retention_days from tenants where id = ${input.orgId} limit 1
      `);
      const tenantUpdate: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (input.region !== undefined) {
        const region = input.region.trim().slice(0, 32);
        if (region.length < 1) {
          throw ApiError.validation({ region: 'region cannot be empty when provided' });
        }
        tenantUpdate.region = region;
        if (region !== current.rows[0]?.region) {
          changes.region = { from: current.rows[0]?.region ?? null, to: region };
        }
      }
      if (input.retentionDays !== undefined) {
        const days = Math.floor(input.retentionDays);
        if (days < RETENTION_BOUNDS.min || days > RETENTION_BOUNDS.max) {
          throw ApiError.validation({
            retention_days: `must be ${RETENTION_BOUNDS.min}–${RETENTION_BOUNDS.max} days`,
          });
        }
        tenantUpdate.retentionDays = days;
        if (days !== current.rows[0]?.retention_days) {
          changes.retention_days = { from: current.rows[0]?.retention_days ?? null, to: days };
        }
      }
      await this.db.root
        .update(legacyTenants)
        .set(tenantUpdate)
        .where(eq(legacyTenants.id, input.orgId));
    }

    const settingsUpdate: Record<string, unknown> = {};
    if (input.supportEmail !== undefined) {
      if (input.supportEmail === null || input.supportEmail === '') {
        settingsUpdate.supportEmail = null;
      } else {
        const email = input.supportEmail.trim().toLowerCase();
        if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          throw ApiError.validation({ support_email: 'must be a valid email address' });
        }
        settingsUpdate.supportEmail = email;
      }
      changes.support_email = settingsUpdate.supportEmail;
    }

    if (input.defaultProjectId !== undefined) {
      if (input.defaultProjectId === null || input.defaultProjectId === '') {
        settingsUpdate.defaultProjectId = null;
        changes.default_project_id = null;
      } else {
        const project = await this.db.withOrg(input.orgId, (tx) =>
          tx
            .select({ id: projects.id, name: projects.name })
            .from(projects)
            .where(
              and(
                eq(projects.id, input.defaultProjectId!),
                eq(projects.orgId, input.orgId),
                isNull(projects.archivedAt),
              ),
            )
            .limit(1),
        );
        if (!project[0]) {
          throw ApiError.validation({
            default_project_id: 'must be an active project in this organization',
          });
        }
        settingsUpdate.defaultProjectId = input.defaultProjectId;
        changes.default_project_id = input.defaultProjectId;
      }
    }

    if (input.branding !== undefined) {
      const current = await this.ensureRow(input.orgId);
      const branding = {
        ...((current.branding ?? {}) as Record<string, unknown>),
        ...this.validateBranding(input.branding),
      };
      // Explicit null clears a key (the validator omits cleared keys — drop them here).
      for (const key of ['logo_dataurl', 'brand_color'] as const) {
        if (input.branding[key] === null || input.branding[key] === '') {
          delete branding[key];
        }
      }
      settingsUpdate.branding = branding;
      changes.branding_keys = Object.keys(branding);
    }

    if (input.preferences !== undefined) {
      const current = await this.ensureRow(input.orgId);
      const preferences = {
        ...((current.preferences ?? {}) as Record<string, unknown>),
        ...this.validatePreferences(input.preferences),
      };
      settingsUpdate.preferences = preferences;
      changes.preferences_keys = Object.keys(preferences);
    }

    if (Object.keys(settingsUpdate).length > 0) {
      settingsUpdate.updatedAt = new Date().toISOString();
      await this.db.withOrg(input.orgId, (tx) =>
        tx
          .insert(orgSettings)
          .values({ orgId: input.orgId, ...settingsUpdate } as typeof orgSettings.$inferInsert)
          .onConflictDoUpdate({ target: orgSettings.orgId, set: settingsUpdate as never }),
      );
    }

    if (Object.keys(changes).length > 0) {
      await this.audit.add({
        action: 'org.settings_updated',
        resourceType: 'tenant',
        resourceId: input.orgId,
        actorType: 'account',
        actorId: input.actorId,
        tenantId: input.orgId,
        details: changes,
      });
      await this.events.emit(EngineEvents.OrgSettingsUpdated, {
        orgId: input.orgId,
        keys: Object.keys(changes),
      });
    }
  }

  /** Settings row read (creating the lazy default on first touch). */
  async ensureRow(orgId: string): Promise<typeof orgSettings.$inferSelect> {
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

  private validateBranding(input: BrandingInput): Record<string, string> {
    const branding: Record<string, string> = {};
    if (
      input.logo_dataurl !== undefined &&
      input.logo_dataurl !== null &&
      input.logo_dataurl !== ''
    ) {
      if (!/^data:image\/(png|jpe?g|webp|svg\+xml);base64,/i.test(input.logo_dataurl)) {
        throw ApiError.validation({
          'branding.logo_dataurl': 'must be a data URL for png/jpeg/webp/svg image',
        });
      }
      if (input.logo_dataurl.length > LOGO_MAX_CHARS) {
        throw ApiError.validation({ 'branding.logo_dataurl': 'logo exceeds the 2MB limit' });
      }
      branding.logo_dataurl = input.logo_dataurl;
    }
    if (input.brand_color !== undefined && input.brand_color !== null && input.brand_color !== '') {
      if (!BRAND_COLOR_RE.test(input.brand_color)) {
        throw ApiError.validation({ 'branding.brand_color': 'must be a hex color like #4f46e5' });
      }
      branding.brand_color = input.brand_color.toLowerCase();
    }
    return branding;
  }

  private validatePreferences(input: PreferencesInput): Record<string, unknown> {
    const preferences: Record<string, unknown> = {};
    if (input.default_runtime !== undefined) {
      if (!ALLOWED_RUNTIMES.includes(input.default_runtime)) {
        throw ApiError.validation({
          'preferences.default_runtime': `must be one of ${ALLOWED_RUNTIMES.join(', ')}`,
        });
      }
      preferences.default_runtime = input.default_runtime;
    }
    for (const key of ['audit_retention_days', 'log_retention_days'] as const) {
      const value = input[key];
      if (value !== undefined) {
        const days = Math.floor(value);
        if (days < RETENTION_BOUNDS.min || days > RETENTION_BOUNDS.max) {
          throw ApiError.validation({
            [`preferences.${key}`]: `must be ${RETENTION_BOUNDS.min}–${RETENTION_BOUNDS.max} days`,
          });
        }
        preferences[key] = days;
      }
    }
    if (input.auto_rollback !== undefined) {
      preferences.auto_rollback = input.auto_rollback;
    }
    if (input.canary_percentage !== undefined) {
      const pct = input.canary_percentage;
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
        throw ApiError.validation({ 'preferences.canary_percentage': 'must be 0–100' });
      }
      preferences.canary_percentage = pct;
    }
    if (input.memory_pii_scrubbing !== undefined) {
      if (
        input.memory_pii_scrubbing !== 'off' &&
        input.memory_pii_scrubbing !== 'redact' &&
        input.memory_pii_scrubbing !== 'block'
      ) {
        throw ApiError.validation({
          'preferences.memory_pii_scrubbing': 'must be off, redact, or block',
        });
      }
      preferences.memory_pii_scrubbing = input.memory_pii_scrubbing;
    }
    if (input.memory_ttl_default_seconds !== undefined) {
      const seconds = Math.floor(input.memory_ttl_default_seconds);
      if (!Number.isFinite(seconds) || seconds < 3600 || seconds > 315_360_000) {
        throw ApiError.validation({
          'preferences.memory_ttl_default_seconds': 'must be 3600–315360000 seconds (1h–10y)',
        });
      }
      preferences.memory_ttl_default_seconds = seconds;
    }
    return preferences;
  }
}
