import { Injectable } from '@nestjs/common';
import { ChannelAccount } from './schema';
import { ChannelsService } from './channels.service';
import { META_GRAPH_VERSION } from './dto';
import { env } from '../../common/config/env';

/**
 * Channel sender port (Phase C3). One implementation per platform; the
 * outbound consumer is the only caller. Senders decrypt credentials
 * in-memory per call (never cached, never logged) and enforce a 10s
 * deadline. All failures throw:
 *   - `PermanentSendError` — 4xx contract errors (dead-letter),
 *   - plain Error        — transient (outbox retry machine schedules).
 */

export class PermanentSendError extends Error {}

export interface SendTextResult {
  externalMessageId: string | null;
}

export interface SendRequest {
  account: ChannelAccount;
  externalUserId: string;
  text: string;
  /** Provider-side idempotency hint where supported (WhatsApp client_msg_id). */
  internalMessageId: string;
  /** Out-of-window template payload (WhatsApp) — pre-validated by the consumer. */
  template?: { name: string; language: string };
}

export interface SendMediaRequest {
  account: ChannelAccount;
  externalUserId: string;
  /** Public HTTPS media URL — the sender hands it to the provider; the
   * provider fetches it itself (claim-check presigned GET, short TTL). */
  mediaUrl: string;
  mediaType: string;
  caption?: string;
  internalMessageId: string;
}

/**
 * FL-3.18 — interactive outbound payload (buttons/list). Buttons carry
 * deterministic action ids the platform echoes back on reply; the ingest
 * normalizer treats them as plain user text (bounded), keeping the reply
 * path universal.
 */
export interface InteractiveRequest {
  /** Max 3 buttons (WhatsApp), body text up to 1024 chars. */
  buttons: Array<{ id: string; title: string }>;
  body: string;
}

export interface ChannelSender {
  readonly platform: string;
  send(request: SendRequest): Promise<SendTextResult>;
  /** FL-2.27 — outbound media (claim-check presigned URL → provider upload). */
  sendMedia(request: SendMediaRequest): Promise<SendTextResult>;
  /** FL-3.18 — interactive buttons (platforms that support them; default rejects). */
  sendInteractive?(request: SendRequest & { interactive: InteractiveRequest }): Promise<SendTextResult>;
}

const DEADLINE_MS = 10_000;

