import { and, eq } from 'drizzle-orm';
import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { metrics } from '../../common/observability/metrics';
import { PermanentConsumerError, type OutboxConsumer } from '../../common/infra/outbox/consumer';
import type { OutboxEvent } from '../../common/infra/outbox/schema';
import type { RedisService } from '../../common/infra/redis.service';
import { uuidv7 } from '../../common/ids/uuidv7';
import { messages, conversations } from '../conversations/schema';
import { channelAccounts, channelMessageLinks, channelIdentities, ChannelAccount, ChannelConfig } from './schema';
import { ChannelSender, PermanentSendError, SendRequest, WhatsAppSender, MessengerSender, TelegramSender, WebSender } from './senders';

/**
 * Channel outbound — Phase C3. Consumes `run.completed` / `run.failed`
 * outbox events and delivers the final assistant message to the
 * conversation's channel. Delivery is AT LEAST ONCE with a claim-before-send
 * anchor (`channel_message_links` unique on message_id): a crash between
 * provider ack and link update may re-send (WhatsApp dedupes via
 * client_msg_id); a link already marked sent/delivered/read never re-sends.
 *
 * Messaging-window policy (Meta platforms): inside the 24h window →
 * free-form; outside → WhatsApp template / Messenger note if configured,
 * else the reply is skipped with `channel_window_denied_total` (never a raw
 * API error storm).
 */

const TELEGRAM_GLOBAL_RPS = 30;
const RATE_WINDOW_SECONDS = 1;
const ACCOUNT_SEND_RPS = 80;

export const CHANNEL_OUTBOUND_METRICS = {
  sent: metrics.counter('channel_outbound_send_total', 'Assistant messages delivered to channels', ['platform', 'result']),
  windowDenied: metrics.counter('channel_window_denied_total', 'Replies skipped because the Meta messaging window was closed', ['platform']),
};

const RUN_FAILED_TEXT = 'The assistant could not complete this request. Please try again.';

@Injectable()
export class ChannelOutboundService implements OutboxConsumer {
  private static readonly logger = new Logger(ChannelOutboundService.name);
  readonly name = 'channel-outbound';
  readonly eventTypes = ['run.completed', 'run.failed'];

  private readonly senders: Record<string, ChannelSender>;

  constructor(
    private readonly db: DbService,
    whatsapp: WhatsAppSender,
    messenger: MessengerSender,
    telegram: TelegramSender,
    web: WebSender,
    private readonly redis?: RedisService,
  ) {
    this.senders = {
      whatsapp,
      messenger,
      telegram,
      web,
    };
  }

