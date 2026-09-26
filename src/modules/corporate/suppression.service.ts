import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { constantTimeEquals } from '../../common/infra/crypto/envelope';
import { env } from '../../common/config/env';
import { SUPPRESSION_REPOSITORY } from './repositories/repository-tokens';
import type { EmailSuppressionRow, ISuppressionRepository } from './repositories/suppression.repository';

/**
 * The email suppression list (E-1's reputation guard): hard bounces, spam
 * complaints, unsubscribes, manual holds. The EmailService consults it
 * before every send — a suppressed address NEVER receives mail (skipped +
 * recorded), because sending to known-bad addresses is how domains land on
 * blocklists.
 *
 * Ingestion: provider webhooks (`POST /public/email/webhook`). The
 * endpoint is authenticated by a shared secret (`X-Webhook-Secret`,
 * constant-time) — the one mechanism both Resend and Postmark can be
 * configured to send on every event; payloads are then parsed per provider
 * shape (Resend: `{type: 'email.bounced'|'email.complained', data:{to}}`;
 * Postmark: `{Type: 'Bounce'|'SpamComplaint', MessageID, ContactEmail?}` —
 * Postmark bounce webhooks carry the recipient in `Message` headers of
 * `OriginalRecipient`/`EmailAddress` depending on stream; every plausible
 * field is checked, and unknown shapes are logged, never crash).
 *
 * Persistence-blind (P3): all storage goes through `ISuppressionRepository`.
 * Corporate tables are global (non-tenant).
 */
export type SuppressionReason = 'hard_bounce' | 'complaint' | 'unsubscribe' | 'manual';

@Injectable()
export class SuppressionService {
  private static readonly logger = new Logger(SuppressionService.name);

  constructor(
    @Inject(SUPPRESSION_REPOSITORY) private readonly suppressions: ISuppressionRepository,
    private readonly audit: AuditService,
  ) {}

  async isSuppressed(email: string): Promise<boolean> {
    return this.suppressions.isSuppressed(email);
  }

  async suppress(input: { email: string; reason: SuppressionReason; detail?: string; actorId?: string }): Promise<void> {
    const email = input.email.toLowerCase();
    // An unsubscribe also flips the subscriber row (kept consistent here,
    // at the one chokepoint both flows share — in the repository).
    await this.suppressions.suppress({ email, reason: input.reason, detail: input.detail });
    await this.audit.add({
      action: 'email.suppressed',
      resourceType: 'email_suppression',
      actorType: 'system',
      details: { reason: input.reason, email_domain: email.split('@')[1] ?? '' },
    });
  }

  /** Staff: the list + resolve (a fixed address may mail again). */
  async list(limit = 200): Promise<EmailSuppressionRow[]> {
    return this.suppressions.listSuppressions(limit);
  }

  async resolve(email: string, actorId: string): Promise<void> {
    const id = await this.suppressions.resolveSuppression(email);
    await this.audit.add({
      action: 'email.suppression_resolved',
      resourceType: 'email_suppression',
      resourceId: id,
      actorType: 'account',
      actorId,
      details: {},
    });
  }

  /** The webhook ingestion: verify secret → parse per provider → suppress. */
  async ingestWebhook(rawBody: unknown, secretHeader: string | undefined): Promise<{ accepted: number; suppressed: number; ignored: number }> {
    if (!env.EMAIL_WEBHOOK_SECRET) {
      throw ApiError.forbidden('email webhooks are not configured (EMAIL_WEBHOOK_SECRET unset)');
    }
    if (!secretHeader || !constantTimeEquals(secretHeader, env.EMAIL_WEBHOOK_SECRET)) {
      throw ApiError.unauthenticated('invalid webhook secret');
    }

    const events = Array.isArray((rawBody as { events?: unknown[] })?.events) ? (rawBody as { events: unknown[] }).events : [rawBody];
    let suppressed = 0;
    let ignored = 0;
    for (const event of events) {
      const parsed = parseProviderEvent(event);
      if (!parsed) {
        ignored += 1;
        SuppressionService.logger.debug('ignored non-bounce webhook event');
        continue;
      }
      await this.suppress(parsed);
      suppressed += 1;
    }
    return { accepted: events.length, suppressed, ignored };
  }
}

/** Recognize bounce/complaint events across the two supported providers. */
function parseProviderEvent(event: unknown): { email: string; reason: SuppressionReason; detail: string } | null {
  if (typeof event !== 'object' || event === null) {
    return null;
  }
  const e = event as Record<string, unknown>;

  // Resend: { type: 'email.bounced' | 'email.complained', data: { to, ... } }
  if (typeof e.type === 'string' && e.type.startsWith('email.')) {
    const data = (e.data ?? {}) as Record<string, unknown>;
    const to = typeof data.to === 'string' ? data.to : null;
    if (!to) {
      return null;
    }
    if (e.type === 'email.bounced') {
      return { email: to, reason: 'hard_bounce', detail: `resend: ${String(data.message ?? 'bounce')}`.slice(0, 512) };
    }
    if (e.type === 'email.complained') {
      return { email: to, reason: 'complaint', detail: 'resend: spam complaint' };
    }
    return null;
  }

  // Postmark: { Type: 'Bounce' | 'SpamComplaint', EmailAddress | OriginalRecipient | ContactEmail, Details }
  if (typeof e.Type === 'string') {
    const email =
      typeof e.EmailAddress === 'string' && e.EmailAddress.includes('@')
        ? e.EmailAddress
        : typeof e.OriginalRecipient === 'string'
          ? e.OriginalRecipient
          : typeof e.ContactEmail === 'string' && e.ContactEmail.includes('@')
            ? e.ContactEmail
            : null;
    if (!email) {
      return null;
    }
    if (e.Type === 'Bounce') {
      // Only HARD bounces suppress; soft bounces (Type 'SoftBounce' arrives
      // separately) are transient by definition.
      return { email, reason: 'hard_bounce', detail: `postmark: ${String(e.Details ?? 'bounce')}`.slice(0, 512) };
    }
    if (e.Type === 'SpamComplaint') {
      return { email, reason: 'complaint', detail: 'postmark: spam complaint' };
    }
    return null;
  }

  return null;
}
