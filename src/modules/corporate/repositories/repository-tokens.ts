/**
 * DI tokens for the corporate-module repository ports (P3).
 *
 * One focused token per aggregate/transaction-boundary cluster (interface
 * segregation): services depend only on these interfaces, never on a
 * concrete `Pg*`/`Mongo*` class. The concrete implementation behind each
 * token is selected by `DB_PROVIDER` (PostgreSQL default) in
 * `CorporateRepositoriesModule` via a single `useFactory` per token — no
 * provider conditionals in services or repositories.
 *
 * All corporate tables are GLOBAL (non-tenant) — see each port file.
 */
export const CAREERS_REPOSITORY = Symbol('ICareersRepository');
export const CONTACT_INBOX_REPOSITORY = Symbol('IContactInboxRepository');
export const SUPPRESSION_REPOSITORY = Symbol('ISuppressionRepository');
export const CONTENT_REPOSITORY = Symbol('IContentRepository');
export const NEWSLETTER_REPOSITORY = Symbol('INewsletterRepository');
export const EMAIL_DELIVERY_REPOSITORY = Symbol('IEmailDeliveryRepository');
export const CONTENT_STAFF_REPOSITORY = Symbol('IContentStaffRepository');
