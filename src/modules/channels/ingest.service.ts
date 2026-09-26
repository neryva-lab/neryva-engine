import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ApiError } from '../../common/http/api-error';
import { env } from '../../common/config/env';
import { PermanentConsumerError, type OutboxConsumer } from '../../common/infra/outbox/consumer';
import type { OutboxEvent } from '../../common/infra/outbox/schema';
import { sha256Hex } from '../../common/infra/crypto/envelope';
// VALUE import (not `import type`): NestJS reads this binding for
// design:paramtypes metadata — a type-only import erases it and the
// injected redis resolves to undefined, failing or silently disabling.
import { RedisService } from '../../common/infra/redis.service';
import { ConversationsService } from '../conversations/conversations.service';
import { RetentionPurgeService } from '../lifecycle/retention-purge.service';
import type { ChannelAccount } from './schema';
import { normalizeFor, type NormalizedEvent, STALE_EVENT_MS } from './normalize';
import { VoiceService } from './voice.service';
import { CHANNEL_ACCOUNT_REPOSITORY } from './repositories/repository-tokens';
import { CHANNEL_EVENT_REPOSITORY } from './repositories/repository-tokens';
import { CHANNEL_IDENTITY_REPOSITORY } from './repositories/repository-tokens';
import { CHANNEL_MESSAGE_LINK_REPOSITORY } from './repositories/repository-tokens';
import type { IChannelAccountRepository } from './repositories/channel-account.repository';
import type { IChannelEventRepository, WebhookRecordOutcome } from './repositories/channel-event.repository';
import type { IChannelIdentityRepository } from './repositories/channel-identity.repository';
import type { IChannelMessageLinkRepository } from './repositories/channel-message-link.repository';

/**
 * Channel ingest — Phase C2. Two halves:
 *
 * 1. `acceptWebhook` (public webhook controller): dedups the event via
 *    `(channel_account_id, external_event_id)` and announces it through the
 *    outbox in ONE transaction (invariant 7). The platform gets 200
 *    immediately; the outbox payload carries IDS ONLY — the bounded raw
 *    envelope lives on `channel_events` (claim-check discipline, invariant 10).
 *
 * 2. `ChannelIngestConsumer` (outbox worker): loads the stored envelope,
 *    normalizes, resolves/creates identity + conversation, and calls the ONE
 *    message entry point (`ConversationsService.acceptMessage`) with the
 *    channel idempotency key. Status events update delivery state instead.
 *
 * Persistence goes through the P3 channel repository ports
 * (`IChannelEventRepository`, `IChannelIdentityRepository`,
 * `IChannelMessageLinkRepository`, `IChannelAccountRepository`). This
 * service holds no provider, Drizzle, or SQL references.
 */

const RATE_WINDOW_SECONDS = 60;
const RATE_LIMIT_PER_ACCOUNT = 600;

export interface WebhookAcceptResult {
  outcome: WebhookRecordOutcome;
}

@Injectable()
export class ChannelIngestService {
  private static readonly logger = new Logger(ChannelIngestService.name);

  constructor(
    @Inject(CHANNEL_ACCOUNT_REPOSITORY) private readonly accounts: IChannelAccountRepository,
    @Inject(CHANNEL_EVENT_REPOSITORY) private readonly events: IChannelEventRepository,
    @Optional() private readonly redis?: RedisService,
  ) {}

  /**
   * Fixed-window per-account ingest rate limit (Redis flood control;
   * degrade open — the signature check is the security boundary).
   */
  async rateLimited(accountId: string): Promise<boolean> {
    if (!this.redis) {
      return false;
    }
    try {
      const key = `chan:ingest:${accountId}:${Math.floor(Date.now() / (RATE_WINDOW_SECONDS * 1000))}`;
      const res = await this.redis.raw.multi().incr(key).expire(key, RATE_WINDOW_SECONDS).exec();
      const count = Number(res?.[0]?.[1] ?? 0);
      return count > RATE_LIMIT_PER_ACCOUNT;
    } catch {
      return false;
    }
  }

  async acceptWebhook(input: { account: ChannelAccount; rawBody: string; signatureOk: boolean }): Promise<WebhookAcceptResult> {
    const { account } = input;
    if (account.status === 'suspended') {
      throw ApiError.forbidden('channel account is suspended');
    }
    // Bounded raw envelope: verification ran over the FULL body (the caller's
    // job); storage keeps the configured bound for replay/diagnostics.
    const boundedRaw = input.rawBody.length > env.CHANNELS__WEBHOOK_MAX_EVENT_BYTES ? input.rawBody.slice(0, env.CHANNELS__WEBHOOK_MAX_EVENT_BYTES) : input.rawBody;
    const normalized = normalizeFor(account.platform, safeParse(boundedRaw), boundedRaw);
    const externalEventId = normalized.externalEventId.slice(0, 255);

    // Durable receipt + outbox announce in ONE transaction (invariant 7).
    // The (account, external_event_id) unique key makes redelivery a
    // `duplicate` with no second outbox event.
    const outcome = await this.events.recordWebhookEvent({
      accountId: account.id,
      orgId: account.organizationId,
      platform: account.platform,
      boundedRaw,
      externalEventId,
      normalizedKind: normalized.kind,
      signatureOk: input.signatureOk,
    });

    ChannelIngestService.logger.log(
      `webhook ${outcome} for account ${account.id} (${account.platform}, event ${externalEventId})`,
    );
    return { outcome };
  }
}

