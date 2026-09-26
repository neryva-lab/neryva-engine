import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { env } from '../../common/config/env';
import { EmailService } from './email/email.service';
import { SuppressionService } from './suppression.service';
import { NewsletterService } from './newsletter.service';
import { CONTACT_INBOX_REPOSITORY } from './repositories/repository-tokens';
import type { IContactInboxRepository } from './repositories/contact-inbox.repository';

/**
 * The contact inbox (E-2 to production grade): submissions land public-side
 * (FormsService), then staff works them through the pipeline
 * new → read → replied → archived with notes. Every submission ALSO gets:
 *  - an acknowledgment email to the sender (suppression-aware), and
 *  - a team-notification email when CORPORATE_CONTACT_INBOX_EMAIL is set
 *    (the "who contacts us should hear back AND wake a human" pair).
 * opt_in_updates=true flows the sender into the newsletter PENDING state
 * (they still confirm — double opt-in is not bypassed by a checkbox).
 *
 * Persistence-blind (P3): all storage goes through `IContactInboxRepository`.
 * Corporate tables are global (non-tenant).
 */
export const CONTACT_STATUSES = ['new', 'read', 'replied', 'archived'] as const;
export type ContactStatus = (typeof CONTACT_STATUSES)[number];
const CONTACT_TRANSITIONS: Record<ContactStatus, readonly ContactStatus[]> = {
  new: ['read', 'replied', 'archived'],
  read: ['replied', 'archived', 'new'],
  replied: ['archived'],
  archived: ['new'],
};

@Injectable()
export class ContactInboxService {
  constructor(
    @Inject(CONTACT_INBOX_REPOSITORY) private readonly inbox: IContactInboxRepository,
    private readonly audit: AuditService,
    private readonly email: EmailService,
    private readonly suppressions: SuppressionService,
    private readonly newsletter: NewsletterService,
  ) {}

  /** Public-side intake: store + ack + team notification + opt-in flow. */
  async intake(input: {
    name: string;
    email: string;
    company?: string;
    message: string;
    optInUpdates: boolean;
    ip: string | null;
  }): Promise<void> {
    if ((input.message.match(/https?:\/\//g)?.length ?? 0) > 8) {
      throw ApiError.validation({ message: 'rejected' });
    }
    const email = input.email.toLowerCase();
    await this.inbox.insertSubmission({
      name: input.name,
      email,
      company: input.company ?? null,
      message: input.message,
      requestIp: input.ip,
      optInUpdates: input.optInUpdates,
    });
    await this.audit.add({
      action: 'corporate.submission',
      resourceType: 'contact_submission',
      actorType: 'system',
      details: { kind: 'contact', email_domain: email.split('@')[1] ?? '', opt_in: String(input.optInUpdates) },
    });

    if (!(await this.suppressions.isSuppressed(email))) {
      await this.email
        .sendTemplate({
          template: 'corporate.contact-ack',
          to: email,
          vars: { name: input.name.split(' ')[0] ?? input.name, message_excerpt: input.message.slice(0, 200) },
          metadata: { kind: 'contact_ack' },
        })
        .catch(() => undefined);
    }
    if (env.CORPORATE_CONTACT_INBOX_EMAIL) {
      await this.email
        .sendTemplate({
          template: 'notification.generic',
          to: env.CORPORATE_CONTACT_INBOX_EMAIL,
          vars: {
            title: `New contact submission — ${input.name}`,
            body: `From: ${email}${input.company ? ` (${input.company})` : ''}\n\n${input.message.slice(0, 500)}`,
          },
          metadata: { kind: 'contact_team_notify' },
        })
        .catch(() => undefined);
    }
    if (input.optInUpdates) {
      // Route through the newsletter flow: PENDING + confirmation email —
      // the checkbox never confirms anything by itself.
      await this.newsletter.subscribe(email, 'contact_form').catch(() => undefined);
    }
  }

  // ── staff inbox ────────────────────────────────────────────────────────────

  async list(filter: { status?: string; q?: string; limit?: number; offset?: number }) {
    return this.inbox.listSubmissions(filter);
  }

  async transition(input: { submissionId: string; target: ContactStatus; notes?: string; actorId: string }) {
    const submission = await this.inbox.getSubmissionById(input.submissionId);
    if (!submission) {
      throw ApiError.notFound('submission');
    }
    if (!CONTACT_STATUSES.includes(input.target)) {
      throw ApiError.validation({ status: `one of ${CONTACT_STATUSES.join(', ')}` });
    }
    if (submission.status !== input.target && !CONTACT_TRANSITIONS[submission.status as ContactStatus].includes(input.target)) {
      throw ApiError.conflict(`invalid contact transition ${submission.status} -> ${input.target}`);
    }
    await this.inbox.transitionSubmission({
      submissionId: input.submissionId,
      target: input.target,
      notes: input.notes,
      markReplied: input.target === 'replied',
    });
    await this.audit.add({
      action: 'corporate.contact_transitioned',
      resourceType: 'contact_submission',
      resourceId: input.submissionId,
      actorType: 'account',
      actorId: input.actorId,
      details: { from: submission.status, to: input.target },
    });
  }
}
