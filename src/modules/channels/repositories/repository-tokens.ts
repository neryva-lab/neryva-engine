/**
 * DI tokens for the channels-module repository ports (P3).
 *
 * One focused token per aggregate/transaction-boundary cluster (interface
 * segregation): services depend only on these interfaces, never on a
 * concrete `Pg*`/`Mongo*` class. The concrete implementation behind each
 * token is selected by `DB_PROVIDER` (PostgreSQL default) in
 * `ChannelsModule` via a single `useFactory` per token — no
 * provider conditionals in services or repositories.
 */
export const CHANNEL_ACCOUNT_REPOSITORY = Symbol('IChannelAccountRepository');
export const CHANNEL_IDENTITY_REPOSITORY = Symbol('IChannelIdentityRepository');
export const CHANNEL_EVENT_REPOSITORY = Symbol('IChannelEventRepository');
export const CHANNEL_MESSAGE_LINK_REPOSITORY = Symbol('IChannelMessageLinkRepository');
export const CHANNEL_TEMPLATE_REPOSITORY = Symbol('IChannelTemplateRepository');
export const CHANNEL_SESSION_REPOSITORY = Symbol('IChannelSessionRepository');
