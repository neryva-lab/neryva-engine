import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from '../../common/auth/decorators';
import { Idempotent } from '../../common/http/idempotency';
import { RateLimit } from '../../common/http/rate-limit';
import { ApiError } from '../../common/http/api-error';
import { FormsService } from './forms.service';
import { ContentService } from './content.service';
import { CareerDto, ContactDto, NewsletterDto } from './dto';

/**
 * The public surface (corporate E-2/E-3): the ONLY unauthenticated routes
 * on the engine. Posture: per-IP token buckets, Idempotency-Key on every
 * mutating POST, strict DTO whitelisting (the honeypot `company_url` is
 * dropped by the whitelist — the response is indistinguishable from
 * success so bots get no signal), and audit on every stored submission.
 */
@Controller('public')
export class PublicController {
  constructor(
    private readonly forms: FormsService,
    private readonly content: ContentService,
  ) {}

  @Public()
  @Post('contact')
  @HttpCode(202)
  @Idempotent()
  @RateLimit({ name: 'public-contact', capacity: 3, refillPerSecond: 0.02 }) // ~1/minute sustained, burst 3
  async contact(@Body() dto: ContactDto, @Req() req: FastifyRequest): Promise<{ ok: true }> {
    await this.forms.submitContact(dto, req.ip ?? null);
    return { ok: true };
  }

  @Public()
  @Post('newsletter')
  @HttpCode(202)
  @Idempotent()
  @RateLimit({ name: 'public-newsletter', capacity: 3, refillPerSecond: 0.02 })
  async newsletter(@Body() dto: NewsletterDto): Promise<{ ok: true }> {
    await this.forms.subscribeNewsletter(dto);
    return { ok: true };
  }

  /** Double opt-in redemption ( emailed link ). */
  @Public()
  @Get('newsletter/confirm')
  @RateLimit({ name: 'public-newsletter-confirm', capacity: 10, refillPerSecond: 0.1 })
  async confirmNewsletter(@Query('token') token?: string, @Res({ passthrough: true }) reply?: FastifyReply): Promise<{ ok: boolean }> {
    if (!token || token.length < 16 || token.length > 256) {
      throw ApiError.validation({ token: 'invalid confirmation token' });
    }
    const ok = await this.forms.confirmNewsletter(token);
    if (!ok && reply) {
      reply.status(404);
    }
    return { ok };
  }
  @Public()
  @Post('careers')
  @HttpCode(202)
  @Idempotent()
  @RateLimit({ name: 'public-careers', capacity: 3, refillPerSecond: 0.01 })
  async careers(@Body() dto: CareerDto, @Req() req: FastifyRequest): Promise<{ ok: true }> {
    await this.forms.submitCareer(dto, req.ip ?? null);
    return { ok: true };
  }

  // ── Content export feed (E-3): what the website's build syncs from ──────

  @Public()
  @Get('blog')
  @RateLimit({ name: 'public-blog', capacity: 30, refillPerSecond: 1 })
  async blogFeed(): Promise<unknown> {
    return this.content.publishedFeed();
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
}
