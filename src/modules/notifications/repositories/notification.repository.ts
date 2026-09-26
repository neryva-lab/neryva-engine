/**
 * `INotificationRepository` — the persistence port for the `notifications`
 * table (P3).
 *
 * The notifications table is platform-plane (no RLS — the engine is the
 * only writer; reads are explicit `account_id` filters, same posture as
 * `oauth_sessions`). Repository methods are therefore keyed by
 * `accountId`, never by `orgId`; the `orgId` is stored as row data, not a
 * scoping key (the identity-module precedent).
 *
 * Behavioral truth: `src/modules/notifications/notifications.service.ts`
 * (`notifyAccount` insert, `list`, `markRead`, `markAllRead`,
 * `unreadCount`).
 */

export type NotificationSeverity = 'info' | 'warn' | 'error';

export interface Notification {
  id: string;
  accountId: string;
  orgId: string | null;
  kind: string;
  severity: NotificationSeverity;
  title: string;
  body: string;
  data: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

export interface CreateNotificationInput {
  accountId: string;
  orgId: string | null;
  kind: string;
  severity: NotificationSeverity;
  title: string;
  body: string;
  data: Record<string, unknown>;
}

export interface INotificationRepository {
  /**
   * Insert one in-app notification row. The service truncates title/body
   * before calling; the repository persists exactly what it receives.
   */
  create(input: CreateNotificationInput): Promise<Notification>;
  /**
   * The account-facing feed: newest first, optional unread-only filter,
   * hard-capped at 200 rows (the service clamps the caller's limit).
   */
  list(accountId: string, unreadOnly: boolean, limit: number): Promise<Notification[]>;
  /** Mark one notification read (account-scoped: no-op when not owned). */
  markRead(accountId: string, notificationId: string, nowIso: string): Promise<void>;
  /** Mark all unread notifications read for the account. */
  markAllRead(accountId: string, nowIso: string): Promise<void>;
  /** Count of unread notifications (capped at 500 rows scanned). */
  unreadCount(accountId: string): Promise<number>;
}