async function postJson(url: string, body: unknown, token?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
  timer.unref();
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) {
      headers.authorization = `Bearer ${token}`;
    }
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let parsed: Record<string, unknown> = {};
    try {
      parsed = (await res.json()) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
    return { status: res.status, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

function assertOk(status: number, body: Record<string, unknown>, platform: string): void {
  if (status >= 200 && status < 300) {
    return;
  }
  const message = String((body.error as { message?: string } | undefined)?.message ?? body.description ?? `http ${status}`);
  if (status >= 400 && status < 500 && status !== 429) {
    // Contract errors (bad template, revoked token, blocked user) never recover.
    throw new PermanentSendError(`${platform} send rejected (${status}): ${message.slice(0, 250)}`);
  }
  throw new Error(`${platform} send failed (${status}): ${message.slice(0, 250)} — retryable`);
}

@Injectable()
export class WhatsAppSender implements ChannelSender {
  readonly platform = 'whatsapp';

  constructor(private readonly channels: ChannelsService) {}

  async send(request: SendRequest): Promise<SendTextResult> {
    const creds = this.channels.decryptCredentials(request.account);
    const phoneNumberId = String(creds.phone_number_id ?? '');
    if (!phoneNumberId) {
      throw new PermanentSendError('whatsapp account missing phone_number_id');
    }
    const payload = request.template
      ? {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: request.externalUserId,
          type: 'template',
          template: { name: request.template.name, language: { code: request.template.language } },
        }
      : {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: request.externalUserId,
          type: 'text',
          text: { body: request.text.slice(0, 4096) },
          // Provider-side idempotency: a redelivery after a lost response
          // cannot double-send the same message.
          client_msg_id: request.internalMessageId,
        };
    const res = await postJson(`https://graph.facebook.com/${META_GRAPH_VERSION}/${phoneNumberId}/messages`, payload, String(creds.access_token ?? ''));
    assertOk(res.status, res.body, 'whatsapp');
    const messages = (res.body.messages as Array<{ id?: string }> | undefined) ?? [];
    return { externalMessageId: messages[0]?.id ?? null };
  }
  /** FL-2.27/FL-3.1 — WhatsApp outbound media: link by media family. */
  async sendMedia(request: SendMediaRequest): Promise<SendTextResult> {
    const creds = this.channels.decryptCredentials(request.account);
    const phoneNumberId = String(creds.phone_number_id ?? '');
    if (!phoneNumberId) {
      throw new PermanentSendError('whatsapp account missing phone_number_id');
    }
    // WhatsApp requires the family-specific link field: audio/image/video/document.
    const kind = request.mediaType.startsWith('audio/')
      ? 'audio'
      : request.mediaType.startsWith('image/')
        ? 'image'
        : request.mediaType.startsWith('video/')
          ? 'video'
          : 'document';
    const payload = {
      messaging_product: 'whatsapp',
      to: request.externalUserId,
      type: kind,
      [kind]: { link: request.mediaUrl, caption: request.caption },
    };
    const res = await postJson(`https://graph.facebook.com/${META_GRAPH_VERSION}/${phoneNumberId}/messages`, payload, String(creds.access_token ?? ''));
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new PermanentSendError(`whatsapp media send rejected: ${res.status}`);
    }
    if (res.status >= 400) {
      throw new Error(`whatsapp media send failed: ${res.status}`);
    }
    const messages = res.body['messages'] as Array<{ id?: string }> | undefined;
    return { externalMessageId: messages?.[0]?.id ?? null };
  }

  /** FL-3.18 — WhatsApp interactive buttons (max 3, deterministic reply ids). */
  async sendInteractive(request: SendRequest & { interactive: InteractiveRequest }): Promise<SendTextResult> {
    const creds = this.channels.decryptCredentials(request.account);
    const phoneNumberId = String(creds.phone_number_id ?? '');
    if (!phoneNumberId) {
      throw new PermanentSendError('whatsapp account missing phone_number_id');
    }
    const buttons = request.interactive.buttons.slice(0, 3).map((b) => ({
      type: 'reply',
      reply: { id: b.id.slice(0, 256), title: b.title.slice(0, 20) },
    }));
    const res = await postJson(
      `https://graph.facebook.com/${META_GRAPH_VERSION}/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to: request.externalUserId,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: request.interactive.body.slice(0, 1024) },
          action: { buttons },
        },
      },
      String(creds.access_token ?? ''),
    );
    assertOk(res.status, res.body, 'whatsapp');
    const messages = res.body['messages'] as Array<{ id?: string }> | undefined;
    return { externalMessageId: messages?.[0]?.id ?? null };
  }
}

export class MessengerSender implements ChannelSender {
  readonly platform = 'messenger';

  constructor(private readonly channels: ChannelsService) {}

  async send(request: SendRequest): Promise<SendTextResult> {
    const creds = this.channels.decryptCredentials(request.account);
    const res = await postJson(`https://graph.facebook.com/${META_GRAPH_VERSION}/me/messages`, {
      recipient: { id: request.externalUserId },
      message: { text: request.text.slice(0, 2000) },
    }, String(creds.access_token ?? ''));
    assertOk(res.status, res.body, 'messenger');
    const messageId = String((res.body.message_id as string | undefined) ?? '');
    return { externalMessageId: messageId || null };
  }
  /** FL-2.27 — Messenger outbound media: attachment API with a public URL. */
  async sendMedia(request: SendMediaRequest): Promise<SendTextResult> {
    const creds = this.channels.decryptCredentials(request.account);
    const attachmentType = request.mediaType.startsWith('image/') ? 'image' : 'file';
    const res = await postJson(
      `https://graph.facebook.com/${META_GRAPH_VERSION}/me/messages`,
      {
        recipient: { id: request.externalUserId },
        messaging_type: 'UPDATE',
        message: {
          attachment: {
            type: attachmentType,
            payload: { is_reusable: false, url: request.mediaUrl },
          },
        },
      },
      creds.token,
    );
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new PermanentSendError(`messenger media send rejected: ${res.status}`);
    }
    if (res.status >= 400) {
      throw new Error(`messenger media send failed: ${res.status}`);
    }
    return { externalMessageId: res.body['recipient'] ? String(res.body['message_id'] ?? '') : null };
  }
}

export class TelegramSender implements ChannelSender {
  readonly platform = 'telegram';

  constructor(private readonly channels: ChannelsService) {}

  async sendMedia(_request: SendMediaRequest): Promise<SendTextResult> {
    // FL-2.27: Telegram outbound media is a documented non-goal for v1.
    return { externalMessageId: null };
  }

  async send(request: SendRequest): Promise<SendTextResult> {
    const creds = this.channels.decryptCredentials(request.account);
    const botToken = String(creds.bot_token ?? '');
    if (!botToken) {
      throw new PermanentSendError('telegram account missing bot_token');
    }
    // Telegram: ~4096 chars per message — chunk with hard cap.
    const chunks = chunkText(request.text, 4000, 5);
    let lastId: string | null = null;
    for (const chunk of chunks) {
      const res = await postJson(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        chat_id: request.externalUserId,
        text: chunk,
      });
      assertOk(res.status, res.body, 'telegram');
      const result = res.body.result as { message_id?: number } | undefined;
      lastId = result?.message_id !== undefined ? String(result.message_id) : lastId;
    }
    return { externalMessageId: lastId };
  }
}

@Injectable()
export class WebSender implements ChannelSender {
  readonly platform = 'web';

  async sendMedia(_request: SendMediaRequest): Promise<SendTextResult> {
    // Telegram/web outbound media: documented non-goal for v1 (FL-2.27 covers
    // WhatsApp + Messenger); falls back to the text path with a link.
    return { externalMessageId: null };
  }

