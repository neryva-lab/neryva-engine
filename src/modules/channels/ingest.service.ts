import { and, eq, sql } from 'drizzle-orm';
import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { ApiError } from '../../common/http/api-error';
import { env } from '../../common/config/env';
import { recordOutboxEvent } from '../../common/infra/outbox/outbox.service';
import { PermanentConsumerError, type OutboxConsumer } from '../../common/infra/outbox/consumer';
import type { OutboxEvent } from '../../common/infra/outbox/schema';
import { uuidv7 } from '../../common/ids/uuidv7';
import { sha256Hex } from '../../common/infra/crypto/envelope';
import type { RedisService } from '../../common/infra/redis.service';
import { ConversationsService } from '../conversations/conversations.service';
import { RetentionPurgeService } from '../lifecycle/retention-purge.service';
import { channelAccounts, channelEvents, channelIdentities, channelMessageLinks, messageReceipts, ChannelAccount } from './schema';
import { normalizeFor, NormalizedEvent, STALE_EVENT_MS } from './normalize';
import { VoiceService } from './voice.service';

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
 */

const RATE_WINDOW_SECONDS = 60;
const RATE_LIMIT_PER_ACCOUNT = 600;

export interface WebhookAcceptResult {
  outcome: 'accepted' | 'duplicate';
}

@Injectable()
export class ChannelIngestService {
  private static readonly logger = new Logger(ChannelIngestService.name);

  constructor(
    private readonly db: DbService,
    private readonly conversations: ConversationsService,
    private readonly purge: RetentionPurgeService,
    private readonly voice: VoiceService,
    private readonly redis?: RedisService,
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

    return this.db.withBypass(async (tx) => {
      const inserted = await tx
        .insert(channelEvents)
        .values({
          id: uuidv7(),
          organizationId: account.organizationId,
          channelAccountId: account.id,
          platform: account.platform,
          externalEventId,
          payload: { raw: boundedRaw, normalized_kind: normalized.kind, signature_ok: input.signatureOk } as never,
          signatureOk: input.signatureOk,
        })
        .onConflictDoNothing()
        .returning({ id: channelEvents.id });
      if (inserted.length === 0) {
        return { outcome: 'duplicate' as const };
      }
      // Canonical fact (received event) + announcement in one TX (invariant 7).
      await recordOutboxEvent(tx, {
        aggregateType: 'channel_event',
        aggregateId: inserted[0].id,
        organizationId: account.organizationId,
        eventType: 'channel.event.received',
        partitionKey: account.id,
        payload: { channel_account_id: account.id, channel_event_id: inserted[0].id },
      });
      return { outcome: 'accepted' as const };
    });
  }
}

/** Outbox consumer — processes channel.event.received into the conversation plane. */
export class ChannelIngestConsumer implements OutboxConsumer {
  private static readonly logger = new Logger(ChannelIngestConsumer.name);
  readonly name = 'channel-ingest';
  readonly eventTypes = ['channel.event.received'];

  constructor(
    private readonly db: DbService,
    private readonly conversations: ConversationsService,
    private readonly purge: RetentionPurgeService,
    private readonly voice: VoiceService,
  ) {}

