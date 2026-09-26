/**
 * DI tokens for the webhooks-module repository ports (P3).
 *
 * One focused token per aggregate/transaction-boundary cluster (interface
 * segregation): services depend only on these interfaces, never on a
 * concrete `Pg*`/`Mongo*` class. The concrete implementation behind each
 * token is selected by `DB_PROVIDER` (PostgreSQL default) in
 * `WebhooksRepositoriesModule` via a single `useFactory` per token — no
 * provider conditionals in services or repositories.
 */
export const WEBHOOK_REPOSITORY = Symbol('IWebhookRepository');
export const WEBHOOK_DELIVERY_REPOSITORY = Symbol('IWebhookDeliveryRepository');