  async send(_request: SendRequest): Promise<SendTextResult> {
    // The widget consumes run_events over its session SSE stream — no push
    // send exists. Mark delivered; the stream's engine_sequence cursor is
    // the delivery mechanism.
    return { externalMessageId: null };
  }
}

/**
 * FL-3.17 — Instagram DMs ride the SAME Meta Graph Send API as Messenger
 * (Instagram Professional accounts); credentials reuse the app_secret/
 * access_token pair and the webhook plane shares verify + signature.
 */
@Injectable()
export class InstagramSender implements ChannelSender {
  readonly platform = 'instagram';

  constructor(private readonly channels: ChannelsService) {}

  async send(request: SendRequest): Promise<SendTextResult> {
    const creds = this.channels.decryptCredentials(request.account);
    const res = await postJson(`https://graph.facebook.com/${META_GRAPH_VERSION}/me/messages`, {
      recipient: { id: request.externalUserId },
      message: { text: request.text.slice(0, 1000) },
    }, String(creds.access_token ?? ''));
    assertOk(res.status, res.body, 'instagram');
    return { externalMessageId: String((res.body.message_id as string | undefined) ?? '') || null };
  }

  async sendMedia(request: SendMediaRequest): Promise<SendTextResult> {
    const creds = this.channels.decryptCredentials(request.account);
    const res = await postJson(
      `https://graph.facebook.com/${META_GRAPH_VERSION}/me/messages`,
      {
        recipient: { id: request.externalUserId },
        message: {
          attachment: {
            type: request.mediaType.startsWith('image/') ? 'image' : 'file',
            payload: { is_reusable: false, url: request.mediaUrl },
          },
        },
      },
      String(creds.access_token ?? ''),
    );
    if (res.status >= 400 && res.status !== 429) {
      throw new PermanentSendError(`instagram media send rejected: ${res.status}`);
    }
    if (res.status >= 400) {
      throw new Error(`instagram media send failed: ${res.status}`);
    }
    return { externalMessageId: String((res.body.message_id as string | undefined) ?? '') || null };
  }
}

/**
 * FL-3.17 — X DMs via API v2 (OAuth2 user-context bearer on the account).
 * Outbound replies go to the participant DM conversation; the webhook plane
 * verifies CRC + X-Hub-Signature-256.
 */
@Injectable()
export class XSender implements ChannelSender {
  readonly platform = 'x';

  constructor(private readonly channels: ChannelsService) {}

  async send(request: SendRequest): Promise<SendTextResult> {
    const creds = this.channels.decryptCredentials(request.account);
    const token = String(creds.access_token ?? '');
    if (!token) {
      throw new PermanentSendError('x account missing access_token');
    }
    const res = await postJson(
      `https://api.x.com/2/dm_conversations/with/${encodeURIComponent(request.externalUserId)}/messages`,
      { text: request.text.slice(0, 10000) },
      token,
    );
    assertOk(res.status, res.body, 'x');
    const data = res.body['data'] as { id?: string } | undefined;
    return { externalMessageId: data?.id ?? null };
  }

  async sendMedia(_request: SendMediaRequest): Promise<SendTextResult> {
    // X outbound media requires a chunked upload flow — documented v1 non-goal.
    return { externalMessageId: null };
  }
}

/**
 * FL-3.17 — email channel over a generic HTTP email API seam
 * (CHANNELS__EMAIL_API_URL + bearer key: POST {to, subject, text}). Inbound
 * rides the inbound-parse webhook with the shared X-Webhook-Secret.
 */
@Injectable()
export class EmailSender implements ChannelSender {
  readonly platform = 'email';

  constructor(private readonly channels: ChannelsService) {}

  async send(request: SendRequest): Promise<SendTextResult> {
    const url = env.CHANNELS__EMAIL_API_URL;
    if (!url) {
      throw new PermanentSendError('email channel requires CHANNELS__EMAIL_API_URL');
    }
    const creds = this.channels.decryptCredentials(request.account);
    const fromAddress = String(creds.from_address ?? env.EMAIL_FROM);
    const res = await postJson(url, {
      to: request.externalUserId,
      from: fromAddress,
      subject: request.text.split('\n')[0].slice(0, 120) || 'Message from the assistant',
      text: request.text.slice(0, 20_000),
    }, env.CHANNELS__EMAIL_API_KEY || undefined);
    assertOk(res.status, res.body, 'email');
    return { externalMessageId: String((res.body.id as string | undefined) ?? '') || null };
  }

  async sendMedia(_request: SendMediaRequest): Promise<SendTextResult> {
    // Email attachments require MIME multipart assembly — documented v1 non-goal.
    return { externalMessageId: null };
  }
}

function chunkText(text: string, size: number, maxChunks: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length && out.length < maxChunks; i += size) {
    out.push(text.slice(i, i + size));
  }
  if (text.length > size * maxChunks) {
    out[maxChunks - 1] = `${out[maxChunks - 1].slice(0, size - 1)}…`;
  }
  return out.length > 0 ? out : [''];
}
