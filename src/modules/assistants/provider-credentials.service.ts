import { and, eq, ne } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { pgViolation } from '../../common/infra/db/pg-types';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { envelopeEncrypt, sha256Hex } from '../../common/infra/crypto/envelope';
import { uuidv7 } from '../../common/ids/uuidv7';
import { providerCredentials, providerEnablements, isModelProvider, ProviderCredential, ProviderEnablement, MODEL_PROVIDERS } from './provider-credentials.schema';

/**
 * Provider credential store + org provider enablements — REL-1.2/REL-1.3
 * (release_ledger.md). CRUD is console-surface (owner/admin) or staff-surface
 * (platform provisioning, source forced to 'platform'); every privileged act
 * is audited; list/read models NEVER include sealed material — only the
 * display fingerprint. Plaintext exists exactly twice: in the request that
 * delivered it and transiently inside envelopeDecrypt at the audited
 * disclosure point.
 */

/** Display-safe mask — the only secret-derived material that ever leaves the sealing boundary. */
export function fingerprintSecret(secret: string): string {
  return `****${secret.slice(-4)}`;
}

/** Stable non-secret correlation id for uniqueness without leaking the key. */
export function deriveExternalRef(secret: string): string {
  return `k-${sha256Hex(secret).slice(0, 16)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertOrgId(orgId: string): void {
  if (!UUID_RE.test(orgId)) {
    throw ApiError.validation({ orgId: 'must be a uuid' });
  }
}

function assertProvider(provider: string): void {
  if (!isModelProvider(provider)) {
    throw ApiError.validation({ provider: `must be one of ${MODEL_PROVIDERS.join('|')}` });
  }
}

function assertLabel(label: string): void {
  const trimmed = label.trim();
  if (trimmed.length === 0 || trimmed.length > 128) {
    throw ApiError.validation({ label: 'must be 1..128 chars' });
  }
}

function assertSecret(secret: string): void {
  if (typeof secret !== 'string' || secret.length < 8 || secret.length > 4096) {
    throw ApiError.validation({ secret: 'must be 8..4096 chars' });
  }
}

/** The DB never returns raw 23505s — an (org, provider, external_ref) collision is a client conflict. */
function mapCredentialUniqueViolation(err: unknown): never {
  const { code } = pgViolation(err);
  if (code === '23505') {
    throw ApiError.conflict('a credential with this external ref already exists for this org and provider');
  }
  throw err as Error;
}

export interface ProviderCredentialView {
  id: string;
  provider: string;
  label: string;
  external_ref: string;
  source: string;
  status: string;
  secret_fingerprint: string;
  created_at: string | null;
  rotated_at: string | null;
  revoked_at: string | null;
}

function toView(row: ProviderCredential): ProviderCredentialView {
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    external_ref: row.externalRef,
    source: row.source,
    status: row.status,
    secret_fingerprint: row.secretFingerprint,
    created_at: row.createdAt,
    rotated_at: row.rotatedAt,
    revoked_at: row.revokedAt,
  };
}

@Injectable()
export class ProviderCredentialsService {
  private static readonly LIST_CAP = 200;

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  async create(input: {
    orgId: string;
    provider: string;
    label: string;
    secret: string;
    externalRef?: string | null;
    source: 'platform' | 'byok';
    actorId: string;
  }): Promise<ProviderCredentialView> {
    assertOrgId(input.orgId);
    assertProvider(input.provider);
    assertLabel(input.label);
    assertSecret(input.secret);
    const externalRef = (input.externalRef ?? deriveExternalRef(input.secret)).trim();
    if (externalRef.length === 0 || externalRef.length > 256) {
      throw ApiError.validation({ external_ref: 'must be 1..256 chars' });
    }
    const rows = await this.db
      .withOrg(input.orgId, (tx) =>
        tx
          .insert(providerCredentials)
          .values({
            id: uuidv7(),
            organizationId: input.orgId,
            provider: input.provider,
            label: input.label.trim(),
            externalRef,
            source: input.source,
            status: 'active',
            secretSealed: envelopeEncrypt(input.secret),
            secretFingerprint: fingerprintSecret(input.secret),
            createdBy: input.actorId.slice(0, 128),
          })
          .returning(),
      )
      .catch(mapCredentialUniqueViolation);
    const row = rows[0];
    await this.audit.add({
      action: 'provider_credential.created',
      resourceType: 'provider_credential',
      resourceId: row.id,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      details: { provider: row.provider, source: row.source, external_ref: row.externalRef, fingerprint: row.secretFingerprint },
    });
    return toView(row);
  }

  /** Atomic in-place key swap: the sealed material is replaced, status stays active. Revoked rows never resurrect. */
  async rotate(input: { orgId: string; credentialId: string; secret: string; actorId: string }): Promise<ProviderCredentialView> {
    assertOrgId(input.orgId);
    assertSecret(input.secret);
    if (!UUID_RE.test(input.credentialId)) {
      throw ApiError.validation({ credential_id: 'must be a uuid' });
    }
    // A concurrent revoke between the pre-check and the update is caught by
    // the `ne(status, 'revoked')` predicate inside the UPDATE itself — the
    // guarded update is the authority, the pre-check is only for the error
    // message.
    const rows = await this.db
      .withOrg(input.orgId, (tx) =>
        tx
          .update(providerCredentials)
          .set({
            secretSealed: envelopeEncrypt(input.secret),
            secretFingerprint: fingerprintSecret(input.secret),
            externalRef: deriveExternalRef(input.secret),
            rotatedBy: input.actorId.slice(0, 128),
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
      .catch(mapCredentialUniqueViolation);
    if (rows.length === 0) {
      const existing = await this.db.withOrg(input.orgId, (tx) =>
        tx.select({ id: providerCredentials.id }).from(providerCredentials).where(eq(providerCredentials.id, input.credentialId)).limit(1),
      );
      if (existing.length === 0) {
        throw ApiError.notFound('provider credential');
      }
      throw ApiError.conflict('credential is revoked — create a new credential instead of rotating it');
    }
    const row = rows[0];
    await this.audit.add({
      action: 'provider_credential.rotated',
      resourceType: 'provider_credential',
      resourceId: row.id,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      details: { provider: row.provider, fingerprint: row.secretFingerprint },
    });
    return toView(row);
  }

  /** Terminal: a revoked credential never returns to active (rotate refuses, create instead). */
  async revoke(input: { orgId: string; credentialId: string; actorId: string }): Promise<ProviderCredentialView> {
    assertOrgId(input.orgId);
    if (!UUID_RE.test(input.credentialId)) {
      throw ApiError.validation({ credential_id: 'must be a uuid' });
    }
    const existing = await this.db.withOrg(input.orgId, (tx) =>
      tx.select().from(providerCredentials).where(and(eq(providerCredentials.id, input.credentialId), eq(providerCredentials.organizationId, input.orgId))).limit(1),
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
        .set({ status: 'revoked', revokedAt: new Date().toISOString() })
        .where(and(eq(providerCredentials.id, input.credentialId), eq(providerCredentials.organizationId, input.orgId)))
        .returning(),
    );
    const row = rows[0];
    await this.audit.add({
      action: 'provider_credential.revoked',
      resourceType: 'provider_credential',
      resourceId: row.id,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      details: { provider: row.provider },
    });
    return toView(row);
  }

  async list(orgId: string): Promise<ProviderCredentialView[]> {
    assertOrgId(orgId);
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx.select().from(providerCredentials).where(eq(providerCredentials.organizationId, orgId)).limit(ProviderCredentialsService.LIST_CAP),
    );
    return rows.map(toView);
  }

  // ── Enablements (REL-1.3) ───────────────────────────────────────────────

  async listEnablements(orgId: string): Promise<ProviderEnablement[]> {
    assertOrgId(orgId);
    return this.db.withOrg(orgId, (tx) => tx.select().from(providerEnablements).where(eq(providerEnablements.organizationId, orgId)));
  }

  async setEnablement(input: { orgId: string; provider: string; enabled: boolean; actorId: string }): Promise<ProviderEnablement> {
    assertOrgId(input.orgId);
    assertProvider(input.provider);
    const rows = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .insert(providerEnablements)
        .values({
          organizationId: input.orgId,
          provider: input.provider,
          enabled: input.enabled,
          updatedBy: input.actorId.slice(0, 128),
        })
        .onConflictDoUpdate({
          target: [providerEnablements.organizationId, providerEnablements.provider],
          set: { enabled: input.enabled, updatedBy: input.actorId.slice(0, 128), updatedAt: new Date().toISOString() },
        })
        .returning(),
    );
    const row = rows[0];
    await this.audit.add({
      action: 'provider.enablement_set',
      resourceType: 'provider_enablement',
      resourceId: `${input.orgId}:${input.provider}`,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      details: { provider: input.provider, enabled: input.enabled },
    });
    return row;
  }

  /**
   * Per-provider usability facts (REL-1.6 availability view input): a
   * provider is usable when it has an ACTIVE credential AND is not
   * administratively disabled (absent enablement row = enabled by default —
   * provisioning is the act that matters).
   */
  async providerFacts(orgId: string): Promise<Map<string, { hasActiveCredential: boolean; enabled: boolean; usable: boolean }>> {
    assertOrgId(orgId);
    const creds = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({ provider: providerCredentials.provider })
        .from(providerCredentials)
        .where(and(eq(providerCredentials.organizationId, orgId), eq(providerCredentials.status, 'active'))),
    );
    const enablements = await this.listEnablements(orgId);
    const withCred = new Set(creds.map((c) => c.provider));
    const enabledMap = new Map(enablements.map((e) => [e.provider, e.enabled]));
    const providers = new Set<string>([...MODEL_PROVIDERS, ...withCred, ...enabledMap.keys()]);
    const facts = new Map<string, { hasActiveCredential: boolean; enabled: boolean; usable: boolean }>();
    for (const provider of providers) {
      const hasActiveCredential = withCred.has(provider);
      const enabled = enabledMap.get(provider) ?? true;
      facts.set(provider, { hasActiveCredential, enabled, usable: hasActiveCredential && enabled });
    }
    return facts;
  }
}
