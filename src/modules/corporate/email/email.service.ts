import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { env } from '../../../common/config/env';
import { DbService } from '../../../common/infra/db/db.service';
import { RedisService } from '../../../common/infra/redis.service';
import { AuditService } from '../../../common/audit/audit.service';
import { EmailMessage, EmailTransport } from './email-transport.port';
import { transportForKind } from './transports';
import { renderTemplate } from './templates';
import { emailDeliveries } from './schema';

/**
 * The email service (corporate E-1 — built FIRST because identity's
 * email-code login is dead code without it; resolves doc-06 Q1).
 *
 * Every send: suppression check → render from the registry → rate-limited
 * → transport → delivery-audit row. A failed send records a `failed` row
 * and rethrows — callers decide whether failure is fatal (login codes:
 * yes) or retriable (invites). A SUPPRESSED address records a `skipped`
 * row and returns normally: the caller's flow proceeds (the decision not
 * to mail is not an error), and sender reputation stays intact.
 *
 * Optional `unsubscribeUrl` adds List-Unsubscribe + RFC 8058 one-click
 * headers — the deliverability contract bulk mail must carry.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly transport: EmailTransport;
  private readonly suppressedCache = new Map<string, boolean>(); // 60s TTL; suppression is append-heavy

  constructor(
    private readonly db: DbService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
  ) {
    this.transport = transportForKind(env.EMAIL_TRANSPORT);
  }

  async sendTemplate(input: {
    template: string;
    to: string;
    vars: Record<string, string>;
    metadata?: Record<string, unknown>;
    unsubscribeUrl?: string;
  }): Promise<void> {
    const to = input.to.toLowerCase();
    if (await this.isSuppressed(to)) {
      await this.recordDelivery(
        { template: input.template, to, subject: `[suppressed] ${input.template}`, text: '', transport: this.transport.name },
        'skipped',
        'suppressed address',
        input.metadata,
      );
      return;
    }

    const { subject, text, html } = renderTemplate(input.template, input.vars);

    // Global per-recipient rate limit (abuse ceiling on top of route limits).
    const window = Math.floor(Date.now() / 60_000);
    const key = `email:rl:${to}:${window}`;
    const count = (await this.redis.raw.incr(key).catch(() => 0)) as number;
    if (count === 1) {
      await this.redis.raw.expire(key, 120).catch(() => undefined);
    }
    if (count > env.EMAIL_RATE_LIMIT_PER_MINUTE) {
      throw new Error('email rate limit exceeded for recipient');
    }

    const headers: Record<string, string> | undefined = input.unsubscribeUrl
      ? {
          'List-Unsubscribe': `<${input.unsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        }
      : undefined;

    const message: EmailMessage = { template: input.template, to, subject, text, html, headers };
    let status: 'sent' | 'failed' = 'sent';
    let error: string | null = null;
    try {
      await this.transport.send(message);
    } catch (err) {
      status = 'failed';
      error = (err as Error).message;
      this.logger.error(`email send failed template=${input.template} to=${to}: ${error}`);
    }

    await this.recordDelivery(
      { template: message.template, to: message.to, subject: message.subject, text: message.text, transport: this.transport.name },
      status,
      error,
      input.metadata,
    ).catch((err) => {
      this.logger.error(`email delivery row failed: ${(err as Error).message}`);
    });

    if (status === 'failed') {
      throw new Error(`email delivery failed: ${error}`);
    }
  }

  /** Suppression check with a short in-process cache (append-heavy list). */
  async isSuppressed(email: string): Promise<boolean> {
    const cached = this.suppressedCache.get(email);
    if (cached !== undefined) {
      return cached;
    }
    const rows = await this.db.root.execute<{ id: string }>(
      sql`select id from email_suppressions where email = ${email} limit 1`,
    );
    const suppressed = rows.rows.length > 0;
    this.suppressedCache.set(email, suppressed);
    if (this.suppressedCache.size > 5000) {
      this.suppressedCache.clear(); // crude TTL: drop everything at 5k entries
    }
    return suppressed;
  }

  /** Called by the suppression service so the cache reflects new entries. */
  invalidateSuppressionCache(): void {
    this.suppressedCache.clear();
  }

  private async recordDelivery(
    message: Pick<EmailMessage, 'template' | 'to' | 'subject' | 'text'> & { transport: string },
    status: string,
    error: string | null,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.db.root.insert(emailDeliveries).values({
      template: message.template,
      recipient: message.to,
      subject: message.subject,
      transport: message.transport,
      status,
      error,
      metadata: metadata ?? {},
    });
  }
}
