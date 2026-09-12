import { Injectable } from '@nestjs/common';
import { ChannelAccount } from './schema';
import { ChannelsService } from './channels.service';
import { META_GRAPH_VERSION } from './dto';

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

export interface ChannelSender {
  readonly platform: string;
  send(request: SendRequest): Promise<SendTextResult>;
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
}

@Injectable()
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
}

@Injectable()
export class TelegramSender implements ChannelSender {
  readonly platform = 'telegram';

  constructor(private readonly channels: ChannelsService) {}

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

  async send(_request: SendRequest): Promise<SendTextResult> {
    // The widget consumes run_events over its session SSE stream — no push
    // send exists. Mark delivered; the stream's engine_sequence cursor is
    // the delivery mechanism.
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
