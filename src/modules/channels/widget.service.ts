import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ApiError } from '../../common/http/api-error';
import { env } from '../../common/config/env';
import { uuidv7 } from '../../common/ids/uuidv7';
import { randomToken, sha256Hex } from '../../common/infra/crypto/envelope';
// VALUE import (not `import type`): NestJS reads this binding for
// design:paramtypes metadata — a type-only import erases it and the
// @Optional() redis would ALWAYS resolve undefined, silently disabling
// session caching even when Redis is healthy.
import { RedisService } from '../../common/infra/redis.service';
import { verifyTurnstile } from '../../common/http/turnstile';
import { ConversationsService } from '../conversations/conversations.service';
import { EscalationsService } from '../conversations/escalations.service';
import { RetentionPurgeService } from '../lifecycle/retention-purge.service';
import type { ChannelAccount, ChannelSession, ChannelConfig } from './schema';
import { CHANNEL_SESSION_REPOSITORY } from './repositories/repository-tokens';
import type { IChannelSessionRepository } from './repositories/channel-session.repository';

/**
 * Website widget plane (Phase C4). The public, unauthenticated surface — the
 * threat model is "anyone can open the page": public key only in the bundle,
 * server-minted session tokens stored as sha256 (hash-at-rest), Origin
 * allowlist per account, per-session/per-IP Redis caps, and a single
 * conversation bound to each session. Sessions NEVER accept a conversation
 * id from the client — the binding is server-side state.
 *
 * Persistence goes through `IChannelSessionRepository` (provider-blind P3
 * port). This service holds no provider, Drizzle, or SQL references.
 */

export interface WidgetSessionContext {
  session: ChannelSession;
  account: ChannelAccount;
}

@Injectable()
export class WidgetService {
  private static readonly logger = new Logger(WidgetService.name);

  constructor(
    @Inject(CHANNEL_SESSION_REPOSITORY) private readonly sessions: IChannelSessionRepository,
    private readonly conversations: ConversationsService,
    private readonly escalations: EscalationsService,
    private readonly purge: RetentionPurgeService,
    @Optional() private readonly redis?: RedisService,
  ) {}

  // ── Session lifecycle ─────────────────────────────────────────────────────

  /**
   * Mint a widget session. The raw token is returned ONCE; only its sha256
   * is stored. Turnstile (when the deployment has a secret key and the
   * account opted in) is enforced before any state is created.
   */
  async mintSession(input: { account: ChannelAccount; origin: string | null; ipHash: string | null; userAgentHash: string | null; turnstileToken?: string }): Promise<{ token: string; expiresAt: Date; config: ChannelConfig }> {
    const account = input.account;
    if (account.platform !== 'web' || account.status !== 'active') {
      throw new ApiError(404, 'not_found', 'unknown widget key');
    }
    const config = (account.config ?? {}) as ChannelConfig;
    if (!config.default_assistant_id) {
      throw new ApiError(409, 'conflict', 'widget account has no assistant configured — set config.default_assistant_id');
    }

    // Origin allowlist — exact match against the account's configured list.
    if (!input.origin || !originAllowed(config.allowed_domains ?? [], input.origin)) {
      throw new ApiError(403, 'forbidden', 'origin is not allowlisted for this widget');
    }

    // Turnstile opt-in: account config flag + deployment-level secret.
    if ((config as { turnstile_required?: boolean }).turnstile_required === true) {
      const ok = await verifyTurnstile(input.turnstileToken, null);
      if (!ok) {
        throw new ApiError(403, 'forbidden', 'captcha verification failed');
      }
    }

    // Per-IP session cap (abuse control; degrade open on Redis failure).
    if (input.ipHash && (await this.counterOver(`chan:mint:${input.ipHash}:${Math.floor(Date.now() / 3_600_000)}`, 60))) {
      throw new ApiError(429, 'rate_limited', 'too many widget sessions from this client');
    }

    const token = randomToken(32);
    const sessionId = uuidv7();
    const identityId = uuidv7();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + env.CHANNELS__WEB_SESSION_TTL_SECONDS * 1000);

    await this.sessions.mintSession({
      orgId: account.organizationId,
      accountId: account.id,
      sessionId,
      identityId,
      visitorRef: `web-visitor:${sessionId}`,
      tokenHash: sha256Hex(token),
      expiresAt: expiresAt.toISOString(),
      ipHash: input.ipHash,
      userAgentHash: input.userAgentHash,
    });

