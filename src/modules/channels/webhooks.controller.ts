import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Public } from '../../common/auth/decorators';
import { ApiError } from '../../common/http/api-error';
import { ChannelIngestService } from './ingest.service';
import { ChannelsService } from './channels.service';
import { ChannelAccount } from './schema';

/**
 * Channel webhook plane (Phase C2) — `webhooks/channels/:platform/:accountId`.
 * Deliberately @Public (platforms cannot hold Engine credentials); the
 * authenticity boundary is per-platform cryptographic verification over the
 * RAW body, exactly like stripe.controller.ts. Handlers do zero platform I/O:
 * the durable ingest returns in one fast transaction so Meta/Telegram SLAs
 * (20s ack / instant 200) are comfortably met.
 */

@Controller('webhooks/channels')
export class ChannelsWebhookController {
  constructor(
    private readonly ingestService: ChannelIngestService,
    private readonly channels: ChannelsService,
  ) {}

  // ── Meta (Messenger + WhatsApp share one contract) ───────────────────────

  /** One-time endpoint verification: echo hub.challenge iff the token matches. */
  @Get('messenger/:accountId')
  @Public()
  async verifyMessenger(
    @Param('accountId') accountId: string,
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.verifyMeta(accountId, mode, token, challenge, reply);
  }

  @Get('whatsapp/:accountId')
  @Public()
  async verifyWhatsApp(
    @Param('accountId') accountId: string,
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.verifyMeta(accountId, mode, token, challenge, reply);
  }

  @Post('messenger/:accountId')
  @HttpCode(200)
  @Public()
  async receiveMessenger(@Param('accountId') accountId: string, @Req() request: FastifyRequest & { rawBody?: string }, @Body() body: unknown): Promise<{ received: boolean }> {
    void body; // signature verification uses the RAW body only
    return this.receiveMeta('messenger', accountId, request);
  }

  @Post('whatsapp/:accountId')
  @HttpCode(200)
  @Public()
  async receiveWhatsApp(@Param('accountId') accountId: string, @Req() request: FastifyRequest & { rawBody?: string }, @Body() body: unknown): Promise<{ received: boolean }> {
    void body;
    return this.receiveMeta('whatsapp', accountId, request);
  }

  // ── Telegram ─────────────────────────────────────────────────────────────

  @Post('telegram/:accountId')
  @HttpCode(200)
  @Public()
  async receiveTelegram(@Param('accountId') accountId: string, @Req() request: FastifyRequest & { rawBody?: string }): Promise<{ received: boolean }> {
    const account = await this.requireAccount(accountId);
    const presented = request.headers['x-telegram-bot-api-secret-token'];
    const presentedToken = Array.isArray(presented) ? presented[0] : presented;
    const secret = String(this.channels.decryptCredentials(account).webhook_secret ?? '');
    if (!presentedToken || !safeEqual(String(presentedToken), secret)) {
      throw new ApiError(401, 'unauthenticated', 'telegram secret token mismatch');
    }
    const result = await this.ingestService.acceptWebhook({ account, rawBody: request.rawBody ?? '', signatureOk: true });
    return { received: result.outcome === 'accepted' };
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async verifyMeta(accountId: string, mode: string, token: string, challenge: string, reply: FastifyReply): Promise<void> {
    const account = await this.requireAccount(accountId);
    if (mode !== 'subscribe' || !token || !challenge || !this.channels.verifyTokenMatches(account, token)) {
      throw new ApiError(403, 'forbidden', 'webhook verification failed');
    }
    // Echo verbatim — Meta compares the exact bytes.
    reply.code(200).type('text/plain').send(challenge);
  }

  private async receiveMeta(platform: 'messenger' | 'whatsapp', accountId: string, request: FastifyRequest & { rawBody?: string }): Promise<{ received: boolean }> {
    const account = await this.requireAccount(accountId);
    const rawBody = request.rawBody ?? '';
    // X-Hub-Signature-256 over the RAW body with the account's app secret —
    // never over a re-serialized body (the classic integration failure).
    const presented = request.headers['x-hub-signature-256'];
    const signature = Array.isArray(presented) ? presented[0] : presented;
    const secret = String(this.channels.decryptCredentials(account).app_secret ?? '');
    if (!signature || !signature.startsWith('sha256=') || !secret) {
      throw new ApiError(401, 'unauthenticated', 'missing webhook signature');
    }
    const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
    if (!safeEqual(signature.slice('sha256='.length), expected)) {
      throw new ApiError(401, 'unauthenticated', 'webhook signature mismatch');
    }
    if (await this.ingestService.rateLimited(account.id)) {
      throw new ApiError(429, 'rate_limited', 'channel webhook rate limit exceeded');
    }
    const result = await this.ingestService.acceptWebhook({ account, rawBody, signatureOk: true });
    return { received: result.outcome === 'accepted' };
  }

  private async requireAccount(accountId: string): Promise<ChannelAccount> {
    const account = await this.channels.getByIdForIngest(accountId);
    if (!account) {
      // 404 without tenant disclosure: unknown ids and wrong-platform ids look identical.
      throw new ApiError(404, 'not_found', 'unknown webhook endpoint');
    }
    return account;
  }
}

/** Constant-time compare with length-uniform timing on mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) {
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}
