import { and, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { metrics } from '../../common/observability/metrics';
import { StorageService } from '../../common/infra/storage/storage.service';
import { PermanentConsumerError, type OutboxConsumer } from '../../common/infra/outbox/consumer';
import type { OutboxEvent } from '../../common/infra/outbox/schema';
import type { RedisService } from '../../common/infra/redis.service';
import { uuidv7 } from '../../common/ids/uuidv7';
import { messages, conversations } from '../conversations/schema';
import { artifacts } from '../knowledge/schema';
import { channelAccounts, channelMessageLinks, channelIdentities, ChannelAccount, ChannelConfig } from './schema';
import { ChannelSender, PermanentSendError, SendRequest, WhatsAppSender, MessengerSender, TelegramSender, WebSender, InstagramSender, XSender, EmailSender } from './senders';
import { VoiceService } from './voice.service';

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

/** Deterministic anchor uuid for the voice-note variant of a message (redelivery-safe). */
function voiceAnchorId(messageId: string): string {
  const h = createHash('sha256').update(`voice:${messageId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

@Injectable()
export class ChannelOutboundService implements OutboxConsumer {
  private static readonly logger = new Logger(ChannelOutboundService.name);
  readonly name = 'channel-outbound';
  readonly eventTypes = [
    'run.completed',
    'run.failed',
    'message.created',
    'conversation.escalated',
    'conversation.escalation.resolved',
  ];

  private readonly senders: Record<string, ChannelSender>;

  constructor(
    private readonly db: DbService,
    private readonly storage: StorageService,
    private readonly voice: VoiceService,
    whatsapp: WhatsAppSender,
    messenger: MessengerSender,
    telegram: TelegramSender,
    web: WebSender,
    instagram: InstagramSender,
    x: XSender,
    email: EmailSender,
    private readonly redis?: RedisService,
  ) {
    this.senders = {
      whatsapp,
      messenger,
      telegram,
      web,
      instagram,
      x,
      email,
    };
  }

  async handle(event: OutboxEvent): Promise<void> {
    if (event.eventType === 'message.created') {
      return this.handleMessageCreated(event);
    }
    if (event.eventType === 'conversation.escalated' || event.eventType === 'conversation.escalation.resolved') {
      return this.handleEscalationNote(event);
    }
    return this.handleRunTerminal(event);
}

  /**
   * FL-1.7b - human-agent replies (service participants) relay to the bound
   * platform through the SAME claim-before-send + window + rate-limit
   * machinery as assistant replies. Run-authored messages are NOT relayed
   * here (they ride run.completed/failed); only author='human_agent' passes.
   */
  private async handleMessageCreated(event: OutboxEvent): Promise<void> {
    const payload = (event.payload ?? {}) as { message_id?: string; conversation_id?: string; author?: string };
    if (!payload.message_id || !payload.conversation_id) {
      throw new PermanentConsumerError('message.created payload incomplete for outbound');
    }
    const orgId = event.organizationId;
    await this.db.withOrg(orgId, async (tx) => {
      const messageRows = await tx.select().from(messages).where(eq(messages.id, payload.message_id!)).limit(1);
      const message = messageRows[0];
      if (!message) {
        return; // message vanished (purge) - nothing to deliver
      }
      const author = (message.content as { author?: unknown } | null)?.author;
      if (author !== 'human_agent') {
        return;
      }
      const bound = await this.loadBinding(orgId, tx, payload.conversation_id!);
      if (!bound) {
        return;
      }
      const text = typeof (message.content as { text?: unknown } | null)?.text === 'string'
        ? String((message.content as { text?: unknown }).text)
        : '';
      await this.deliverMessage(orgId, tx, bound, message, text);
    });
}

  /**
   * FL-1.7b - escalation lifecycle notes on channels: the end user learns a
   * human took over (and when the assistant resumed). Note text comes from
   * the account config (escalation_note / escalation_resolved_note) with
   * defaults; the claim anchor is the escalation id (deterministic), so
   * outbox redelivery cannot double-send.
   */
  private async handleEscalationNote(event: OutboxEvent): Promise<void> {
    const payload = (event.payload ?? {}) as { conversation_id?: string; escalation_id?: string };
    if (!payload.conversation_id || !payload.escalation_id) {
      throw new PermanentConsumerError('escalation lifecycle payload incomplete for outbound');
    }
    const orgId = event.organizationId;
    const resolved = event.eventType === 'conversation.escalation.resolved';
    await this.db.withOrg(orgId, async (tx) => {
      const bound = await this.loadBinding(orgId, tx, payload.conversation_id!);
      if (!bound) {
        return;
      }
      const config = (bound.account.config ?? {}) as ChannelConfig;
      const body = resolved
        ? (config.escalation_resolved_note ?? 'A human teammate helped with this conversation - the assistant is back.')
        : (config.escalation_note ?? 'Connecting you with a human teammate. The assistant is paused until they reply.');
      const anchorMessage = { id: payload.escalation_id! };
      await this.deliverMessage(orgId, tx, bound, anchorMessage, body, true);
    });
}

  private async loadBinding(
    orgId: string,
    tx: NodePgDatabase,
    conversationId: string,
  ): Promise<{
    conversation: typeof conversations.$inferSelect;
    account: ChannelAccount;
    binding: { platform?: string; channel_account_id?: string; channel_identity_id?: string };
  } | null> {
    const convRows = await tx.select().from(conversations).where(eq(conversations.id, conversationId)).limit(1);
    const conversation = convRows[0];
    if (!conversation) {
      return null;
    }
    const binding = (conversation.channelBinding ?? {}) as { platform?: string; channel_account_id?: string; channel_identity_id?: string };
    if (!binding.platform || !binding.channel_account_id) {
      return null; // console-originated conversation - nothing to deliver
    }
    const accountRows = await tx.select().from(channelAccounts).where(eq(channelAccounts.id, binding.channel_account_id)).limit(1);
    const account = accountRows[0];
    if (!account || account.status === 'suspended') {
      return null;
    }
    return { conversation, account, binding };
}

  /** Run-terminal path — body is the final assistant text or the failure line. */
  private async handleRunTerminal(event: OutboxEvent): Promise<void> {
    const payload = (event.payload ?? {}) as { run_id?: string; conversation_id?: string; message_id?: string };
    if (!payload.message_id || !payload.conversation_id || !payload.run_id) {
      throw new PermanentConsumerError('run terminal event payload incomplete for outbound');
    }
    const orgId = event.organizationId;
    await this.db.withOrg(orgId, async (tx) => {
      const messageRows = await tx.select().from(messages).where(eq(messages.id, payload.message_id!)).limit(1);
      const message = messageRows[0];
      if (!message) {
        throw new PermanentConsumerError(`final message ${payload.message_id} not found for outbound`);
      }
      const bound = await this.loadBinding(orgId, tx, payload.conversation_id!);
      if (!bound) {
        return;
      }
      // The honest failure line for run.failed — never a fabricated reply.
      const body =
        event.eventType === 'run.failed'
          ? RUN_FAILED_TEXT
          : typeof (message.content as { text?: unknown } | null)?.text === 'string'
            ? String((message.content as { text?: unknown }).text)
            : '';
      // FL-3.2 — generated media (image generation) replaces plain-text
      // delivery when present: the artifact is claim-checked, presigned for
      // the provider fetch, and sent through the platform media sender.
      const mediaRefs = (message.content as { generated_media?: unknown } | null)?.generated_media;
      const firstMedia =
        Array.isArray(mediaRefs) && mediaRefs.length > 0
          ? (mediaRefs[0] as { artifact_id?: unknown; media_type?: unknown })
          : null;
      if (event.eventType === 'run.completed' && typeof firstMedia?.artifact_id === 'string' && typeof firstMedia?.media_type === 'string') {
        const media = await this.presignArtifact(orgId, tx, firstMedia.artifact_id, firstMedia.media_type);
        if (media) {
          await this.deliverMedia(orgId, tx, bound, message, media.url, media.mediaType, body.slice(0, 800) || undefined);
          return;
        }
      }
      await this.deliverMessage(orgId, tx, bound, message, body);
      // FL-3.1 — voice-note rendering for WhatsApp when the org enables it
      // and the TTS port is configured. Best-effort: TTS failure never fails
      // the (already delivered) text delivery.
      if (event.eventType === 'run.completed' && bound.account.platform === 'whatsapp' && body.trim()) {
        const config = (bound.account.config ?? {}) as ChannelConfig;
        if (config.voice_replies_enabled === true) {
          await this.deliverVoiceNote(orgId, bound, message.id, body);
        }
      }
    });
  }

  /** Load an org-owned GENERATED_MEDIA artifact and presign a short-TTL GET. */
  private async presignArtifact(
    orgId: string,
    tx: NodePgDatabase,
    artifactId: string,
    mediaType: string,
  ): Promise<{ url: string; mediaType: string } | null> {
    const rows = await tx
      .select({ id: artifacts.id, objectKey: artifacts.objectKey, state: artifacts.state, purpose: artifacts.purpose })
      .from(artifacts)
      .where(and(eq(artifacts.id, artifactId), eq(artifacts.organizationId, orgId)))
      .limit(1);
    const artifact = rows[0];
    if (!artifact || artifact.state !== 'active' || artifact.purpose !== 'GENERATED_MEDIA') {
      return null;
    }
    if (!this.storage.available) {
      return null;
    }
    const download = this.storage.presignDownload({ key: artifact.objectKey, expiresIn: 300 });
    return { url: download.url, mediaType: mediaType.slice(0, 100) };
  }

  /** Media delivery — same claim-before-send anchor discipline as text. */
  private async deliverMedia(
    orgId: string,
    tx: NodePgDatabase,
    bound: { conversation: { id: string }; account: ChannelAccount; binding: { platform?: string; channel_account_id?: string; channel_identity_id?: string } },
    message: { id: string },
    mediaUrl: string,
    mediaType: string,
    caption?: string,
  ): Promise<void> {
    const account = bound.account;
    const claim = await tx
      .insert(channelMessageLinks)
      .values({
        id: uuidv7(),
        organizationId: orgId,
        conversationId: bound.conversation.id,
        messageId: message.id,
        channelAccountId: account.id,
        direction: 'outbound',
        platform: account.platform,
        deliveryState: 'pending',
      })
      .onConflictDoNothing()
      .returning({ id: channelMessageLinks.id });
    if (claim.length === 0) {
      return; // already claimed by a prior delivery attempt
    }
    const sender = this.senders[account.platform];
    const externalUserId = await this.externalUserIdFor(orgId, bound.binding.channel_identity_id);
    if (!sender || !externalUserId) {
      await this.markLink(orgId, message.id, 'skipped', { reason: 'no_media_sender' });
      return;
    }
    try {
      const result = await sender.sendMedia({ account, externalUserId, mediaUrl, mediaType, caption, internalMessageId: message.id });
      await tx
        .update(channelMessageLinks)
        .set({ deliveryState: 'sent', externalMessageId: result.externalMessageId, updatedAt: new Date().toISOString() })
        .where(eq(channelMessageLinks.messageId, message.id));
      CHANNEL_OUTBOUND_METRICS.sent.inc({ platform: account.platform, result: 'sent_media' });
    } catch (err) {
      if (err instanceof PermanentSendError) {
        await this.markLink(orgId, message.id, 'failed', { message: err.message.slice(0, 250) });
        throw new PermanentConsumerError(err.message);
      }
      throw err;
    }
  }

  /** FL-3.1 — synthesized voice note as an EXTRA message (deterministic anchor). */
  private async deliverVoiceNote(orgId: string, bound: { account: ChannelAccount; binding: { channel_identity_id?: string } }, messageId: string, text: string): Promise<void> {
    const synthesized = await this.voice.synthesize(text);
    if (!synthesized) {
      return;
    }
    const externalUserId = await this.externalUserIdFor(orgId, bound.binding.channel_identity_id);
    const sender = this.senders[bound.account.platform];
    if (!externalUserId || !sender) {
      return;
    }
    try {
      // Voice notes ride the storage claim-check: the synthesized audio is
      // uploaded server-side and handed to the provider via presigned GET.
      const key = `org/${orgId}/voice/${messageId}.mp3`;
      await this.storage.putObject({ key, contentType: 'audio/mpeg', body: Buffer.from(synthesized.audio) });
      const presigned = this.storage.presignDownload({ key, expiresIn: 300 });
      await sender.sendMedia({
        account: bound.account,
        externalUserId,
        mediaUrl: presigned.url,
        mediaType: 'audio/mpeg',
        internalMessageId: voiceAnchorId(messageId),
      });
    } catch (err) {
      ChannelOutboundService.logger.warn(`voice-note delivery skipped for message ${messageId}: ${(err as Error).message.slice(0, 160)}`);
    }
  }

  /**
   * Shared delivery tail - claim-before-send, Meta window policy, per-account
   * rate limit, provider send, durable link update. Lifecycle notes skip the
   * Messenger out-of-window body replacement (the note IS the message).
   */
  private async deliverMessage(
    orgId: string,
    tx: NodePgDatabase,
    bound: { conversation: { id: string }; account: ChannelAccount; binding: { platform?: string; channel_account_id?: string; channel_identity_id?: string } },
    message: { id: string },
    body: string,
    isLifecycleNote = false,
  ): Promise<void> {
    const account = bound.account;
    const binding = bound.binding;

      // Claim BEFORE any provider I/O: the unique (message_id) anchor makes
      // outbox redelivery idempotent at the send boundary.
      const inserted = await tx
        .insert(channelMessageLinks)
        .values({
          id: uuidv7(),
          organizationId: orgId,
          conversationId: bound.conversation.id,
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
        // 'pending' from a crashed twin - fall through and re-send (at-least-once).
      }

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
          } else if (!isLifecycleNote && account.platform === 'messenger' && typeof config.out_of_window_note === 'string' && config.out_of_window_note.trim()) {
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

      // Per-account send-rate limiter (Redis; degrade open - the provider's
      // own 429 + the outbox backoff are the hard safety nets).
      if (await this.rateLimited(account)) {
        throw new Error(`channel ${account.platform} send rate limit exceeded for account ${account.id} - retryable`);
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
