import { Injectable, Logger } from '@nestjs/common';
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
 * Every send: render from the registry → rate-limited → transport →
 * delivery-audit row → privileged sends audited on the shared chain.
 * A failed send records a `failed` row and rethrows — callers decide
 * whether failure is fatal (login codes: yes) or retriable (invites).
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly transport: EmailTransport;

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
  }): Promise<void> {
    const { subject, text, html } = renderTemplate(input.template, input.vars);

    // Global per-recipient rate limit (abuse ceiling on top of route limits).
    const window = Math.floor(Date.now() / 60_000);
    const key = `email:rl:${input.to.toLowerCase()}:${window}`;
    const count = (await this.redis.raw.incr(key).catch(() => 0)) as number;
    if (count === 1) {
      await this.redis.raw.expire(key, 120).catch(() => undefined);
    }
    if (count > env.EMAIL_RATE_LIMIT_PER_MINUTE) {
      throw new Error('email rate limit exceeded for recipient');
    }

    const message: EmailMessage = { template: input.template, to: input.to, subject, text, html };
    let status: 'sent' | 'failed' = 'sent';
    let error: string | null = null;
    try {
      await this.transport.send(message);
    } catch (err) {
      status = 'failed';
      error = (err as Error).message;
      this.logger.error(`email send failed template=${input.template} to=${input.to}: ${error}`);
    }

    await this.recordDelivery(message, status, error, input.metadata).catch((err) => {
      this.logger.error(`email delivery row failed: ${(err as Error).message}`);
    });

    if (status === 'failed') {
      throw new Error(`email delivery failed: ${error}`);
    }
  }

  private async recordDelivery(message: EmailMessage, status: string, error: string | null, metadata?: Record<string, unknown>): Promise<void> {
    await this.db.root.insert(emailDeliveries).values({
      template: message.template,
      recipient: message.to,
      subject: message.subject,
      transport: this.transport.name,
      status,
      error,
      metadata: metadata ?? {},
    });
  }
}