/** Outbox consumer — processes channel.event.received into the conversation plane. */
@Injectable()
export class ChannelIngestConsumer implements OutboxConsumer {
  private static readonly logger = new Logger(ChannelIngestConsumer.name);
  readonly name = 'channel-ingest';
  readonly eventTypes = ['channel.event.received'];

  constructor(
    @Inject(CHANNEL_ACCOUNT_REPOSITORY) private readonly accounts: IChannelAccountRepository,
    @Inject(CHANNEL_EVENT_REPOSITORY) private readonly events: IChannelEventRepository,
    @Inject(CHANNEL_IDENTITY_REPOSITORY) private readonly identities: IChannelIdentityRepository,
    @Inject(CHANNEL_MESSAGE_LINK_REPOSITORY) private readonly links: IChannelMessageLinkRepository,
    private readonly conversations: ConversationsService,
    private readonly purge: RetentionPurgeService,
    private readonly voice: VoiceService,
  ) {}

  async handle(event: OutboxEvent): Promise<void> {
    const payload = (event.payload ?? {}) as { channel_account_id?: string; channel_event_id?: string };
    if (!payload.channel_account_id || !payload.channel_event_id) {
      throw new PermanentConsumerError('channel.event.received payload incomplete');
    }
    // Same FORCE-RLS root-read class as the G1 getByPublicKey fix: the
    // worker resolves by exact ids from a trusted outbox event (no tenant
    // context exists here) — bypass vehicle, matching settle() below.
    const accountId = payload.channel_account_id;
    const eventId = payload.channel_event_id;
    const account = await this.accounts.getAccountByIdForIngest(accountId);
    const stored = await this.events.getEventByIdForIngest(eventId);
    if (!account) {
      throw new PermanentConsumerError(`channel account ${payload.channel_account_id} vanished`);
    }
    if (!stored || stored.channelAccountId !== accountId) {
      throw new PermanentConsumerError(`channel event ${payload.channel_event_id} vanished`);
    }
    if (stored.status === 'processed') {
      return; // redelivery after a settled event — nothing to do
    }
    if (stored.signatureOk === false) {
      await this.events.settleEvent(stored.id, 'quarantined', 'signature verification failed');
      return;
    }

    const raw = String((stored.payload as { raw?: unknown }).raw ?? '');
    const normalized = normalizeFor(account.platform, safeParse(raw), raw);
    try {
      switch (normalized.kind) {
        case 'message':
          await this.handleMessage(account, normalized, raw);
          break;
        case 'media':
          await this.handleMedia(account, normalized, raw);
          break;
        case 'status':
          await this.handleStatus(account, normalized);
          break;
        case 'unsupported':
          // Normal, quiet: typing echoes and non-message updates.
          break;
      }
      await this.events.settleEvent(stored.id, 'processed');
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.getStatus() === 410) {
          // Tombstoned conversation — the platform keeps sending for a purged
          // chat; quarantine rather than burning retries forever.
          await this.events.settleEvent(stored.id, 'quarantined', err.message);
          return;
        }
        const status = err.getStatus();
        if (status >= 400 && status < 500 && err.retryability === 'no-retry') {
          throw new PermanentConsumerError(`channel ingest rejected: ${err.code}`);
        }
      }
      throw err; // retryable — the outbox machine schedules the redelivery
    }
  }

  /**
   * FL-3.1 — inbound media (voice note / audio): bounded download → ASR port
   * → the ONE message entry point with a `voice` provenance part. Images and
   * documents are recorded but not answered (v1). A missing ASR port or a
   * failed transcription is QUIET — text messaging never degrades with it.
   */
  private async handleMedia(account: ChannelAccount, event: Extract<NormalizedEvent, { kind: 'media' }>, raw: string): Promise<void> {
    if (!event.externalUserId) {
      return; // nothing addressable — recorded on channel_events, not answered
    }
    if (event.mediaFamily !== 'audio') {
      ChannelIngestConsumer.logger.debug(`channel ${account.id}: ${event.mediaFamily} media recorded without reply (v1)`);
      return;
    }
    const bytes = await this.voice.downloadMedia({
      account,
      mediaFamily: event.mediaFamily,
      mediaId: event.mediaId,
      ...(event.mediaUrl !== undefined ? { mediaUrl: event.mediaUrl } : {}),
      ...(event.mimeType !== undefined ? { mimeType: event.mimeType } : {}),
    });
    if (!bytes) {
      return;
    }
    const transcript = await this.voice.transcribe(bytes, event.mimeType ?? 'audio/mpeg');
    if (!transcript) {
      ChannelIngestConsumer.logger.debug(`channel ${account.id}: voice note recorded without transcript (no ASR port or empty result)`);
      return;
    }
    await this.handleMessage(
      account,
      {
        kind: 'message',
        externalEventId: event.externalEventId,
        externalMessageId: event.externalMessageId,
        externalUserId: event.externalUserId,
        text: transcript,
        timestampMs: event.timestampMs,
        ...(event.profileName !== undefined ? { profileName: event.profileName } : {}),
      },
      raw,
      { transcribed: true },
    );
  }

  private async handleMessage(
    account: ChannelAccount,
    event: Extract<NormalizedEvent, { kind: 'message' }>,
    raw: string,
    voice?: { transcribed: boolean },
  ): Promise<void> {
    if (!event.externalUserId) {
      throw new PermanentConsumerError('channel message without external user id');
    }
    // Stale redelivery floor (platform retries can be days old).
    if (event.timestampMs !== null && event.timestampMs > 0 && Date.now() - event.timestampMs > STALE_EVENT_MS) {
      throw new PermanentConsumerError(`stale channel event (${Math.round((Date.now() - event.timestampMs) / 86_400_000)}d old)`);
    }
    if (!event.text || event.text.trim().length === 0) {
      // Media-only / unsupported message types are recorded, not answered (v1).
      ChannelIngestConsumer.logger.debug(`channel ${account.id}: non-text message recorded without reply`);
      return;
    }
    // Bounded content — the claim-check path exists for large parts (invariant 10).
    if (event.text.length > 16_000) {
      throw new PermanentConsumerError('channel message text exceeds the bounded payload size');
    }
    const config = (account.config ?? {}) as { default_assistant_id?: string };
    if (!config.default_assistant_id) {
      throw new PermanentConsumerError(`channel account ${account.id} has no default_assistant_id — configure before activating`);
    }

    // 1. Identity upsert + 24h messaging window (Meta platforms only).
    //    First-inbound races converge on one row via the unique
    //    (account, external_user_id) key.
    const hasWindow = account.platform === 'whatsapp' || account.platform === 'messenger' || account.platform === 'instagram';
    const identityId = await this.identities.upsertInboundIdentity({
      orgId: account.organizationId,
      accountId: account.id,
      platform: account.platform,
      externalUserId: event.externalUserId,
      displayName: event.profileName ?? null,
      locale: event.locale ?? null,
      hasWindow,
    });

    // 2. Conversation: latest active conversation bound to this identity;
    //    purged (tombstoned) conversations are never revived.
    let conversationId = await this.identities.findActiveConversationIdByIdentity(account.organizationId, identityId);
    if (conversationId) {
      await this.purge.assertNotTombstoned('conversation', conversationId);
    } else {
      const created = await this.conversations.createConversation({
        orgId: account.organizationId,
        assistantId: String(config.default_assistant_id),
        createdBy: `channel:${account.id}`,
        channelBinding: {
          platform: account.platform,
          channel_account_id: account.id,
          channel_identity_id: identityId,
        },
        participantScope: 'channel',
      });
      conversationId = created.id;
    }

    // 3. THE one message entry point — idempotency tier, run pinning,
    //    one-active-turn, outbox all happen here (ledger 4.7).
    const result = await this.conversations.acceptMessage({
      orgId: account.organizationId,
      principalId: `channel:${account.id}`,
      conversationId,
      content: {
        text: event.text,
        channel: { platform: account.platform },
        ...(voice?.transcribed ? { voice: { transcribed: true } } : {}),
      },
      idempotencyKey: `channel:${account.id}:${event.externalMessageId || sha256Hex(raw).slice(0, 32)}`,
    });

    // 4. Inbound link (dedup anchor: (account, external_message_id)).
    await this.links.recordInboundLink({
      orgId: account.organizationId,
      conversationId,
      messageId: result.message_id,
      accountId: account.id,
      platform: account.platform,
      externalMessageId: event.externalMessageId || null,
    });
  }

  private async handleStatus(account: ChannelAccount, event: Extract<NormalizedEvent, { kind: 'status' }>): Promise<void> {
    if (!event.externalMessageId) {
      return;
    }
    // Tenant-scoped to the account's org (pre-P3 used withOrg(account.org)).
    // No matching link → no-op; the event still settles as processed.
    await this.links.applyStatusEvent({
      orgId: account.organizationId,
      accountId: account.id,
      externalMessageId: event.externalMessageId,
      status: event.status,
      providerError: event.errorCode ? { code: event.errorCode, message: event.errorMessage ?? null } : null,
      ...(event.occurredAtMs !== undefined ? { occurredAtMs: event.occurredAtMs } : {}),
    });
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
