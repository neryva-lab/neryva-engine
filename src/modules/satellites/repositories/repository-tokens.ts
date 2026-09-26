/**
 * DI tokens for the satellites-module repository ports (P3).
 *
 * One focused token per aggregate (interface segregation): services depend
 * only on these interfaces, never on a concrete `Pg*`/`Mongo*` class. The
 * concrete implementation behind each token is selected by `DB_PROVIDER`
 * (PostgreSQL default) in `SatellitesRepositoriesModule` via a single
 * `useFactory` per token — no provider conditionals in services or
 * repositories.
 */
export const SATELLITE_REGISTRY_REPOSITORY = Symbol('ISatelliteRegistryRepository');
export const SATELLITE_INCIDENT_REPOSITORY = Symbol('ISatelliteIncidentRepository');
export const SATELLITE_ACTIVITY_REPOSITORY = Symbol('ISatelliteActivityRepository');
export const REVOCATION_LOG_REPOSITORY = Symbol('IRevocationLogRepository');
