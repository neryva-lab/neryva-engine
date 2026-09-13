import { Controller, Get, Param } from '@nestjs/common';
import { Public } from '../../common/auth/decorators';
import { ApiError } from '../../common/http/api-error';
import { ConversationsService } from './conversations.service';

/**
 * FL-3.4 — public share rendering. Token-only access (the 256-bit token IS
 * the credential; no account context exists on this surface). Resolution
 * serves a redacted projection and never discloses whether a share expired,
 * was revoked, or never existed — every miss is a uniform 404.
 */
@Controller('public/shares')
export class PublicSharesController {
  constructor(private readonly conversations: ConversationsService) {}

  @Get(':token')
  @Public()
  async resolve(@Param('token') token: string) {
    const view = await this.conversations.resolvePublicShare(token);
    if (!view) {
      // Uniform 404 — no tenant or existence disclosure.
      throw ApiError.notFound('share');
    }
    return view;
  }
}
