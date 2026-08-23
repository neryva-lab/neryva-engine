import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from '../../common/auth/decorators';
import { Idempotent } from '../../common/http/idempotency';
import { RateLimit } from '../../common/http/rate-limit';
import { ApiError } from '../../common/http/api-error';
import { CareersService } from './careers.service';
import { ContactInboxService } from './contact-inbox.service';
import { ContentService } from './content.service';
import { FeedsService } from './feeds.service';
import { NewsletterService } from './newsletter.service';
import { SuppressionService } from './suppression.service';
import { CareerDto, ContactDto, NewsletterDto } from './dto';

/**
 * The public surface (corporate E-2/E-3): the ONLY unauthenticated routes
 * on the engine. Posture: per-IP token buckets, Idempotency-Key on every
 * mutating POST, strict DTO whitelisting (the honeypot `company_url` is
 * dropped by the whitelist — the response is indistinguishable from
 * success so bots get no signal), content-length link heuristics, and
 * audit on every stored submission.
 *
 * v2 additions: careers job listings, one-click unsubscribe (GET+POST),
 * provider bounce/complaint webhooks (secret-authenticated), the blog's
 * public reading endpoints, and RSS/Atom/JSON/sitemap syndication.
 */
@Controller('public')
export class PublicController {
  constructor(
    private readonly inbox: ContactInboxService,
    private readonly newsletter: NewsletterService,
    private readonly careers: CareersService,
    private readonly content: ContentService,
    private readonly feeds: FeedsService,
    private readonly suppressions: SuppressionService,
  ) {}

  @Public()
  @Post('contact')
  @HttpCode(202)
  @Idempotent()
  @RateLimit({ name: 'public-contact', capacity: 3, refillPerSecond: 0.02 }) // ~1/minute sustained, burst 3
  async contact(@Body() dto: ContactDto, @Req() req: FastifyRequest): Promise<{ ok: true }> {
    await this.inbox.intake({
      name: dto.name,
      email: dto.email,
      company: dto.company,
      message: dto.message,
      optInUpdates: dto.opt_in_updates === true,
      ip: req.ip ?? null,
    });
    return { ok: true };
  }

  @Public()
  @Post('newsletter')
  @HttpCode(202)
  @Idempotent()
  @RateLimit({ name: 'public-newsletter', capacity: 3, refillPerSecond: 0.02 })
  async subscribeNewsletter(@Body() dto: NewsletterDto): Promise<{ ok: true }> {
    await this.newsletter.subscribe(dto.email);
    return { ok: true };
  }

  /** Double opt-in redemption (emailed link). */
  @Public()
  @Get('newsletter/confirm')
  @RateLimit({ name: 'public-newsletter-confirm', capacity: 10, refillPerSecond: 0.1 })
  async confirmNewsletter(@Query('token') token?: string, @Res({ passthrough: true }) reply?: FastifyReply): Promise<{ ok: boolean }> {
    if (!token || token.length < 16 || token.length > 256) {
      throw ApiError.validation({ token: 'invalid confirmation token' });
    }
    const ok = await this.newsletter.confirm(token);
    if (!ok && reply) {
      reply.status(404);
    }
    return { ok };
  }

  /**
   * One-click unsubscribe — GET (List-Unsubscribe mail-client link) and
   * POST (RFC 8058 one-click). Accepts both token families: the
   * subscriber's footer token and the per-send campaign token.
   */
  @Public()
  @Get('newsletter/unsubscribe')
  @RateLimit({ name: 'public-newsletter-unsub', capacity: 10, refillPerSecond: 0.2 })
  async unsubscribeGet(@Query('token') token?: string, @Res({ passthrough: true }) reply?: FastifyReply): Promise<{ ok: boolean }> {
    return this.unsubscribe(token, reply);
  }

  @Public()
  @Post('newsletter/unsubscribe')
  @HttpCode(200)
  @RateLimit({ name: 'public-newsletter-unsub', capacity: 10, refillPerSecond: 0.2 })
  async unsubscribePost(@Body() body: { token?: string }, @Res({ passthrough: true }) reply?: FastifyReply): Promise<{ ok: boolean }> {
    return this.unsubscribe(body?.token, reply);
  }

