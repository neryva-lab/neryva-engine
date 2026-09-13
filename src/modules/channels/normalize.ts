import { createHash } from 'node:crypto';

/**
 * Channel payload normalizers (Phase C2). Pure functions: platform JSON →
 * canonical events. They NEVER touch the DB and NEVER throw on unexpected
 * shapes — an unrecognized envelope normalizes to `{ kind: 'unsupported' }`
 * so the ingest path can quarantine instead of crash.
 */

export type NormalizedEvent =
  | {
      kind: 'message';
      externalEventId: string;
      externalMessageId: string;
      externalUserId: string;
      text: string;
      timestampMs: number | null;
      profileName?: string;
      locale?: string;
    }
  | {
      /** FL-3.1/FL-2.6 — media (voice note, image, document) with a provider media id. */
      kind: 'media';
      externalEventId: string;
      externalMessageId: string;
      externalUserId: string;
      mediaFamily: 'audio' | 'image' | 'document';
      mediaId: string;
      mediaUrl?: string;
      mimeType?: string;
      timestampMs: number | null;
      profileName?: string;
    }
  | {
      kind: 'status';
      externalEventId: string;
      externalMessageId: string;
      status: 'sent' | 'delivered' | 'read' | 'failed';
      errorCode?: string;
      errorMessage?: string;
      occurredAtMs?: number;
    }
  | { kind: 'unsupported'; externalEventId: string; reason: string };

