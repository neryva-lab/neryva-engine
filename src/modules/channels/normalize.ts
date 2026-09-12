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
      kind: 'status';
      externalEventId: string;
      externalMessageId: string;
      status: 'sent' | 'delivered' | 'read' | 'failed';
      errorCode?: string;
      errorMessage?: string;
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
        return {
          kind: 'message',
          externalEventId: `ms:${String(message.mid)}`,
          externalMessageId: String(message.mid),
          externalUserId: String(sender?.id ?? ''),
          text: String(message.text ?? ''),
          timestampMs,
        };
      }
      // read receipts / delivery confirms: message_read etc. — not a user message
      if (m && !message) {
        return { kind: 'unsupported', externalEventId: `ms:${hashEventId(JSON.stringify(m))}`, reason: 'non-message messaging entry (echo/read/delivery)' };
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

/** Stale-event floor: platform redeliveries older than this are quarantined. */
export const STALE_EVENT_MS = 7 * 24 * 3600 * 1000;

/** Dispatch by platform — the ingest path's single normalization entry point. */
export function normalizeFor(platform: string, body: unknown, rawBody: string): NormalizedEvent {
  switch (platform) {
    case 'whatsapp':
      return normalizeWhatsApp(body, rawBody);
    case 'messenger':
      return normalizeMessenger(body, rawBody);
    case 'telegram':
      return normalizeTelegram(body, rawBody);
    default:
      return { kind: 'unsupported', externalEventId: `x:${createHash('sha256').update(rawBody).digest('hex').slice(0, 32)}`, reason: `unsupported platform ${platform}` };
  }
}
