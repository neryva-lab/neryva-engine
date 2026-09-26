/**
 * DI tokens for the deployment-module repository ports (P3).
 *
 * One focused token per aggregate/transaction-boundary cluster (interface
 * segregation): services depend only on these interfaces, never on a
 * concrete `Pg*`/`Mongo*` class. The concrete implementation behind each
 * token is selected by `DB_PROVIDER` (PostgreSQL default) in
 * `DeploymentModule` via a single `useFactory` per token — no provider
 * conditionals in services or repositories.
 */
export const DEPLOYMENT_PIPELINE_REPOSITORY = Symbol('IDeploymentPipelineRepository');
export const DEPLOYMENT_ENVIRONMENT_REPOSITORY = Symbol('IDeploymentEnvironmentRepository');
export const DEPLOYMENT_RUN_REPOSITORY = Symbol('IDeploymentRunRepository');
export const DEPLOYMENT_SECRET_REPOSITORY = Symbol('IDeploymentSecretRepository');
export const DEPLOYMENT_SETTINGS_REPOSITORY = Symbol('IDeploymentSettingsRepository');
