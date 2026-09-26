import { and, eq, ne } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { pgViolation } from '../../../common/infra/db/pg-types';
import { ApiError } from '../../../common/http/api-error';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { providerCredentials, providerEnablements } from '../provider-credentials.schema';
import type { ProviderCredential, ProviderEnablement } from '../provider-credentials.schema';
import type { IProviderCredentialRepository } from './provider-credential.repository';

/**
 * PostgreSQL implementation of `IProviderCredentialRepository` (P3).
 *
 * Mechanical move of the `ProviderCredentialsService` persistence units:
 * every method owns its unit of work via `DbService.withOrg` (RLS —
 * `organization_id` is always part of the tenant scope). No transaction
 * handle leaks through this interface.
 *
 * Secrecy boundary: the service seals the secret (envelopeEncrypt) and
 * derives `secretFingerprint`/`externalRef` BEFORE calling — plaintext
 * never crosses this interface; only sealed rows are persisted/returned.
 * The guarded UPDATE is the concurrency authority for rotate; revoke is
 * check-then-act; 23505 maps to conflict here (never a raw 23505 to the
 * caller).
 *
 * What stays OUT (still the service's job): input validation
 * (`assertUuid`, label/provider shape, secret shape), tracing spans, audit
 * writes (replayed by the service from inputs + results), envelope
 * sealing/unsealing and fingerprint derivation, row → view mapping.
 */
export class PgProviderCredentialRepository implements IProviderCredentialRepository {
  private static readonly LIST_CAP = 200;

  constructor(private readonly db: DbService) {}

  /**
   * The DB never returns raw 23505s — an (org, provider, external_ref)
   * collision is a client conflict.
   */
  private static mapCredentialUniqueViolation(err: unknown): never {
    const { code } = pgViolation(err);
    if (code === '23505') {
      throw ApiError.conflict(
        'a credential with this external ref already exists for this org and provider',
      );
    }
    throw err as Error;
  }

  /** Provision a new credential (sealed secret only — never plaintext). */
  async provisionCredential(input: {
    orgId: string;
    provider: string;
    label: string;
    sealedSecret: string;
    secretFingerprint: string;
    externalRef: string;
    source: 'platform' | 'byok';
    createdBy: string;
  }): Promise<ProviderCredential> {
    const rows = await this.db
      .withOrg(input.orgId, (tx) =>
        tx
          .insert(providerCredentials)
          .values({
            id: uuidv7(),
            organizationId: input.orgId,
            provider: input.provider,
            label: input.label,
            externalRef: input.externalRef,
            source: input.source,
            status: 'active',
            secretSealed: input.sealedSecret,
            secretFingerprint: input.secretFingerprint,
            createdBy: input.createdBy,
          })
          .returning(),
      )
      .catch(PgProviderCredentialRepository.mapCredentialUniqueViolation);
    return rows[0];
  }

  /**
   * Atomic in-place key swap: the sealed material is replaced, status stays
   * active. Revoked rows never resurrect. A concurrent revoke between the
   * pre-check and the update is caught by the `ne(status, 'revoked')`
   * predicate inside the UPDATE itself — the guarded update is the
   * authority, the pre-check is only for the error message.
   */
  async rotateCredential(input: {
    orgId: string;
    credentialId: string;
    sealedSecret: string;
    secretFingerprint: string;
    externalRef: string;
    rotatedBy: string;
  }): Promise<ProviderCredential> {
    const rows = await this.db
      .withOrg(input.orgId, (tx) =>
        tx
          .update(providerCredentials)
          .set({
            secretSealed: input.sealedSecret,
            secretFingerprint: input.secretFingerprint,
            externalRef: input.externalRef,
            rotatedBy: input.rotatedBy,
            rotatedAt: new Date().toISOString(),
          })
          .where(
            and(
              eq(providerCredentials.id, input.credentialId),
              eq(providerCredentials.organizationId, input.orgId),
              ne(providerCredentials.status, 'revoked'),
            ),
          )
          .returning(),
      )
      .catch(PgProviderCredentialRepository.mapCredentialUniqueViolation);
    if (rows.length === 0) {
      const existing = await this.db.withOrg(input.orgId, (tx) =>
        tx
          .select({ id: providerCredentials.id })
          .from(providerCredentials)
          .where(eq(providerCredentials.id, input.credentialId))
          .limit(1),
      );
      if (existing.length === 0) {
        throw ApiError.notFound('provider credential');
      }
      throw ApiError.conflict(
        'credential is revoked — create a new credential instead of rotating it',
      );
    }
    return rows[0];
  }

  /** Terminal revoke (never hard-delete); check-then-act. */
  async revokeCredential(input: {
    orgId: string;
    credentialId: string;
    revocationReason: string | null;
    compromised: boolean;
  }): Promise<ProviderCredential> {
    const existing = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .select()
        .from(providerCredentials)
        .where(
          and(
            eq(providerCredentials.id, input.credentialId),
            eq(providerCredentials.organizationId, input.orgId),
          ),
        )
        .limit(1),
    );
    if (existing.length === 0) {
      throw ApiError.notFound('provider credential');
    }
    if (existing[0].status === 'revoked') {
      throw ApiError.conflict('credential is already revoked');
    }
    const rows = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .update(providerCredentials)
        .set({
          status: 'revoked',
          revokedAt: new Date().toISOString(),
          revocationReason: input.revocationReason,
          compromised: input.compromised,
        })
        .where(
          and(
            eq(providerCredentials.id, input.credentialId),
            eq(providerCredentials.organizationId, input.orgId),
          ),
        )
        .returning(),
    );
    return rows[0];
  }

  async listCredentials(orgId: string): Promise<ProviderCredential[]> {
    return this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(providerCredentials)
        .where(eq(providerCredentials.organizationId, orgId))
        .limit(PgProviderCredentialRepository.LIST_CAP),
    );
  }

  /** Providers with at least one ACTIVE credential in the org. */
  async providersWithActiveCredentials(orgId: string): Promise<string[]> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({ provider: providerCredentials.provider })
        .from(providerCredentials)
        .where(
          and(
            eq(providerCredentials.organizationId, orgId),
            eq(providerCredentials.status, 'active'),
          ),
        ),
    );
    return rows.map((r) => r.provider);
  }

  async listEnablements(orgId: string): Promise<ProviderEnablement[]> {
    return this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(providerEnablements)
        .where(eq(providerEnablements.organizationId, orgId)),
    );
  }

  /**
   * Upsert the per-org provider enablement (INSERT…ON CONFLICT on
   * (organization_id, provider)).
   */
  async upsertEnablement(input: {
    orgId: string;
    provider: string;
    enabled: boolean;
    updatedBy: string;
  }): Promise<ProviderEnablement> {
    const rows = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .insert(providerEnablements)
        .values({
          organizationId: input.orgId,
          provider: input.provider,
          enabled: input.enabled,
          updatedBy: input.updatedBy,
        })
        .onConflictDoUpdate({
          target: [providerEnablements.organizationId, providerEnablements.provider],
          set: {
            enabled: input.enabled,
            updatedBy: input.updatedBy,
            updatedAt: new Date().toISOString(),
          },
        })
        .returning(),
    );
    return rows[0];
  }
}
