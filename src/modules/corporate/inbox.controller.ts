import { Body, Controller, Get, Param, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { AuthLayer, CurrentPrincipal } from '../../common/auth/decorators';
import { L1Principal } from '../../common/auth/principal';
import { ApiError } from '../../common/http/api-error';
import { RateLimit } from '../../common/http/rate-limit';
import { CareersService, ApplicationStatus } from './careers.service';
import { ContactInboxService, ContactStatus } from './contact-inbox.service';
import { ContentStaffGuard } from './content-staff.guard';
import { NewsletterService } from './newsletter.service';
import { SuppressionService } from './suppression.service';

/**
 * The corporate staff inbox (E-2 to production grade): contact pipeline,
 * recruiting pipeline, subscriber management (list/filter/CSV/GDPR),
 * campaign management, and the suppression list — all behind the
 * content-staff grant (marketing/ops staff), rate-limited, every
 * transition audited in its service.
 */
@Controller('console/corporate')
@UseGuards(ContentStaffGuard)
export class InboxController {
  constructor(
    private readonly inbox: ContactInboxService,
    private readonly careers: CareersService,
    private readonly newsletter: NewsletterService,
    private readonly suppressions: SuppressionService,
  ) {}

  private actor(principal: L1Principal): string {
    return principal.id;
  }

  // ── contact pipeline ───────────────────────────────────────────────────────

  @Get('contact')
  @AuthLayer('l1')
  async contactList(
    @Query('status') status?: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.inbox.list({
      status,
      q,
      limit: limit ? Number.parseInt(limit, 10) : undefined,
      offset: offset ? Number.parseInt(offset, 10) : undefined,
    });
  }

  @Post('contact/:submissionId/transition')
  @AuthLayer('l1')
  @RateLimit({ name: 'corporate-contact-transition', capacity: 60, refillPerSecond: 1, scope: 'principal' })
  async contactTransition(
    @Param('submissionId') submissionId: string,
    @Body() body: { status?: string; notes?: string },
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ ok: true }> {
    if (!body.status) {
      throw ApiError.validation({ status: 'required' });
    }
    await this.inbox.transition({
      submissionId,
      target: body.status as ContactStatus,
      notes: body.notes,
      actorId: this.actor(principal),
    });
    return { ok: true };
  }

  // ── careers: jobs + application pipeline ───────────────────────────────────

  @Get('jobs')
  @AuthLayer('l1')
  async jobs(): Promise<{ jobs: unknown[] }> {
    return { jobs: await this.careers.listJobs() };
  }

  @Put('jobs')
  @AuthLayer('l1')
  @RateLimit({ name: 'corporate-jobs-write', capacity: 30, refillPerSecond: 0.2, scope: 'principal' })
  async upsertJob(
    @Body()
    body: { slug?: string; title?: string; department?: string; location?: string; employment_type?: string; description_md?: string; apply_instructions?: string },
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ job: unknown }> {
    if (!body.slug || !body.title || !body.department || !body.location || !body.description_md) {
      throw ApiError.validation({ input: 'slug, title, department, location, description_md are required' });
    }
    return {
      job: await this.careers.upsertJob({
        slug: body.slug,
        title: body.title,
        department: body.department,
        location: body.location,
        employmentType: body.employment_type,
        descriptionMd: body.description_md,
        applyInstructions: body.apply_instructions,
        actorId: this.actor(principal),
      }),
    };
  }

  @Post('jobs/:slug/status')
  @AuthLayer('l1')
  async setJobStatus(@Param('slug') slug: string, @Body() body: { status?: string }, @CurrentPrincipal() principal: L1Principal): Promise<{ ok: true }> {
    if (!body.status || !['draft', 'published', 'archived'].includes(body.status)) {
      throw ApiError.validation({ status: 'draft | published | archived' });
    }
    await this.careers.setJobStatus({ slug, status: body.status as 'draft' | 'published' | 'archived', actorId: this.actor(principal) });
    return { ok: true };
  }

  @Get('applications')
  @AuthLayer('l1')
  async applications(@Query('status') status?: string, @Query('job') jobSlug?: string, @Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.careers.listApplications({
      status,
      jobSlug,
      limit: limit ? Number.parseInt(limit, 10) : undefined,
      offset: offset ? Number.parseInt(offset, 10) : undefined,
    });
  }

  /**
   * Download an application's attachment (ADR-008 storage): a time-limited
   * presigned GET — the document never proxies through the engine, and the
   * URL dies in minutes. Filenames come from the stored object key, so a
   * hostile original filename can't reach the Content-Disposition header
   * un-sanitized.
   */
  @Get('applications/:applicationId/attachment')
  @AuthLayer('l1')
  @RateLimit({ name: 'corporate-attachment-download', capacity: 30, refillPerSecond: 1, scope: 'principal' })
  async applicationAttachment(@Param('applicationId') applicationId: string): Promise<unknown> {
    if (!this.storage.available) {
      throw ApiError.unavailable('Attachment downloads');
    }
    const application = await this.careers.applicationById(applicationId);
    if (!application) {
      throw ApiError.notFound('application');
    }
    if (!application.fileRef) {
      throw ApiError.notFound('attachment');
    }
    const key = application.fileRef;
    if (!/^careers\/[0-9a-f-]{36}\/[\w.\-]+$/.test(key)) {
      throw ApiError.conflict('stored attachment reference is malformed');
    }
    const filename = key.split('/').pop() ?? 'attachment';
    const download = this.storage.presignDownload({
      key,
      expiresIn: 300,
      responseContentType: 'application/octet-stream',
      responseContentDisposition: `attachment; filename="${filename.replace(/["\\]/g, '')}"`,
    });
    return { application_id: application.id, download };
  }

  @Post('applications/:applicationId/transition')
  @AuthLayer('l1')
  @RateLimit({ name: 'corporate-application-transition', capacity: 60, refillPerSecond: 1, scope: 'principal' })
  async applicationTransition(
    @Param('applicationId') applicationId: string,
    @Body() body: { status?: string; notes?: string },
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ ok: true }> {
    if (!body.status) {
      throw ApiError.validation({ status: 'required' });
    }
    await this.careers.transitionApplication({
      applicationId,
      target: body.status as ApplicationStatus,
      notes: body.notes,
      actorId: this.actor(principal),
    });
    return { ok: true };
  }

  // ── subscribers + campaigns ────────────────────────────────────────────────

  @Get('subscribers')
  @AuthLayer('l1')
  async subscribers(@Query('status') status?: string, @Query('q') q?: string, @Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.newsletter.listSubscribers({
      status,
      q,
      limit: limit ? Number.parseInt(limit, 10) : undefined,
      offset: offset ? Number.parseInt(offset, 10) : undefined,
    });
  }

  @Get('subscribers/export.csv')
  @AuthLayer('l1')
  @RateLimit({ name: 'corporate-subscribers-export', capacity: 4, refillPerSecond: 0.02, scope: 'principal' })
  async subscribersCsv(@Res({ passthrough: true }) reply: FastifyReply): Promise<string> {
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', 'attachment; filename="neryva-subscribers.csv"');
    return this.newsletter.exportCsv();
  }

  /** GDPR: one subscriber's data (token material stripped). */
  @Get('subscribers/:email')
  @AuthLayer('l1')
  async subscriberData(@Param('email') email: string): Promise<{ subscriber: unknown }> {
    return { subscriber: await this.newsletter.subscriberData(email) };
  }

  /** GDPR erasure. */
  @Post('subscribers/:email/delete')
  @AuthLayer('l1')
  @RateLimit({ name: 'corporate-subscriber-delete', capacity: 10, refillPerSecond: 0.05, scope: 'principal' })
  async deleteSubscriber(@Param('email') email: string, @CurrentPrincipal() principal: L1Principal): Promise<{ ok: true }> {
    await this.newsletter.deleteSubscriber(email, this.actor(principal));
    return { ok: true };
  }

  @Get('campaigns')
  @AuthLayer('l1')
  async campaigns(): Promise<{ campaigns: unknown[] }> {
    return { campaigns: await this.newsletter.listCampaigns() };
  }

  @Get('campaigns/:campaignId')
  @AuthLayer('l1')
  async campaignDetail(@Param('campaignId') campaignId: string): Promise<unknown> {
    return this.newsletter.campaignDetail(campaignId);
  }

  @Post('campaigns')
  @AuthLayer('l1')
  @RateLimit({ name: 'corporate-campaign-create', capacity: 10, refillPerSecond: 0.05, scope: 'principal' })
  async createCampaign(
    @Body() body: { subject?: string; preheader?: string; body_md?: string },
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ campaign: unknown }> {
    if (!body.subject || !body.body_md) {
      throw ApiError.validation({ subject: 'required', body_md: 'required' });
    }
    return { campaign: await this.newsletter.createCampaign({ subject: body.subject, preheader: body.preheader, bodyMd: body.body_md, actorId: this.actor(principal) }) };
  }

  @Post('campaigns/:campaignId')
  @AuthLayer('l1')
  async updateCampaign(
    @Param('campaignId') campaignId: string,
    @Body() body: { subject?: string; preheader?: string; body_md?: string },
    @CurrentPrincipal() principal: L1Principal,
  ):Promise<{ campaign: unknown }> {
    return {
      campaign: await this.newsletter.updateCampaign({
        campaignId,
        subject: body.subject,
        preheader: body.preheader,
        bodyMd: body.body_md,
        actorId: this.actor(principal),
      }),
    };
  }

  @Post('campaigns/:campaignId/schedule')
  @AuthLayer('l1')
  @RateLimit({ name: 'corporate-campaign-schedule', capacity: 6, refillPerSecond: 0.02, scope: 'principal' })
  async scheduleCampaign(
    @Param('campaignId') campaignId: string,
    @Body() body: { scheduled_at?: string },
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<unknown> {
    return this.newsletter.scheduleCampaign({ campaignId, scheduledAt: body.scheduled_at, actorId: this.actor(principal) });
  }

  @Post('campaigns/:campaignId/cancel')
  @AuthLayer('l1')
  async cancelCampaign(@Param('campaignId') campaignId: string, @CurrentPrincipal() principal: L1Principal): Promise<{ ok: true }> {
    await this.newsletter.cancelCampaign({ campaignId, actorId: this.actor(principal) });
    return { ok: true };
  }

  // ── suppression list ───────────────────────────────────────────────────────

  @Get('suppressions')
  @AuthLayer('l1')
  async listSuppressions(): Promise<{ suppressions: unknown[] }> {
    return { suppressions: await this.suppressions.list() };
  }

  @Post('suppressions/:email/resolve')
  @AuthLayer('l1')
  @RateLimit({ name: 'corporate-suppression-resolve', capacity: 20, refillPerSecond: 0.1, scope: 'principal' })
  async resolveSuppression(@Param('email') email: string, @CurrentPrincipal() principal: L1Principal): Promise<{ ok: true }> {
    await this.suppressions.resolve(email, this.actor(principal));
    return { ok: true };
  }
}