function hashEventId(body: string): string {
  return `h:${createHash('sha256').update(body).digest('hex').slice(0, 32)}`;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

// ── WhatsApp Business Cloud API ─────────────────────────────────────────────
// POST body: { object: 'whatsapp_business_account', entry: [{ id: waba_id,
//   changes: [{ value: { messaging_product, metadata: { phone_number_id },
//   contacts?: [{ profile: { name }, wa_id }], messages?: [{ from, id, timestamp, type, text? }], statuses?: [{ id, status, errors? }] }, field }] }] }

export function normalizeWhatsApp(body: unknown, rawBody: string): NormalizedEvent {
  const root = asRecord(body);
  const entries = asArray(root?.entry);
  for (const entry of entries) {
    const entryRec = asRecord(entry);
    for (const change of asArray(entryRec?.changes)) {
      const value = asRecord(asRecord(change)?.value);
      const metadata = asRecord(value?.metadata);
      const phoneNumberId = String(metadata?.phone_number_id ?? '');
      const entryId = String(entryRec?.id ?? '');
      const messages = asArray(value?.messages);
      if (messages.length > 0) {
        const m = asRecord(messages[0]);
        const text = asRecord(m?.text);
        const contact = asRecord(asArray(value?.contacts)[0]);
        const profile = asRecord(contact?.profile);
        // FL-3.1 — voice notes / audio / images / documents carry a provider
        // media id; the ingest path downloads (bounded) and transcribes them.
        const type = String(m?.type ?? '');
        const mediaRec = asRecord(m?.[type]);
        const mediaId = String(mediaRec?.id ?? '');
        if ((type === 'audio' || type === 'voice' || type === 'image' || type === 'document') && mediaId) {
          return {
            kind: 'media',
            externalEventId: `wa:${entryId || phoneNumberId}:${String(m?.id ?? hashEventId(rawBody))}`,
            externalMessageId: String(m?.id ?? ''),
            externalUserId: String(m?.from ?? contact?.wa_id ?? ''),
            mediaFamily: type === 'voice' || type === 'audio' ? 'audio' : type === 'image' ? 'image' : 'document',
            mediaId,
            mimeType: typeof mediaRec?.mime_type === 'string' ? String(mediaRec.mime_type) : undefined,
            timestampMs: m?.timestamp !== undefined ? Number(m.timestamp) * 1000 : null,
            profileName: profile?.name ? String(profile.name) : undefined,
          };
        }
        return {
          kind: 'message',
          externalEventId: `wa:${entryId || phoneNumberId}:${String(m?.id ?? hashEventId(rawBody))}`,
          externalMessageId: String(m?.id ?? ''),
          externalUserId: String(m?.from ?? contact?.wa_id ?? ''),
          text: String(text?.body ?? ''),
          timestampMs: m?.timestamp !== undefined ? Number(m.timestamp) * 1000 : null,
          profileName: profile?.name ? String(profile.name) : undefined,
        };
      }
      const statuses = asArray(value?.statuses);
      if (statuses.length > 0) {
        const s = asRecord(statuses[0]);
        const errors = asArray(s?.errors);
        const errRec = asRecord(errors[0]);
        return {
          kind: 'status',
          externalEventId: `wa-status:${entryId}:${String(s?.id ?? hashEventId(rawBody))}:${String(s?.status ?? '')}`,
          externalMessageId: String(s?.id ?? ''),
          status: (['sent', 'delivered', 'read', 'failed'] as const).includes(String(s?.status) as 'sent')
            ? (String(s?.status) as 'sent' | 'delivered' | 'read' | 'failed')
            : 'sent',
          errorCode: errRec ? String(errRec.code ?? '') : undefined,
          errorMessage: errRec ? String((errRec as { title?: string }).title ?? '').slice(0, 250) : undefined,
          occurredAtMs: s?.timestamp !== undefined ? Number(s.timestamp) * 1000 : undefined,
        };
      }
    }
  }
  return { kind: 'unsupported', externalEventId: `wa:${hashEventId(rawBody)}`, reason: 'no messages or statuses in envelope' };
}

// ── Messenger Platform ──────────────────────────────────────────────────────
// POST body: { object: 'page', entry: [{ id: page_id, time, messaging: [
//   { sender: { id }, recipient: { id }, timestamp, message: { mid, text } } ] }] }

export function normalizeMessenger(body: unknown, rawBody: string): NormalizedEvent {
  const root = asRecord(body);
  const entries = asArray(root?.entry);
  for (const entry of entries) {
    const entryRec = asRecord(entry);
    for (const messaging of asArray(entryRec?.messaging)) {
      const m = asRecord(messaging);
      const message = asRecord(m?.message);
      const sender = asRecord(m?.sender);
      const timestampMs = m?.timestamp !== undefined ? Number(m.timestamp) : null;
      if (message && typeof message.mid === 'string') {
        const mid = String(message.mid);
        // Media attachments (image/audio/file) — Messenger hands a CDN URL.
        const attachments = asArray(message.attachments);
        const first = asRecord(attachments[0]);
        const payload = asRecord(first?.payload);
        const attachUrl = typeof payload?.url === 'string' ? payload.url : undefined;
        const attachType = String(first?.type ?? '');
        if (attachUrl && (attachType === 'image' || attachType === 'audio' || attachType === 'file')) {
          return {
            kind: 'media',
            externalEventId: `ms:${mid}`,
            externalMessageId: mid,
            externalUserId: String(sender?.id ?? ''),
            mediaFamily: attachType === 'image' ? 'image' : attachType === 'audio' ? 'audio' : 'document',
            mediaId: mid,
            mediaUrl: attachUrl,
            timestampMs,
          };
        }
        return {
          kind: 'message',
          externalEventId: `ms:${mid}`,
          externalMessageId: mid,
          externalUserId: String(sender?.id ?? ''),
          text: String(message.text ?? ''),
          timestampMs,
        };
      }
      // FL-3.19 — read receipts (watermark: every message up to `mid` was
      // read) and delivery confirms normalize to status events.
      if (m && !message) {
        const read = asRecord(m?.read);
        const delivery = asRecord(m?.delivery);
        if (read && typeof read.mid === 'string' && read.mid) {
          return {
            kind: 'status',
            externalEventId: `ms-read:${String(read.mid)}:${String(read.seq ?? '')}`,
            externalMessageId: String(read.mid),
            status: 'read',
            occurredAtMs: timestampMs ?? undefined,
          };
        }
        if (delivery && Array.isArray(delivery.mids) && delivery.mids.length > 0) {
          const mid = String(delivery.mids[0]);
          return {
            kind: 'status',
            externalEventId: `ms-deliver:${mid}:${String(delivery.watermark ?? hashEventId(JSON.stringify(m)))}`,
            externalMessageId: mid,
            status: 'delivered',
            occurredAtMs: Number(delivery.watermark) || timestampMs || undefined,
          };
        }
        return { kind: 'unsupported', externalEventId: `ms:${hashEventId(JSON.stringify(m))}`, reason: 'non-message messaging entry (echo/typing)' };
      }
    }
  }
  return { kind: 'unsupported', externalEventId: `ms:${hashEventId(rawBody)}`, reason: 'no messaging entries' };
}

// ── Telegram Bot API ────────────────────────────────────────────────────────
// POST body: { update_id: number, message?: { message_id, from: { id, first_name, language_code }, text?, date } }

export function normalizeTelegram(body: unknown, rawBody: string): NormalizedEvent {
  const root = asRecord(body);
  const updateId = root?.update_id;
  const message = asRecord(root?.message);
  if (!message) {
    return { kind: 'unsupported', externalEventId: `tg:${String(updateId ?? hashEventId(rawBody))}`, reason: 'no message in update (callback/edited/etc.)' };
  }
  const from = asRecord(message.from);
  // FL-3.1 — Telegram voice/audio notes arrive as file ids; the ingest path
  // resolves the download URL via getFile before transcription.
  for (const [field, family] of [['voice', 'audio'], ['audio', 'audio'], ['photo', 'image'], ['document', 'document']] as const) {
    const media = asRecord(message[field]);
    const fileId = String(media?.file_id ?? '');
    if (media && fileId) {
      return {
        kind: 'media',
        externalEventId: `tg:${String(updateId ?? hashEventId(rawBody))}`,
        externalMessageId: String(message.message_id ?? ''),
        externalUserId: String(from?.id ?? ''),
        mediaFamily: family,
        mediaId: fileId,
        mimeType: typeof media.mime_type === 'string' ? String(media.mime_type) : undefined,
        timestampMs: message.date !== undefined ? Number(message.date) * 1000 : null,
        profileName: from?.first_name ? String(from.first_name) : undefined,
      };
    }
  }
  return {
    kind: 'message',
    externalEventId: `tg:${String(updateId ?? hashEventId(rawBody))}`,
    externalMessageId: String(message.message_id ?? ''),
    externalUserId: String(from?.id ?? ''),
    text: String(message.text ?? ''),
    timestampMs: message.date !== undefined ? Number(message.date) * 1000 : null,
    profileName: from?.first_name ? String(from.first_name) : undefined,
    locale: from?.language_code ? String(from.language_code) : undefined,
  };
}

// ── X (webhook payload, account-events shape) ───────────────────────────────
// CRC verification is handled at the transport; the body is the X webhook
// envelope: { for_user_id, tweet_create_events?: [...], direct_message_events?: [...] }.
export function normalizeX(body: unknown, rawBody: string): NormalizedEvent {
  const root = asRecord(body);
  const tweets = asArray(root?.tweet_create_events);
  for (const t of tweets) {
    const tweet = asRecord(t);
    const user = asRecord(tweet?.user);
    // An inbound mention with a durable tweet id — dedup rides externalEventId.
    if (tweet && typeof tweet.id_str === 'string' && user && typeof user.screen_name === 'string') {
      return {
        kind: 'message',
        externalEventId: `x:${String(tweet.id_str)}`,
        externalMessageId: String(tweet.id_str),
        externalUserId: String(user.screen_name),
        text: String(tweet.text ?? '').slice(0, 1000),
        timestampMs: tweet.timestamp_ms !== undefined ? Number(tweet.timestamp_ms) : null,
        profileName: user.name ? String(user.name) : undefined,
      };
    }
  }
  const dms = asArray(root?.direct_message_events);
  for (const d of dms) {
    const dm = asRecord(d);
    const create = asRecord(dm?.message_create);
    const senderId = String(create?.sender_id ?? '');
    const data = asRecord(create?.message_data);
    if (dm && dm.type === 'message_create' && data && typeof data.text === 'string') {
      return {
        kind: 'message',
        externalEventId: `x-dm:${String(dm.id ?? hashEventId(rawBody))}`,
        externalMessageId: String(dm.id ?? ''),
        externalUserId: senderId,
        text: String(data.text).slice(0, 2000),
        timestampMs: create?.created_timestamp !== undefined ? Number(create.created_timestamp) : null,
      };
    }
  }
  return { kind: 'unsupported', externalEventId: `x:${hashEventId(rawBody)}`, reason: 'no tweet/DM events' };
}

// ── Email (inbound-parse webhook, Postmark-class shape + generic fallback) ──
export function normalizeEmail(body: unknown, rawBody: string): NormalizedEvent {
  const root = asRecord(body);
  const from = String(root?.From ?? root?.from ?? '');
  const subject = String(root?.Subject ?? root?.subject ?? '');
  const text = String(root?.TextBody ?? root?.text ?? '');
  const messageId = String(root?.MessageID ?? root?.message_id ?? '');
  if (!from || !text.trim()) {
    return { kind: 'unsupported', externalEventId: `email:${hashEventId(rawBody)}`, reason: 'no sender or text body' };
  }
  return {
    kind: 'message',
    externalEventId: `email:${messageId || hashEventId(rawBody)}`,
    externalMessageId: messageId || hashEventId(rawBody),
    externalUserId: from.slice(0, 255),
    text: (subject ? `Re a conversation about "${subject.slice(0, 120)}":\n` : '') + text.slice(0, 8000),
    timestampMs: root?.Date !== undefined && !Number.isNaN(Date.parse(String(root.Date))) ? Date.parse(String(root.Date)) : null,
  };
}

/** Stale-event floor: platform redeliveries older than this are quarantined. */
export const STALE_EVENT_MS = 7 * 24 * 3600 * 1000;

/** Dispatch by platform — the ingest path's single normalization entry point. */
export function normalizeFor(platform: string, body: unknown, rawBody: string): NormalizedEvent {
  switch (platform) {
    case 'whatsapp':
      return normalizeWhatsApp(body, rawBody);
    case 'messenger':
    case 'instagram':
      // Instagram shares the Meta Graph webhook contract (object: 'instagram').
      return normalizeMessenger(body, rawBody);
    case 'telegram':
      return normalizeTelegram(body, rawBody);
    case 'x':
      return normalizeX(body, rawBody);
    case 'email':
      return normalizeEmail(body, rawBody);
    default:
      return { kind: 'unsupported', externalEventId: `x:${createHash('sha256').update(rawBody).digest('hex').slice(0, 32)}`, reason: `unsupported platform ${platform}` };
  }
}
