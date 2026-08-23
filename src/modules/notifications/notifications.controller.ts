import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { AuthLayer, CurrentPrincipal } from '../../common/auth/decorators';
import { L1Principal } from '../../common/auth/principal';
import { RateLimit } from '../../common/http/rate-limit';
import { NotificationsService } from './notifications.service';

/**
 * The account-facing notification feed (L1, account-scoped — no org
 * context; personal + org-targeted rows mix in one inbox).
 */
@Controller('auth/me/notifications')
@AuthLayer('l1')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @RateLimit({ name: 'notifications-list', capacity: 60, refillPerSecond: 1, scope: 'principal' })
  async list(@CurrentPrincipal() principal: L1Principal, @Query('unread') unread?: string) {
    const unreadOnly = unread === 'true' || unread === '1';
    const [items, unreadCount] = await Promise.all([
      this.notifications.list(principal.id, unreadOnly),
      this.notifications.unreadCount(principal.id),
    ]);
    return { notifications: items, unread_count: unreadCount };
  }

  @Post(':notificationId/read')
  async markRead(@CurrentPrincipal() principal: L1Principal, @Param('notificationId') notificationId: string): Promise<{ ok: true }> {
    await this.notifications.markRead(principal.id, notificationId);
    return { ok: true };
  }

  @Post('read-all')
  async markAllRead(@CurrentPrincipal() principal: L1Principal): Promise<{ ok: true }> {
    await this.notifications.markAllRead(principal.id);
    return { ok: true };
  }
}
