/**
 * PostgreSQL lane for `INotificationRepository` (P3).
 *
 * Mechanical extraction from `NotificationsService`: `db.root` (platform-
 * plane, no RLS) inserts/selects/updates on the `notifications` table.
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { DbService } from '../../../common/infra/db/db.service';
import { notifications } from '../schema';
import type {
  CreateNotificationInput,
  INotificationRepository,
  Notification,
} from './notification.repository';

function toNotification(row: typeof notifications.$inferSelect): Notification {
  return {
    id: row.id,
    accountId: row.accountId,
    orgId: row.orgId,
    kind: row.kind,
    severity: row.severity as Notification['severity'],
    title: row.title,
    body: row.body,
    data: (row.data ?? {}) as Record<string, unknown>,
    readAt: row.readAt,
    createdAt: row.createdAt,
  };
}

export class PgNotificationRepository implements INotificationRepository {
  constructor(private readonly db: DbService) {}

  async create(input: CreateNotificationInput): Promise<Notification> {
    const rows = await this.db.root
      .insert(notifications)
      .values({
        accountId: input.accountId,
        orgId: input.orgId,
        kind: input.kind,
        severity: input.severity,
        title: input.title,
        body: input.body,
        data: input.data,
      })
      .returning();
    return toNotification(rows[0]);
  }

  async list(accountId: string, unreadOnly: boolean, limit: number): Promise<Notification[]> {
    const rows = await this.db.root
      .select()
      .from(notifications)
      .where(
        unreadOnly
          ? and(eq(notifications.accountId, accountId), isNull(notifications.readAt))
          : eq(notifications.accountId, accountId),
      )
      .orderBy(desc(notifications.createdAt))
      .limit(Math.min(limit, 200));
    return rows.map(toNotification);
  }

  async markRead(accountId: string, notificationId: string, nowIso: string): Promise<void> {
    await this.db.root
      .update(notifications)
      .set({ readAt: nowIso })
      .where(and(eq(notifications.id, notificationId), eq(notifications.accountId, accountId)));
  }

  async markAllRead(accountId: string, nowIso: string): Promise<void> {
    await this.db.root
      .update(notifications)
      .set({ readAt: nowIso })
      .where(and(eq(notifications.accountId, accountId), isNull(notifications.readAt)));
  }

  async unreadCount(accountId: string): Promise<number> {
    const rows = await this.db.root
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.accountId, accountId), isNull(notifications.readAt)))
      .limit(500);
    return rows.length;
  }
}
