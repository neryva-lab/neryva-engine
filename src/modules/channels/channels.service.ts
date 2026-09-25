import { and, desc, eq, sql } from 'drizzle-orm';
import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { env, isProduction } from '../../common/config/env';
import { uuidv7 } from '../../common/ids/uuidv7';
import { envelopeDecrypt, envelopeEncrypt, randomToken, constantTimeEquals } from '../../common/infra/crypto/envelope';
import { EntitlementsService } from '../organizations/entitlements.service';
import { TemplatesService as AssistantTemplatesService } from '../assistants/templates.service';
import { assistants } from '../assistants/schema';
import { channelAccounts, channelSessions, ChannelAccount, ChannelConfig, CHANNEL_PLATFORMS } from './schema';
import { assertAllowedDomainFormat, assertCredentialsShape, isUuid, META_GRAPH_VERSION, NK_KEY_PREFIX } from './dto';
import { pgViolation } from '../../common/infra/db/pg-types';

/**
 * The DB never returns raw 23505s — an (org, platform, display_name)
 * collision is a client conflict the console can explain.
 */
function mapAccountUniqueViolation(err: unknown): never {
  if (pgViolation(err).code === '23505') {
    throw ApiError.conflict('a channel with this name already exists for this platform');
  }
  throw err as Error;
}

/**
 * P5-C6: the dto assertion helpers (assertCredentialsShape,
 * assertAllowedDomainFormat) throw plain Errors, which Fastify renders as
 * HTTP 500. Customer input problems must be 400s the console can explain.
 */
export function mapInputValidation(err: unknown): never {
  if (err instanceof ApiError) throw err;
  throw ApiError.validation({ input: (err as Error).message });
}

/**
 * P5-C9 regression guard: `update()` must persist the merged ChannelConfig —
 * NOT the `{ platform, config }` wrapper `sanitizeConfigForUpdate` returns
 * (storing the wrapper corrupted account configs into
 * `{ config: {...}, platform: 'web' }`, silently dropping
 * `default_assistant_id`/`allowed_domains` and killing the widget with
 * "widget account has no assistant configured"). Pure so it is unit-testable.
 */
export function storedConfigForUpdate(
  resolved: { platform: string; config: ChannelConfig } | undefined,
): ChannelConfig | undefined {
  return resolved?.config;
}

/**
 * Channel accounts — the console CRUD surface for the channel plane (Phase C1).
 * Credentials are sealed with the AES-256-GCM envelope at WRITE time and are
 * NEVER returned by any API (only rotate/verify touch them, server-side).
 * Every privileged mutation is audited with ids only.
 */
@Injectable()
export class ChannelsService {
  private static readonly logger = new Logger(ChannelsService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
    private readonly assistantTemplates: AssistantTemplatesService,
  ) {}

  // ── CRUD ──────────────────────────────────────────────────────────────────

