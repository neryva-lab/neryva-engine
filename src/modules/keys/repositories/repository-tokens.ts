/**
 * DI tokens for the keys-module repository ports (P3).
 *
 * One focused token per aggregate/transaction-boundary cluster (interface
 * segregation): services depend only on these interfaces, never on a
 * concrete `Pg*`/`Mongo*` class. The concrete implementation behind each
 * token is selected by `DB_PROVIDER` (PostgreSQL default) in
 * `KeysRepositoriesModule` via a single `useFactory` per token — no
 * provider conditionals in services or repositories.
 */
export const API_KEY_REPOSITORY = Symbol('IApiKeyRepository');
export const STUDIO_PROJECT_KEY_REPOSITORY = Symbol('IStudioProjectKeyRepository');