  async handle(event: OutboxEvent): Promise<void> {
    const payload = (event.payload ?? {}) as { channel_account_id?: string; channel_event_id?: string };
    if (!payload.channel_account_id || !payload.channel_event_id) {
      throw new PermanentConsumerError('channel.event.received payload incomplete');
    }
    const accountRows = await this.db.root.select().from(channelAccounts).where(eq(channelAccounts.id, payload.channel_account_id)).limit(1);
    const account = accountRows[0];
    if (!account) {
      throw new PermanentConsumerError(`channel account ${payload.channel_account_id} vanished`);
    }
    const eventRows = await this.db.root.select().from(channelEvents).where(eq(channelEvents.id, payload.channel_event_id)).limit(1);
    const stored = eventRows[0];
    if (!stored) {
      throw new PermanentConsumerError(`channel event ${payload.channel_event_id} vanished`);
    }
    if (stored.status === 'processed') {
      return; // redelivery after a settled event — nothing to do
    }
    if (stored.signatureOk === false) {
      await this.settle(stored.id, 'quarantined', 'signature verification failed');
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
      await this.settle(stored.id, 'processed');
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.getStatus() === 410) {
          // Tombstoned conversation — the platform keeps sending for a purged
          // chat; quarantine rather than burning retries forever.
          await this.settle(stored.id, 'quarantined', err.message);
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

    await this.db.withBypass(async (tx) => {
      // 1. Identity upsert + 24h messaging window (Meta platforms only).
      const hasWindow = account.platform === 'whatsapp' || account.platform === 'messenger' || account.platform === 'instagram';
      const now = new Date().toISOString();
      const windowExpires = hasWindow ? new Date(Date.now() + 24 * 3600 * 1000).toISOString() : null;
      await tx
        .insert(channelIdentities)
        .values({
          id: uuidv7(),
          organizationId: account.organizationId,
          channelAccountId: account.id,
          platform: account.platform,
          externalUserId: event.externalUserId.slice(0, 255),
          displayName: event.profileName?.slice(0, 255) ?? null,
          locale: event.locale?.slice(0, 32) ?? null,
          lastInboundAt: now,
          windowExpiresAt: windowExpires,
        })
        .onConflictDoUpdate({
          target: [channelIdentities.channelAccountId, channelIdentities.externalUserId],
          set: { lastInboundAt: now, windowExpiresAt: windowExpires, updatedAt: now },
        });
      const identityRows = await tx
        .select({ id: channelIdentities.id })
        .from(channelIdentities)
        .where(and(eq(channelIdentities.channelAccountId, account.id), eq(channelIdentities.externalUserId, event.externalUserId.slice(0, 255))))
        .limit(1);
      const identityId = identityRows[0]?.id;
      if (!identityId) {
        throw new Error('channel identity vanished after upsert');
      }

      // 2. Conversation: latest active conversation bound to this identity;
      //    purged (tombstoned) conversations are never revived.
      const convRows = await tx.execute(sql`
        select id from conversations
        where organization_id = ${account.organizationId}::uuid
          and channel_binding->>'channel_identity_id' = ${identityId}
          and status = 'active'
        order by updated_at desc
        limit 1
      `);
      const existingId = (convRows.rows[0] as { id: string } | undefined)?.id;
      let conversationId = existingId;
      if (existingId) {
        await this.purge.assertNotTombstoned('conversation', existingId);
      }
      if (!conversationId) {
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
      await tx
        .insert(channelMessageLinks)
        .values({
          id: uuidv7(),
          organizationId: account.organizationId,
          conversationId,
          messageId: result.message_id,
          channelAccountId: account.id,
          direction: 'inbound',
          platform: account.platform,
          externalMessageId: event.externalMessageId || null,
          deliveryState: 'sent',
        })
        .onConflictDoNothing();
    });
  }

  private async handleStatus(account: ChannelAccount, event: Extract<NormalizedEvent, { kind: 'status' }>): Promise<void> {
    if (!event.externalMessageId) {
      return;
    }
    await this.db.withOrg(account.organizationId, async (tx) => {
      const links = await tx
        .select({ messageId: channelMessageLinks.messageId, conversationId: channelMessageLinks.conversationId, direction: channelMessageLinks.direction })
        .from(channelMessageLinks)
        .where(and(eq(channelMessageLinks.channelAccountId, account.id), eq(channelMessageLinks.externalMessageId, event.externalMessageId)))
        .limit(1);
      const link = links[0];
      await tx
        .update(channelMessageLinks)
        .set({
          deliveryState: event.status,
          providerError: event.errorCode ? { code: event.errorCode, message: event.errorMessage ?? null } : null,
          updatedAt: new Date().toISOString(),
        })
        .where(and(eq(channelMessageLinks.channelAccountId, account.id), eq(channelMessageLinks.externalMessageId, event.externalMessageId)));
      // FL-3.19 — delivery/read receipts for OUTBOUND messages, upserted per
      // (message, account, state); the first platform report wins.
      if (link && link.direction === 'outbound' && (event.status === 'delivered' || event.status === 'read')) {
        await tx
          .insert(messageReceipts)
          .values({
            id: uuidv7(),
            organizationId: account.organizationId,
            conversationId: link.conversationId,
            messageId: link.messageId,
            channelAccountId: account.id,
            platform: account.platform,
            state: event.status,
            occurredAt: event.occurredAtMs ? new Date(event.occurredAtMs).toISOString() : new Date().toISOString(),
          })
          .onConflictDoNothing();
      }
    });
  }

  private async settle(eventId: string, status: 'processed' | 'quarantined', error?: string): Promise<void> {
    await this.db.withBypass(async (tx) => {
      await tx
        .update(channelEvents)
        .set({ status, processedAt: new Date().toISOString(), ...(error ? { lastError: error.slice(0, 4000) } : {}) })
        .where(eq(channelEvents.id, eventId));
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
