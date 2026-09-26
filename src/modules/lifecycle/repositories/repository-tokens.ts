/**
 * DI tokens for the lifecycle-module repository ports (P3).
 *
 * One focused token per aggregate/transaction-boundary cluster (interface
 * segregation): services depend only on these interfaces, never on a
 * concrete `Pg*`/`Mongo*` class. The concrete implementation behind each
 * token is selected by `DB_PROVIDER` (PostgreSQL default) in
 * `LifecycleModule` via a single `useFactory` per token — no
 * provider conditionals in services or repositories.
 */
export const LEGAL_HOLD_REPOSITORY = Symbol('ILegalHoldRepository');
export const EXPORT_REPOSITORY = Symbol('IExportRepository');
export const DATA_ACCESS_REPOSITORY = Symbol('IDataAccessRepository');
export const RETENTION_POLICY_REPOSITORY = Symbol('IRetentionPolicyRepository');
export const PURGE_TASK_REPOSITORY = Symbol('IPurgeTaskRepository');
export const PURGE_STEP_REPOSITORY = Symbol('IPurgeStepRepository');
