import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { env } from '../../../common/config/env';
import { EmailTransport, EmailMessage } from './email-transport.port';

/** Dev transport: writes RFC-822-ish files to EMAIL_FILE_PATH. Deterministic, offline-safe. */
export class FileEmailTransport implements EmailTransport {
  readonly name = 'file';
  private sequence = 0;

  async send(message: EmailMessage): Promise<void> {
    const dir = env.EMAIL_FILE_PATH;
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = join(dir, `${stamp}-${++this.sequence}-${message.template}.eml`);
    const body = [
      `From: ${env.EMAIL_FROM}`,
      `To: ${message.to}`,
      `Subject: ${message.subject}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      message.text,
      ...(message.html ? ['', '--html--', '', message.html] : []),
    ].join('\n');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, body, 'utf8');
  }
}

/** Resend (resend.com) over its HTTP API — no SDK dependency needed. */
export class ResendEmailTransport implements EmailTransport {
  readonly name = 'resend';

  async send(message: EmailMessage): Promise<void> {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`resend accepted=${response.status}: ${await response.text().catch(() => 'unreadable')}`);
    }
  }
}

/** Postmark over its HTTP API. */
export class PostmarkEmailTransport implements EmailTransport {
  readonly name = 'postmark';

  async send(message: EmailMessage): Promise<void> {
    const response = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-postmark-server-token': env.POSTMARK_SERVER_TOKEN,
      },
      body: JSON.stringify({
        From: env.EMAIL_FROM,
        To: message.to,
        Subject: message.subject,
        TextBody: message.text,
        ...(message.html ? { HtmlBody: message.html } : {}),
        MessageStream: 'outbound',
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`postmark rejected=${response.status}: ${await response.text().catch(() => 'unreadable')}`);
    }
  }
}

/** Explicit no-op for environments that must not send (tests, dry runs). */
export class NoneEmailTransport implements EmailTransport {
  readonly name = 'none';
  async send(): Promise<void> {
    /* intentional */
  }
}

export function transportForKind(kind: typeof env.EMAIL_TRANSPORT): EmailTransport {
  switch (kind) {
    case 'file':
      return new FileEmailTransport();
    case 'resend':
      if (!env.RESEND_API_KEY) {
        throw new Error('EMAIL_TRANSPORT=resend requires RESEND_API_KEY');
      }
      return new ResendEmailTransport();
    case 'postmark':
      if (!env.POSTMARK_SERVER_TOKEN) {
        throw new Error('EMAIL_TRANSPORT=postmark requires POSTMARK_SERVER_TOKEN');
      }
      return new PostmarkEmailTransport();
    case 'none':
    default:
      return new NoneEmailTransport();
  }
}