  private async unsubscribe(token: string | undefined, reply?: FastifyReply): Promise<{ ok: boolean }> {
    if (!token || token.length < 16 || token.length > 128) {
      throw ApiError.validation({ token: 'invalid unsubscribe token' });
    }
    const ok = (await this.newsletter.unsubscribeBySendToken(token)) || (await this.newsletter.unsubscribeByToken(token));
    if (!ok && reply) {
      reply.status(404);
    }
    return { ok };
  }

  // ── careers ────────────────────────────────────────────────────────────────

  @Public()
  @Get('careers/jobs')
  @RateLimit({ name: 'public-careers-jobs', capacity: 30, refillPerSecond: 1 })
  async jobs(): Promise<{ jobs: unknown[] }> {
    return { jobs: await this.careers.publishedJobs() };
  }

  @Public()
  @Get('careers/jobs/:slug')
  @RateLimit({ name: 'public-careers-jobs', capacity: 30, refillPerSecond: 1 })
  async job(@Param('slug') slug: string): Promise<unknown> {
    return this.careers.publishedJobBySlug(slug);
  }

  @Public()
  @Post('careers')
  @HttpCode(202)
  @Idempotent()
  @RateLimit({ name: 'public-careers', capacity: 3, refillPerSecond: 0.01 })
  async submitCareer(@Body() dto: CareerDto, @Req() req: FastifyRequest): Promise<{ ok: true }> {
    await this.careers.submitApplication({
      name: dto.name,
      email: dto.email,
      position: dto.position,
      jobSlug: dto.job_slug,
      phone: dto.phone,
      linkedinUrl: dto.linkedin_url,
      portfolioUrl: dto.portfolio_url,
      coverNote: dto.cover_note,
      fileRef: dto.file_ref,
      ip: req.ip ?? null,
    });
    return { ok: true };
  }

  // ── email provider webhooks (bounces/complaints → suppression) ────────────

  @Public()
  @Post('email/webhook')
  @HttpCode(200)
  @RateLimit({ name: 'public-email-webhook', capacity: 120, refillPerSecond: 10 })
  async emailWebhook(@Body() body: unknown, @Headers('x-webhook-secret') secret?: string): Promise<unknown> {
    return this.suppressions.ingestWebhook(body, secret);
  }

  // ── blog: reading + syndication ────────────────────────────────────────────

  /** The website build feed (full bundle) — what static builds sync from. */
  @Public()
  @Get('blog')
  @RateLimit({ name: 'public-blog', capacity: 30, refillPerSecond: 1 })
  async blogFeed(): Promise<unknown> {
    return this.content.publishedFeed();
  }

  /** The public reading list (summaries; the site renders detail pages). */
  @Public()
  @Get('blog/posts')
  @RateLimit({ name: 'public-blog', capacity: 30, refillPerSecond: 1 })
  async blogList(@Query('limit') limit?: string): Promise<{ posts: unknown[] }> {
    const parsed = limit ? Number.parseInt(limit, 10) : 50;
    return { posts: await this.content.publishedList(Number.isFinite(parsed) ? parsed : 50) };
  }

  @Public()
  @Get('blog/:slug')
  @RateLimit({ name: 'public-blog', capacity: 30, refillPerSecond: 1 })
  async blogPost(@Param('slug') slug: string): Promise<unknown> {
    const post = await this.content.publishedBySlug(slug);
    if (!post) {
      throw ApiError.notFound('post');
    }
    return post;
  }

  @Public()
  @Get('feed.xml')
  async rss(@Res({ passthrough: true }) reply: FastifyReply): Promise<string> {
    reply.header('content-type', 'application/rss+xml; charset=utf-8');
    return this.feeds.rss();
  }

  @Public()
  @Get('feed.atom')
  async atom(@Res({ passthrough: true }) reply: FastifyReply): Promise<string> {
    reply.header('content-type', 'application/atom+xml; charset=utf-8');
    return this.feeds.atom();
  }

  @Public()
  @Get('feed.json')
  async jsonFeed(@Res({ passthrough: true }) reply: FastifyReply): Promise<string> {
    reply.header('content-type', 'application/feed+json; charset=utf-8');
    return this.feeds.jsonFeed();
  }

  @Public()
  @Get('sitemap-posts.xml')
  async sitemap(@Res({ passthrough: true }) reply: FastifyReply): Promise<string> {
    reply.header('content-type', 'application/xml; charset=utf-8');
    return this.feeds.sitemap();
  }
}