  async handle(event: OutboxEvent): Promise<void> {
    const payload = (event.payload ?? {}) as { run_id?: string; conversation_id?: string; message_id?: string };
    if (!payload.message_id || !payload.conversation_id || !payload.run_id) {
      throw new PermanentConsumerError('run terminal event payload incomplete for outbound');
    }
    const orgId = event.organizationId;

    await this.db.withOrg(orgId, async (tx) => {
      // Final assistant message + the conversation's channel binding.
      const messageRows = await tx.select().from(messages).where(eq(messages.id, payload.message_id!)).limit(1);
      const message = messageRows[0];
      if (!message) {
        throw new PermanentConsumerError(`final message ${payload.message_id} not found for outbound`);
      }
      const convRows = await tx.select().from(conversations).where(eq(conversations.id, payload.conversation_id!)).limit(1);
      const conversation = convRows[0];
      if (!conversation) {
        throw new PermanentConsumerError(`conversation ${payload.conversation_id} not found for outbound`);
      }
      const binding = (conversation.channelBinding ?? {}) as { platform?: string; channel_account_id?: string; channel_identity_id?: string };
      if (!binding.platform || !binding.channel_account_id) {
        return; // console-originated conversation — nothing to deliver
      }
      const accountRows = await tx.select().from(channelAccounts).where(eq(channelAccounts.id, binding.channel_account_id)).limit(1);
      const account = accountRows[0];
      if (!account || account.status === 'suspended') {
        return;
      }

      // Claim BEFORE any provider I/O: the unique (message_id) anchor makes
      // outbox redelivery idempotent at the send boundary.
      const inserted = await tx
        .insert(channelMessageLinks)
        .values({
          id: uuidv7(),
          organizationId: orgId,
          conversationId: conversation.id,
          messageId: message.id,
          channelAccountId: account.id,
          direction: 'outbound',
          platform: account.platform,
          deliveryState: 'pending',
        })
        .onConflictDoNothing()
        .returning({ id: channelMessageLinks.id });
      if (inserted.length === 0) {
        const existing = await tx
          .select({ deliveryState: channelMessageLinks.deliveryState })
          .from(channelMessageLinks)
          .where(and(eq(channelMessageLinks.messageId, message.id), eq(channelMessageLinks.direction, 'outbound')))
          .limit(1);
        const state = existing[0]?.deliveryState;
        if (state === 'sent' || state === 'delivered' || state === 'read') {
          return; // already durably delivered
        }
        // 'pending' from a crashed twin — fall through and re-send (at-least-once).
      }

      // Message body: the honest failure line for run.failed, never a
      // fabricated assistant reply; the out-of-window note may replace it;
      // empty completions are skipped.
      let body =
        event.eventType === 'run.failed'
          ? RUN_FAILED_TEXT
          : typeof (message.content as { text?: unknown } | null)?.text === 'string'
            ? String((message.content as { text?: unknown }).text)
            : '';
      if (!body.trim()) {
        await this.markLink(orgId, message.id, 'skipped', null);
        CHANNEL_OUTBOUND_METRICS.sent.inc({ platform: account.platform, result: 'skipped_empty' });
        return;
      }

      // Messaging-window policy (Meta platforms only).
      const config = (account.config ?? {}) as ChannelConfig;
      let template: SendRequest['template'] | undefined;
      if (account.platform === 'whatsapp' || account.platform === 'messenger') {
        const identityRows = binding.channel_identity_id
          ? await tx.select().from(channelIdentities).where(eq(channelIdentities.id, binding.channel_identity_id)).limit(1)
          : [];
        const windowOpen = identityRows[0]?.windowExpiresAt ? Date.parse(identityRows[0].windowExpiresAt) > Date.now() : false;
        if (!windowOpen) {
          if (account.platform === 'whatsapp' && config.out_of_window_template) {
            template = config.out_of_window_template;
          } else if (account.platform === 'messenger' && typeof config.out_of_window_note === 'string' && config.out_of_window_note.trim()) {
            // The note IS the message sent outside the window.
            body = config.out_of_window_note;
            CHANNEL_OUTBOUND_METRICS.windowDenied.inc({ platform: account.platform });
          } else {
            CHANNEL_OUTBOUND_METRICS.windowDenied.inc({ platform: account.platform });
            await this.markLink(orgId, message.id, 'skipped', { reason: 'messaging_window_closed' });
            return;
          }
        }
      }

      // Per-account send-rate limiter (Redis; degrade open — the provider's
      // own 429 + the outbox backoff are the hard safety nets).
      if (await this.rateLimited(account)) {
        throw new Error(`channel ${account.platform} send rate limit exceeded for account ${account.id} — retryable`);
      }

      const sender = this.senders[account.platform];
      if (!sender) {
        throw new PermanentSendError(`no sender registered for platform ${account.platform}`);
      }
      const externalUserId = await this.externalUserIdFor(orgId, binding.channel_identity_id);
      if (!externalUserId) {
        throw new PermanentSendError(`channel identity ${binding.channel_identity_id} missing external user id`);
      }
      try {
        const result = await sender.send({ account, externalUserId, text: body, internalMessageId: message.id, template });
        await tx
          .update(channelMessageLinks)
          .set({ deliveryState: 'sent', externalMessageId: result.externalMessageId, updatedAt: new Date().toISOString() })
          .where(eq(channelMessageLinks.messageId, message.id));
        CHANNEL_OUTBOUND_METRICS.sent.inc({ platform: account.platform, result: 'sent' });
      } catch (err) {
        if (err instanceof PermanentSendError) {
          await this.markLink(orgId, message.id, 'failed', { message: err.message.slice(0, 250) });
          CHANNEL_OUTBOUND_METRICS.sent.inc({ platform: account.platform, result: 'failed' });
          throw new PermanentConsumerError(err.message);
        }
        CHANNEL_OUTBOUND_METRICS.sent.inc({ platform: account.platform, result: 'retryable_error' });
        throw err;
      }
    });
  }

  private async markLink(orgId: string, messageId: string, state: 'skipped' | 'failed', reason: Record<string, unknown> | null): Promise<void> {
    await this.db.withOrg(orgId, async (tx) => {
      await tx
        .update(channelMessageLinks)
        .set({ deliveryState: state, providerError: reason, updatedAt: new Date().toISOString() })
        .where(eq(channelMessageLinks.messageId, messageId));
    });
  }

  private async externalUserIdFor(orgId: string, identityId?: string): Promise<string | null> {
    if (!identityId) {
      return null;
    }
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx.select({ externalUserId: channelIdentities.externalUserId }).from(channelIdentities).where(eq(channelIdentities.id, identityId)).limit(1),
    );
    return rows[0]?.externalUserId ?? null;
  }

  private async rateLimited(account: ChannelAccount): Promise<boolean> {
    if (!this.redis) {
      return false;
    }
    try {
      const bucket = Math.floor(Date.now() / (RATE_WINDOW_SECONDS * 1000));
      if (account.platform === 'telegram') {
        // ~1 msg/s per chat + ~30 msg/s global (Telegram Bot API limits).
        // The chat key uses the account (per-chat granularity is applied by
        // the global + account ceilings here; the provider 429 remains exact).
        const res = await this.redis.raw
          .multi()
          .incr(`chan:send:${account.id}:${bucket}`)
          .expire(`chan:send:${account.id}:${bucket}`, RATE_WINDOW_SECONDS)
          .exec();
        return Number(res?.[0]?.[1] ?? 0) > TELEGRAM_GLOBAL_RPS;
      }
      const res = await this.redis.raw.multi().incr(`chan:send:${account.id}:${bucket}`).expire(`chan:send:${account.id}:${bucket}`, RATE_WINDOW_SECONDS).exec();
      return Number(res?.[0]?.[1] ?? 0) > ACCOUNT_SEND_RPS;
    } catch {
      return false;
    }
  }
}