    WidgetService.logger.log(`widget session minted for account ${account.id} (origin ${input.origin})`);
    return { token, expiresAt, config };
  }

  /**
   * Resolve + touch a session from its raw token (cookie or header).
   * Same FORCE-RLS root-read class as the G1 getByPublicKey fix: sessions
   * resolve by exact token hash + account id (the token IS the capability),
   * so the bypass vehicle applies — read + sliding-TTL touch.
   */
  async resolveSession(account: ChannelAccount, token: string | undefined | null): Promise<WidgetSessionContext> {
    if (!token || token.length < 20 || token.length > 128) {
      throw new ApiError(401, 'unauthenticated', 'missing widget session');
    }
    const session = await this.sessions.findSessionByTokenHash(account.id, sha256Hex(token));
    if (!session || session.status !== 'active') {
      throw new ApiError(401, 'unauthenticated', 'widget session is not active');
    }
    if (Date.parse(session.expiresAt) <= Date.now()) {
      throw new ApiError(401, 'unauthenticated', 'widget session expired');
    }
    // Sliding TTL: extend on activity, never past mint + 24h hard cap.
    const nextExpiry = new Date(Date.now() + env.CHANNELS__WEB_SESSION_TTL_SECONDS * 1000);
    const hardCap = new Date(Date.parse(session.createdAt) + 24 * 3600 * 1000);
    const effective = nextExpiry > hardCap ? hardCap : nextExpiry;
    if (Date.parse(session.expiresAt) < effective.getTime()) {
      await this.sessions.touchSession(session.id, effective.toISOString(), new Date().toISOString());
    }
    return { session, account };
  }

  // ── Messaging ─────────────────────────────────────────────────────────────

  async sendMessage(ctx: WidgetSessionContext, input: { text: string; idempotencyKey?: string }): Promise<{ message_id: string; run_id: string | null; conversation_id: string }> {
    const text = input.text?.trim() ?? '';
    if (!text) {
      throw ApiError.validation({ text: 'must not be empty' });
    }
    if (text.length > 16_000) {
      throw ApiError.validation({ text: 'exceeds the bounded payload size' });
    }
    // Per-session hourly cap (abuse + cost control; deterministic rejection).
    const cap = env.CHANNELS__WEB_SESSION_HOURLY_MESSAGES;
    if (await this.counterOver(`chan:msg:${ctx.session.id}:${Math.floor(Date.now() / 3_600_000)}`, cap)) {
      throw new ApiError(429, 'rate_limited', 'session message limit reached for this hour');
    }

    const conversationId = await this.ensureConversation(ctx);
    const config = (ctx.account.config ?? {}) as ChannelConfig;
    if (!config.default_assistant_id) {
      throw new ApiError(409, 'conflict', 'widget account has no assistant configured');
    }
    const result = await this.conversations.acceptMessage({
      orgId: ctx.account.organizationId,
      principalId: `widget:${ctx.session.id}`,
      conversationId,
      content: { text, channel: { platform: 'web' } },
      idempotencyKey: input.idempotencyKey ? `widget:${ctx.session.id}:${input.idempotencyKey}` : undefined,
    });
    return { message_id: result.message_id, run_id: result.run_id ?? null, conversation_id: conversationId };
  }

  /** FL-1.7b - user-facing escalation from the widget. */
  async escalate(ctx: WidgetSessionContext, reason?: string): Promise<{ escalation_id: string; state: string }> {
    const conversationId = await this.sessionConversationId(ctx);
    const escalation = await this.escalations.escalate({
      orgId: ctx.account.organizationId,
      conversationId,
      reason: reason && reason.trim() ? reason.trim().slice(0, 128) : 'user_request',
      actor: `widget:${ctx.session.id}`,
    });
    return { escalation_id: escalation.id, state: escalation.state };
  }

  /** Resolve (or lazily create) the session's single conversation. */
  private async ensureConversation(ctx: WidgetSessionContext): Promise<string> {
    const config = (ctx.account.config ?? {}) as ChannelConfig;
    if (ctx.session.conversationId) {
      await this.purge.assertNotTombstoned('conversation', ctx.session.conversationId);
      // An archived conversation starts a fresh one.
      const status = await this.sessions.getConversationStatus(ctx.account.organizationId, ctx.session.conversationId);
      if (status === 'active') {
        return ctx.session.conversationId;
      }
    }
    const created = await this.conversations.createConversation({
      orgId: ctx.account.organizationId,
      assistantId: String(config.default_assistant_id),
      createdBy: `widget:${ctx.session.id}`,
      channelBinding: {
        platform: 'web',
        channel_account_id: ctx.account.id,
        channel_identity_id: ctx.session.identityId,
      },
      participantScope: 'channel',
    });
    await this.sessions.bindSessionConversation(ctx.account.organizationId, ctx.session.id, created.id);
    ctx.session.conversationId = created.id;
    return created.id;
  }

  /** Session-scoped stream authorization: the run must belong to the session's conversation. */
  async assertRunInSession(ctx: WidgetSessionContext, runId: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(runId)) {
      throw ApiError.validation({ run_id: 'must be a uuid' });
    }
    const conversationId = await this.ensureConversation(ctx);
    const runConversation = await this.sessions.getRunConversationId(ctx.account.organizationId, runId);
    if (!runConversation || runConversation !== conversationId) {
      throw new ApiError(404, 'not_found', 'unknown run');
    }
  }

  /** The session's single conversation id (creating it lazily if needed). */
  async sessionConversationId(ctx: WidgetSessionContext): Promise<string> {
    return this.ensureConversation(ctx);
  }

  /**
   * FL-3.19 — the end user's read marker: mark recent OUTBOUND assistant
   * messages in the session's conversation as `read`. Upsert per
   * (message, account, state); returns the number of rows this call added.
   */
  async markSessionRead(ctx: WidgetSessionContext, account: ChannelAccount): Promise<number> {
    const conversationId = await this.ensureConversation(ctx);
    return this.sessions.markRecentAssistantMessagesRead({
      orgId: account.organizationId,
      conversationId,
      accountId: account.id,
    });
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private async counterOver(key: string, limit: number): Promise<boolean> {
    if (!this.redis) {
      return false;
    }
    try {
      const res = await this.redis.raw.multi().incr(key).expire(key, 3600).exec();
      return Number(res?.[0]?.[1] ?? 0) > limit;
    } catch {
      return false;
    }
  }
}

/** Exact-match Origin check against the account allowlist (scheme + host + optional port). */
export function originAllowed(allowed: string[], origin: string): boolean {
  const normalized = origin.replace(/\/$/, '').toLowerCase();
  return allowed.map((d) => d.replace(/\/$/, '').toLowerCase()).includes(normalized);
}
