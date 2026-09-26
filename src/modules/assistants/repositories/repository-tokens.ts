/**
 * DI tokens for the assistants-module repository ports (P3).
 *
 * One focused token per aggregate/transaction-boundary cluster (interface
 * segregation): services depend only on these interfaces, never on a
 * concrete `Pg*`/`Mongo*` class. The concrete implementation behind each
 * token is selected by `DB_PROVIDER` (PostgreSQL default) in
 * `AssistantsModule` via a single `useFactory` per token — no
 * provider conditionals in services or repositories.
 */
export const ASSISTANT_REPOSITORY = Symbol('IAssistantRepository');
export const ASSISTANT_VERSION_REPOSITORY = Symbol('IAssistantVersionRepository');
export const POLICY_SNAPSHOT_REPOSITORY = Symbol('IPolicySnapshotRepository');
export const TEMPLATE_REPOSITORY = Symbol('ITemplateRepository');
export const TOOL_CATALOG_REPOSITORY = Symbol('IToolCatalogRepository');
export const CONTROL_BLOCK_REPOSITORY = Symbol('IControlBlockRepository');
export const ROLLOUT_REPOSITORY = Symbol('IRolloutRepository');
export const BURN_RATE_REPOSITORY = Symbol('IBurnRateRepository');
export const MODEL_CATALOG_REPOSITORY = Symbol('IModelCatalogRepository');
export const MODEL_COST_REPOSITORY = Symbol('IModelCostRepository');
export const PROVIDER_CREDENTIAL_REPOSITORY = Symbol('IProviderCredentialRepository');
export const FLEET_STAFF_REPOSITORY = Symbol('IFleetStaffRepository');