  async create(input: { orgId: string; platform: string; displayName: string; credentials: Record<string, unknown>; config?: Record<string, unknown>; actor: string }): Promise<ChannelAccount> {
    if (!isUuid(input.orgId)) {
      throw ApiError.validation({ orgId: 'must be a uuid' });
    }
    if (!(CHANNEL_PLATFORMS as readonly string[]).includes(input.platform)) {
      throw ApiError.validation({ platform: `must be one of ${CHANNEL_PLATFORMS.join(', ')}` });
    }
    try {
      assertCredentialsShape(input.platform, input.credentials);
    } catch (err) {
      mapInputValidation(err);
    }
    const config = this.sanitizeConfig(input.platform, input.config);
    if (!config.default_assistant_id || !isUuid(config.default_assistant_id)) {
      throw ApiError.validation({ config: 'default_assistant_id is required — channel conversations pin the account assistant' });
    }
    await this.assertAssistantRoutable(input.orgId, input.platform, config.default_assistant_id);

    // Entitlement overlay: an explicit `channels` entitlement governs caps;
    // otherwise the env default applies. Denials are deterministic (no
    // billing-provider call on this path — Phase 8.9 discipline).
    const limits = await this.entitlements.effectiveLimits(input.orgId, 'channels');
    if (limits.read_only === true || limits.entitled === false) {
      throw ApiError.forbidden('channels are not entitled for this organization');
    }
    const cap = typeof limits.max_accounts === 'number' ? limits.max_accounts : env.CHANNELS__MAX_ACCOUNTS_PER_ORG;

    const sealed = this.sealCredentials(input.platform, input.credentials);
    const accountId = uuidv7();
    let row: ChannelAccount;
    try {
      row = await this.db.withOrg(input.orgId, async (tx) => {
      const countRows = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(channelAccounts)
        .where(and(eq(channelAccounts.organizationId, input.orgId), sql`${channelAccounts.status} <> 'suspended'`));
      if (Number(countRows[0]?.n ?? 0) >= cap) {
        throw ApiError.conflict(`channel account cap reached (${cap})`, { cap });
      }
      const verifyToken = input.platform === 'whatsapp' || input.platform === 'messenger' ? randomToken(18) : null;
      const publicKey = input.platform === 'web' ? NK_KEY_PREFIX + randomToken(18) : null;
      const rows = await tx
        .insert(channelAccounts)
        .values({
          id: accountId,
          organizationId: input.orgId,
          platform: input.platform,
          displayName: input.displayName,
          publicKey,
          credentialsSealed: sealed as never,
          verifyTokenSealed: verifyToken ? envelopeEncrypt(verifyToken) : null,
          config: config as never,
          status: 'pending',
          createdBy: input.actor,
        })
        .returning();
      return rows[0];
      });
    } catch (err) {
      mapAccountUniqueViolation(err);
    }
    await this.audit.add({
      action: 'channel.account_created',
      resourceType: 'channel_account',
      resourceId: row.id,
      actorType: 'account',
      actorId: input.actor,
      tenantId: input.orgId,
      details: { platform: row.platform, display_name: row.displayName },
    });
    return row;
  }

  async get(orgId: string, accountId: string): Promise<ChannelAccount | null> {
    assertUuid2(orgId, accountId);
    const rows = await this.db.withOrg(orgId, (tx) => tx.select().from(channelAccounts).where(eq(channelAccounts.id, accountId)).limit(1));
    return rows[0] ?? null;
  }

  async list(orgId: string): Promise<ChannelAccount[]> {
    if (!isUuid(orgId)) {
      throw ApiError.validation({ orgId: 'must be a uuid' });
    }
    return this.db.withOrg(orgId, (tx) =>
      tx.select().from(channelAccounts).where(eq(channelAccounts.organizationId, orgId)).orderBy(desc(channelAccounts.updatedAt)).limit(200),
    );
  }

  /** Public (never-secret) projection for console responses. */
  toPublicView(account: ChannelAccount, extra: { webhook_url?: string } = {}): Record<string, unknown> {
    return {
      id: account.id,
      platform: account.platform,
      display_name: account.displayName,
      public_key: account.publicKey,
      status: account.status,
      health: account.health,
      config: account.config,
      webhook_url: extra.webhook_url,
      created_at: account.createdAt,
      updated_at: account.updatedAt,
    };
  }

  async update(input: { orgId: string; accountId: string; displayName?: string; status?: 'active' | 'suspended'; config?: Record<string, unknown>; actor: string }): Promise<ChannelAccount> {
    assertUuid2(input.orgId, input.accountId);
    const resolved = input.config !== undefined ? await this.sanitizeConfigForUpdate(input.orgId, input.accountId, input.config) : undefined;
    // P5-C9: persist the merged ChannelConfig — never the { platform, config } wrapper.
    const config = storedConfigForUpdate(resolved);
    if (config?.default_assistant_id) {
      await this.assertAssistantRoutable(input.orgId, resolved?.platform ?? '', config.default_assistant_id);
    }
    let rows: ChannelAccount[];
    try {
      rows = await this.db.withOrg(input.orgId, (tx) =>
        tx
          .update(channelAccounts)
          .set({
            ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
            ...(input.status !== undefined ? { status: input.status } : {}),
            ...(config !== undefined ? { config: config as never } : {}),
            updatedAt: new Date().toISOString(),
          })
          .where(and(eq(channelAccounts.id, input.accountId), eq(channelAccounts.organizationId, input.orgId)))
          .returning(),
      );
    } catch (err) {
      mapAccountUniqueViolation(err);
    }
    if (rows.length === 0) {
      throw ApiError.notFound('channel account');
    }
    await this.audit.add({
      action: 'channel.account_updated',
      resourceType: 'channel_account',
      resourceId: input.accountId,
      actorType: 'account',
      actorId: input.actor,
      tenantId: input.orgId,
      details: { fields: [input.displayName !== undefined && 'display_name', input.status !== undefined && 'status', config !== undefined && 'config'].filter(Boolean) },
    });
    return rows[0];
  }

