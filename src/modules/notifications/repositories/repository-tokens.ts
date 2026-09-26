/**
 * DI tokens for the notifications-module repository ports (P3).
 *
 * Services depend only on these interfaces, never on a concrete `Pg*` /
 * `Mongo*` class. The concrete implementation behind each token is
 * selected by `DB_PROVIDER` (PostgreSQL default) in
 * `NotificationRepositoriesModule` via a single `useFactory` per token —
 * no provider conditionals in services or repositories.
 */
export const NOTIFICATION_REPOSITORY = Symbol('INotificationRepository');
