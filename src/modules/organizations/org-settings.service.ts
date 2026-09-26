import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { EventBus, EngineEvents } from '../../common/events/event-bus';
import { ApiError } from '../../common/http/api-error';
import { ProjectsService } from './projects.service';
import { ORG_INFO_REPOSITORY, ORG_SETTINGS_REPOSITORY } from './repositories/repository-tokens';
import type { IOrgInfoRepository } from './repositories/org-info.repository';
import type { IOrgSettingsRepository } from './repositories/org-settings.repository';
import type { orgSettings } from './schema';
import type { ProjectRow } from './repositories/project.repository';

/**
 * Org profile + settings (eng-0009). The org's identity row is the
 * Python-owned `tenants` table (name, slug, region, retention) — the engine
 * writes name/region/retention through `IOrgInfoRepository` (the documented
 * dual-write seam; DDL stays Python's until handover A-1). Engine-owned
 * presentation state (branding, support email, default project, workspace
 * preferences) lives in org_settings, created lazily on first write.
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
    @Inject(ORG_SETTINGS_REPOSITORY) private readonly settings: IOrgSettingsRepository,
    @Inject(ORG_INFO_REPOSITORY) private readonly orgInfo: IOrgInfoRepository,
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
    const brief = await this.orgInfo.getBrief(orgId);
    if (!brief) {
      throw new NotFoundException('organization');
    }
    const tenant = await this.orgInfo.getTenantFields(orgId);
    const settings = await this.ensureRow(orgId);
    const defaultProject = settings.defaultProjectId
      ? await this.projectsService.get(orgId, settings.defaultProjectId).catch(() => null)
      : null;
    return {
      org: {
        id: brief.id,
        name: brief.name,
        slug: brief.slug,
        region: tenant?.region ?? null,
        retentionDays: tenant?.retentionDays ?? null,
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
      const current = await this.orgInfo.getBrief(input.orgId);
      if (!current) {
        throw ApiError.notFound('organization');
      }
      if (name !== current.name) {
        await this.orgInfo.updateTenantProfile(input.orgId, { name });
        changes.name = { from: current.name, to: name };
      }
    }

    if (input.region !== undefined || input.retentionDays !== undefined) {
      // Read-before-write: the current tenant fields drive the from→to
      // audit diff (the pg lane read them in the same transaction).
      const current = await this.orgInfo.getTenantFields(input.orgId);
      const patch: { region?: string; retentionDays?: number } = {};
      if (input.region !== undefined) {
        const region = input.region.trim().slice(0, 32);
        if (region.length < 1) {
          throw ApiError.validation({ region: 'region cannot be empty when provided' });
        }
        patch.region = region;
        if (region !== current?.region) {
          changes.region = { from: current?.region ?? null, to: region };
        }
      }
      if (input.retentionDays !== undefined) {
        const days = Math.floor(input.retentionDays);
        if (days < RETENTION_BOUNDS.min || days > RETENTION_BOUNDS.max) {
          throw ApiError.validation({
            retention_days: `must be ${RETENTION_BOUNDS.min}–${RETENTION_BOUNDS.max} days`,
          });
        }
        // The pg lane maps this to the `retention_days` column (the old
        // service's `tenantUpdate.retentionDays` property never matched the
        // legacy schema — the contract's pg implementation maps it
        // correctly).
        patch.retentionDays = days;
        if (days !== current?.retentionDays) {
          changes.retention_days = { from: current?.retentionDays ?? null, to: days };
        }
      }
      await this.orgInfo.updateTenantProfile(input.orgId, patch);
    }

    const settingsUpdate: {
      supportEmail?: string | null;
      defaultProjectId?: string | null;
      branding?: Record<string, unknown>;
      preferences?: Record<string, unknown>;
    } = {};
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
        // No direct projects persistence here — the check goes through
        // ProjectsService (same read the controllers use). Only
        // NotFoundException maps to the validation error; anything else
        // (a persistence failure) propagates like the original.
        let project: ProjectRow | null = null;
        try {
          project = await this.projectsService.get(input.orgId, input.defaultProjectId);
        } catch (err) {
          if (!(err instanceof NotFoundException)) {
            throw err;
          }
        }
        if (!project || project.archivedAt) {
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
      await this.settings.updateSettings(input.orgId, {
        ...settingsUpdate,
        updatedAt: new Date().toISOString(),
      });
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
    return this.settings.ensureRow(orgId);
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