  async deactivate(input: { orgId: string; accountId: string; actor: string }): Promise<void> {
    assertUuid2(input.orgId, input.accountId);
    await this.db.withOrg(input.orgId, async (tx) => {
      const rows = await tx
        .update(channelAccounts)
        .set({
          status: 'suspended',
          // Credentials are destroyed on deactivate — reconnect re-seals.
          credentialsSealed: {},
          verifyTokenSealed: null,
          updatedAt: new Date().toISOString(),
        })
        .where(and(eq(channelAccounts.id, input.accountId), eq(channelAccounts.organizationId, input.orgId)))
        .returning({ id: channelAccounts.id });
      if (rows.length === 0) {
        throw ApiError.notFound('channel account');
      }
      // Widget sessions die with the account.
      await tx.update(channelSessions).set({ status: 'revoked', expiresAt: new Date().toISOString() }).where(eq(channelSessions.channelAccountId, input.accountId));
    });
    await this.audit.add({
      action: 'channel.account_deactivated',
      resourceType: 'channel_account',
      resourceId: input.accountId,
      actorType: 'account',
      actorId: input.actor,
      tenantId: input.orgId,
      details: {},
    });
  }

  // ── Credentials rotation + platform verification ─────────────────────────

  async rotateCredentials(input: { orgId: string; accountId: string; credentials: Record<string, unknown>; actor: string }): Promise<ChannelAccount> {
    assertUuid2(input.orgId, input.accountId);
    const account = await this.get(input.orgId, input.accountId);
    if (!account) {
      throw ApiError.notFound('channel account');
    }
    try {
      assertCredentialsShape(account.platform, input.credentials);
    } catch (err) {
      mapInputValidation(err);
    }
    const sealed = this.sealCredentials(account.platform, input.credentials);
    // New Meta verify token on rotation — the old one dies with the secret.
    const verifyToken = account.platform === 'whatsapp' || account.platform === 'messenger' ? randomToken(18) : null;
    // P5-C8: web has no credentials to verify (assertCredentialsShape accepts
    // {} and verifyCredentials is a trivial pass), so forcing pending on a web
    // rotation took a live channel offline for zero security benefit. Rotation
    // stays a no-op status-wise for web; credential-bearing platforms still go
    // pending until the new material is verified.
    const reverify = account.platform !== 'web';
    const rows = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .update(channelAccounts)
        .set({
          credentialsSealed: sealed as never,
          ...(verifyToken ? { verifyTokenSealed: envelopeEncrypt(verifyToken) } : {}),
          ...(reverify ? { status: 'pending', health: { last_verified: null } } : {}),
          updatedAt: new Date().toISOString(),
        })
        .where(and(eq(channelAccounts.id, input.accountId), eq(channelAccounts.organizationId, input.orgId)))
        .returning(),
    );
    await this.audit.add({
      action: 'channel.credentials_rotated',
      resourceType: 'channel_account',
      resourceId: input.accountId,
      actorType: 'account',
      actorId: input.actor,
      tenantId: input.orgId,
      details: { platform: account.platform },
    });
    return rows[0];
  }

  /**
   * Probe the platform API with the sealed credentials (5s deadline).
   * Updates `health`; a failing probe marks the account degraded but never
   * throws raw provider errors — the caller sees ok/message only.
   */
  async verifyCredentials(input: { orgId: string; accountId: string; actor: string }): Promise<{ ok: boolean; message: string; health: Record<string, unknown> }> {
    assertUuid2(input.orgId, input.accountId);
    const account = await this.get(input.orgId, input.accountId);
    if (!account) {
      throw ApiError.notFound('channel account');
    }
    const creds = this.decryptCredentials(account);
    let ok = false;
    let message = 'unverified';
    try {
      switch (account.platform) {
        case 'whatsapp': {
          const res = await this.fetchWithDeadline(`https://graph.facebook.com/${META_GRAPH_VERSION}/${String(creds.phone_number_id)}?access_token=${encodeURIComponent(String(creds.access_token))}`);
          ok = res.ok;
          message = ok ? `phone_number_id verified (${String((res.body as { display_phone_number?: string }).display_phone_number ?? 'ok')})` : `graph error ${(res.body as { error?: { message?: string } }).error?.message ?? res.status}`;
          break;
        }
        case 'messenger': {
          const res = await this.fetchWithDeadline(`https://graph.facebook.com/${META_GRAPH_VERSION}/me?access_token=${encodeURIComponent(String(creds.access_token))}`);
          ok = res.ok;
          message = ok ? `page verified (${String((res.body as { name?: string }).name ?? 'ok')})` : `graph error ${(res.body as { error?: { message?: string } }).error?.message ?? res.status}`;
          break;
        }
        case 'telegram': {
          const res = await this.fetchWithDeadline(`https://api.telegram.org/bot${String(creds.bot_token)}/getMe`);
          ok = res.ok && (res.body as { ok?: boolean }).ok === true;
          message = ok ? `bot verified (@${String((res.body as { result?: { username?: string } }).result?.username ?? 'ok')})` : `telegram error ${res.status}`;
          break;
        }
        case 'web': {
          ok = true;
          message = 'web widget needs no credentials';
          break;
        }
        default:
          message = `unsupported platform ${account.platform}`;
      }
    } catch (err) {
      ok = false;
      message = `probe failed: ${(err as Error).message.slice(0, 200)}`;
    }
    const health = { last_verified: new Date().toISOString(), ok, message: message.slice(0, 250) };
    await this.db.withOrg(input.orgId, (tx) =>
      tx.update(channelAccounts).set({ health: health as never, ...(ok ? { status: 'active' } : {}), updatedAt: new Date().toISOString() }).where(eq(channelAccounts.id, account.id)),
    );
    await this.audit.add({
      action: 'channel.credentials_verified',
      resourceType: 'channel_account',
      resourceId: account.id,
      actorType: 'account',
      actorId: input.actor,
      tenantId: input.orgId,
      details: { ok },
    });
    return { ok, message, health };
  }

  /**
   * Telegram webhook registration is Engine-driven: setWebhook with the
   * Engine's public URL + a per-account secret_token (sealed). Meta webhooks
   * are configured in the Meta App dashboard — the console displays the URL
   * + verify token instead.
   */
  async setupWebhook(input: { orgId: string; accountId: string; actor: string }): Promise<{ webhook_url: string; verify_token?: string; registered?: boolean }> {
    assertUuid2(input.orgId, input.accountId);
    const account = await this.get(input.orgId, input.accountId);
    if (!account) {
      throw ApiError.notFound('channel account');
    }
    const webhookUrl = `${env.ENGINE_BASE_URL.replace(/\/$/, '')}/webhooks/channels/${account.platform}/${account.id}`;
    if (account.platform === 'telegram') {
      const creds = this.decryptCredentials(account);
      const res = await this.fetchWithDeadline(`https://api.telegram.org/bot${String(creds.bot_token)}/setWebhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: webhookUrl, secret_token: String(creds.webhook_secret), allowed_updates: ['message'], drop_pending_updates: false }),
      });
      if (!res.ok || (res.body as { ok?: boolean }).ok !== true) {
        throw ApiError.internal();
      }
      await this.audit.add({
        action: 'channel.webhook_registered',
        resourceType: 'channel_account',
        resourceId: account.id,
        actorType: 'account',
        actorId: input.actor,
        tenantId: input.orgId,
        details: { platform: 'telegram' },
      });
      return { webhook_url: webhookUrl, registered: true };
    }
    if (account.platform === 'whatsapp' || account.platform === 'messenger') {
      if (!account.verifyTokenSealed) {
        throw ApiError.conflict('verify token missing — rotate credentials first');
      }
      return { webhook_url: webhookUrl, verify_token: envelopeDecrypt(account.verifyTokenSealed) };
    }
    return { webhook_url: webhookUrl };
  }

  // ── Ingest-side resolution (public webhook path; narrow bypass) ──────────

  /**
   * Resolve an account by id for the signature-verified webhook path.
   * Same FORCE-RLS root-read class as getByPublicKey (G1 live-verification
   * fix): the webhook signature already authenticated the call, and the read
   * filters by exact id — bypass vehicle with per-call justification, not a
   * tenant scan.
   */
  async getByIdForIngest(accountId: string): Promise<ChannelAccount | null> {
    if (!isUuid(accountId)) {
      return null;
    }
    const rows = await this.db.withBypass((tx) => tx.select().from(channelAccounts).where(eq(channelAccounts.id, accountId)).limit(1));
    return rows[0] ?? null;
  }

  /**
   * Resolve a widget account by its public key.
   *
   * G1 live-verification fix: this ran on `db.root`, but channel_accounts
   * carries FORCE ROW LEVEL SECURITY with a tenant-or-bypass policy and root
   * sets NEITHER — every public widget lookup returned null, so the entire
   * public widget plane (session/messages/embed) 404d for every account.
   * The bypass is correct here, not a hole: the caller is anonymous by
   * design, the public key IS the unguessable capability (`nk_live_` + 128
   * bits), and the read filters by it exactly (single row, no enumeration).
   */
  async getByPublicKey(publicKey: string): Promise<ChannelAccount | null> {
    if (typeof publicKey !== 'string' || publicKey.length < 10 || publicKey.length > 64) {
      return null;
    }
    const rows = await this.db.withBypass((tx) =>
      tx.select().from(channelAccounts).where(eq(channelAccounts.publicKey, publicKey)).limit(1),
    );
    return rows[0] ?? null;
  }

  decryptCredentials(account: ChannelAccount): Record<string, string> {
    const sealed = (account.credentialsSealed ?? {}) as Record<string, string>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(sealed)) {
      out[k] = envelopeDecrypt(String(v));
    }
    return out;
  }

  decryptVerifyToken(account: ChannelAccount): string | null {
    return account.verifyTokenSealed ? envelopeDecrypt(account.verifyTokenSealed) : null;
  }

  /** Constant-time verify-token check (Meta endpoint verification). */
  verifyTokenMatches(account: ChannelAccount, presented: string): boolean {
    const expected = this.decryptVerifyToken(account);
    if (!expected) {
      return false;
    }
    return constantTimeEquals(expected, presented);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private sealCredentials(platform: string, credentials: Record<string, unknown>): Record<string, string> {
    const allowed: Record<string, readonly string[]> = {
      whatsapp: ['app_secret', 'access_token', 'phone_number_id'],
      messenger: ['app_secret', 'access_token'],
      telegram: ['bot_token', 'webhook_secret'],
      web: [],
    };
    const out: Record<string, string> = {};
    for (const field of allowed[platform] ?? []) {
      const v = credentials[field];
      if (typeof v === 'string' && v.length > 0) {
        out[field] = envelopeEncrypt(v);
      }
    }
    if (platform === 'telegram' && !out.webhook_secret) {
      // Generated per account if the caller did not rotate one in.
      out.webhook_secret = envelopeEncrypt(randomToken(24));
    }
    return out;
  }

  private sanitizeConfig(platform: string, config?: Record<string, unknown>): ChannelConfig {
    const c = (config ?? {}) as ChannelConfig;
    const out: ChannelConfig = {};
    if (c.default_assistant_id !== undefined) {
      if (!isUuid(String(c.default_assistant_id))) {
        throw ApiError.validation({ 'config.default_assistant_id': 'must be a uuid' });
      }
      out.default_assistant_id = String(c.default_assistant_id);
    }
    if (platform === 'web') {
      out.allowed_domains = (c.allowed_domains ?? []).map((d) => {
        try {
          assertAllowedDomainFormat(String(d));
        } catch (err) {
          mapInputValidation(err);
        }
        return String(d).replace(/\/$/, '').toLowerCase();
      });
      if (!out.allowed_domains || out.allowed_domains.length === 0) {
        throw ApiError.validation({ 'config.allowed_domains': 'web channels require at least one origin (scheme://host)' });
      }
      if (typeof c.greeting === 'string') {
        out.greeting = c.greeting.slice(0, 500);
      }
    }
    if (platform === 'whatsapp' && c.out_of_window_template) {
      out.out_of_window_template = { name: String(c.out_of_window_template.name).slice(0, 128), language: String(c.out_of_window_template.language).slice(0, 16) };
    }
    if (platform === 'messenger' && typeof c.out_of_window_note === 'string') {
      out.out_of_window_note = c.out_of_window_note.slice(0, 500);
    }
    // P5-C10: these keys are declared in the ChannelConfig schema and read by
    // the outbound pipeline (escalation lifecycle notes, FL-2.8 quick-reply
    // chips / CSAT, FL-3.1 voice replies) — but were silently stripped here,
    // so they could never be set through create/PATCH. Clamp and pass through.
    if (typeof c.escalation_note === 'string') {
      out.escalation_note = c.escalation_note.slice(0, 500);
    }
    if (typeof c.escalation_resolved_note === 'string') {
      out.escalation_resolved_note = c.escalation_resolved_note.slice(0, 500);
    }
    if (Array.isArray(c.quick_replies)) {
      out.quick_replies = c.quick_replies
        .filter((r): r is string => typeof r === 'string' && r.length > 0)
        .slice(0, 6)
        .map((r) => r.slice(0, 64));
    }
    if (typeof c.csat_enabled === 'boolean') {
      out.csat_enabled = c.csat_enabled;
    }
    if (typeof c.voice_replies_enabled === 'boolean') {
      out.voice_replies_enabled = c.voice_replies_enabled;
    }
    return out;
  }

  /** Merge-patch config on update, re-validating the platform-specific shape. */
  private async sanitizeConfigForUpdate(
    orgId: string,
    accountId: string,
    patch: Record<string, unknown>,
  ): Promise<{ platform: string; config: ChannelConfig }> {
    const account = await this.get(orgId, accountId);
    if (!account) {
      throw ApiError.notFound('channel account');
    }
    const merged = { ...((account.config ?? {}) as ChannelConfig), ...(patch as ChannelConfig) };
    return { platform: account.platform, config: this.sanitizeConfig(account.platform, merged as Record<string, unknown>) };
  }

  /**
   * TPL-9.2 — channel↔assistant routability. Two independent gates:
   *  1. Ownership: the assistant must exist IN THIS ORG. An account pointing
   *     at a foreign org's assistant would route that org's conversations
   *     into another tenant's agent — refused as cross-tenant access.
   *  2. Template binding: a template-installed assistant whose template
   *     declares a non-empty channels list serves ONLY those channels
   *     (template channel names map to account platforms below; unmapped
   *     platforms and undeclared/manual assistants are unconstrained).
   */
  private async assertAssistantRoutable(orgId: string, platform: string, assistantId: string): Promise<void> {
    const rows = await this.db.withOrg(orgId, (tx) => tx.select({ id: assistants.id }).from(assistants).where(eq(assistants.id, assistantId)).limit(1));
    if (rows.length === 0) {
      throw ApiError.validation({ 'config.default_assistant_id': 'assistant does not exist in this organization' });
    }
    const binding = await this.assistantTemplates.resolveAssistantChannels(orgId, assistantId);
    if (!binding) {
      return;
    }
    const mapped = CHANNEL_TO_PLATFORM[platform];
    if (!mapped) {
      return;
    }
    if (!binding.channels.includes(mapped)) {
      throw ApiError.validation({
        'config.default_assistant_id': `assistant's template serves [${binding.channels.join(', ')}] — not ${mapped} (platform ${platform})`,
      });
    }
  }

  private async fetchWithDeadline(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ ok: boolean; status: number; body: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    timer.unref();
    try {
      const res = await fetch(url, { ...(init ?? {}), signal: controller.signal });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      return { ok: res.ok, status: res.status, body };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** TPL-9.2 — account platform → template channel name (CHANNEL_PLATFORMS →
 *  bindings/channels.json vocabulary; `assertAssistantRoutable` looks up by
 *  ACCOUNT platform). Platforms without a template channel (instagram/x/email)
 *  and template channels without a platform (voice) are unmapped: binding
 *  checks skip them (cannot judge), ownership checks still apply. */
const CHANNEL_TO_PLATFORM: Record<string, string> = {
  web: 'web-widget',
  whatsapp: 'whatsapp',
  messenger: 'messenger',
  telegram: 'telegram',
};

function assertUuid2(orgId: string, accountId: string): void {
  if (!isUuid(orgId)) {
    throw ApiError.validation({ orgId: 'must be a uuid' });
  }
  if (!isUuid(accountId)) {
    throw ApiError.validation({ accountId: 'must be a uuid' });
  }
}

export const CHANNEL_SESSION_COOKIE = 'nrv_channel_session';
export const CHANNEL_SESSION_COOKIE_SECURE = isProduction;
