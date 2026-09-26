/**
 * DI tokens for the config-publish-module repository ports (P3).
 *
 * One focused token per aggregate/transaction-boundary cluster (interface
 * segregation): services depend only on these interfaces, never on a
 * concrete `Pg*`/`Mongo*` class. The concrete implementation behind each
 * token is selected by `DB_PROVIDER` (PostgreSQL default) in
 * `ConfigPublishRepositoriesModule` via a single `useFactory` per token —
 * no provider conditionals in services or repositories.
 */
export const CONFIG_PUBLISH_REPOSITORY = Symbol('IConfigPublishRepository');
export const CONFIG_DRAFT_REPOSITORY = Symbol('IConfigDraftRepository');
export const CONFIG_NOTIFICATION_REPOSITORY = Symbol('IConfigNotificationRepository');
