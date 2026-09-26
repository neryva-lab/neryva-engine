import { Injectable, Inject } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ApiError } from '../../common/http/api-error';
import { envelopeEncrypt, sha256Hex } from '../../common/infra/crypto/envelope';
import {
  isModelProvider,
  ProviderCredential,
  ProviderEnablement,
  MODEL_PROVIDERS,
} from './provider-credentials.schema';
import { PROVIDER_CREDENTIAL_REPOSITORY } from './repositories/repository-tokens';
import type { IProviderCredentialRepository } from './repositories/provider-credential.repository';

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
  /** P6: incident semantics (null reason = routine revoke). */
  revocation_reason: string | null;
  compromised: boolean;
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
    revocation_reason: row.revocationReason,
    compromised: row.compromised,
  };
}

@Injectable()
export class ProviderCredentialsService {
  private static readonly LIST_CAP = 200;

  constructor(
    @Inject(PROVIDER_CREDENTIAL_REPOSITORY) private readonly credentials: IProviderCredentialRepository,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
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
    const row = await this.credentials.provisionCredential({
      orgId: input.orgId,
      provider: input.provider,
      label: input.label.trim(),
      sealedSecret: envelopeEncrypt(input.secret),
      secretFingerprint: fingerprintSecret(input.secret),
      externalRef,
      source: input.source,
      createdBy: input.actorId.slice(0, 128),
    });
    await this.audit.add({
      action: 'provider_credential.created',
      resourceType: 'provider_credential',
      resourceId: row.id,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      details: {
        provider: row.provider,
        source: row.source,
        external_ref: row.externalRef,
        fingerprint: row.secretFingerprint,
      },
    });
    return toView(row);
  }

  /** Atomic in-place key swap: the sealed material is replaced, status stays active. Revoked rows never resurrect. */
  async rotate(input: {
    orgId: string;
    credentialId: string;
    secret: string;
    actorId: string;
  }): Promise<ProviderCredentialView> {
    assertOrgId(input.orgId);
    assertSecret(input.secret);
    if (!UUID_RE.test(input.credentialId)) {
      throw ApiError.validation({ credential_id: 'must be a uuid' });
    }
    // A concurrent revoke between the pre-check and the update is caught by
    // the guarded update inside the repository — the guarded update is the
    // authority, the pre-check is only for the error message.
    const row = await this.credentials.rotateCredential({
      orgId: input.orgId,
      credentialId: input.credentialId,
      sealedSecret: envelopeEncrypt(input.secret),
      secretFingerprint: fingerprintSecret(input.secret),
      externalRef: deriveExternalRef(input.secret),
      rotatedBy: input.actorId.slice(0, 128),
    });
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

  /**
   * Terminal: a revoked credential never returns to active (rotate refuses,
   * create instead). P6 incident semantics: `compromised: true` blocks
   * identically AND alerts owner/admin (error, email) — a leaked key is an
   * incident, not housekeeping. `reason` is operator free text (bounded);
   * the alert carries provider + label only, never secret-derived material
   * beyond the display fingerprint (which the list surface already shows).
   */
  async revoke(input: {
    orgId: string;
    credentialId: string;
    actorId: string;
    reason?: string;
    compromised?: boolean;
  }): Promise<ProviderCredentialView> {
    assertOrgId(input.orgId);
    if (!UUID_RE.test(input.credentialId)) {
      throw ApiError.validation({ credential_id: 'must be a uuid' });
    }
    const reason =
      typeof input.reason === 'string' && input.reason.trim().length > 0
        ? input.reason.trim().slice(0, 512)
        : null;
    const compromised = input.compromised === true;
    const row = await this.credentials.revokeCredential({
      orgId: input.orgId,
      credentialId: input.credentialId,
      revocationReason: reason,
      compromised,
    });
    await this.audit.add({
      action: compromised ? 'provider_credential.compromised' : 'provider_credential.revoked',
      resourceType: 'provider_credential',
      resourceId: row.id,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      details: { provider: row.provider, ...(reason ? { reason } : {}), compromised },
    });
    if (compromised) {
      // Never throws (notification plane degrades independently).
      await this.notifications.notifyOrgRoles(input.orgId, ['owner', 'admin'], {
        kind: 'credential.compromised',
        severity: 'error',
        title: `Provider credential compromised: ${row.provider} (${row.label})`,
        body: 'The key was revoked and all runs using it are now refused. Rotate the key at the provider, then provision a fresh credential.',
        data: { credential_id: row.id, provider: row.provider },
        email: true,
      });
    }
    return toView(row);
  }

  async list(orgId: string): Promise<ProviderCredentialView[]> {
    assertOrgId(orgId);
    const rows = await this.credentials.listCredentials(orgId);
    return rows.map(toView);
  }

  // ── Enablements (REL-1.3) ───────────────────────────────────────────────

  async listEnablements(orgId: string): Promise<ProviderEnablement[]> {
    assertOrgId(orgId);
    return this.credentials.listEnablements(orgId);
  }

  async setEnablement(input: {
    orgId: string;
    provider: string;
    enabled: boolean;
    actorId: string;
  }): Promise<ProviderEnablement> {
    assertOrgId(input.orgId);
    assertProvider(input.provider);
    const row = await this.credentials.upsertEnablement({
      orgId: input.orgId,
      provider: input.provider,
      enabled: input.enabled,
      updatedBy: input.actorId.slice(0, 128),
    });
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
  async providerFacts(
    orgId: string,
  ): Promise<Map<string, { hasActiveCredential: boolean; enabled: boolean; usable: boolean }>> {
    assertOrgId(orgId);
    const creds = await this.credentials.providersWithActiveCredentials(orgId);
    const enablements = await this.listEnablements(orgId);
    const withCred = new Set(creds);
    const enabledMap = new Map(enablements.map((e) => [e.provider, e.enabled]));
    const providers = new Set<string>([...MODEL_PROVIDERS, ...withCred, ...enabledMap.keys()]);
    const facts = new Map<
      string,
      { hasActiveCredential: boolean; enabled: boolean; usable: boolean }
    >();
    for (const provider of providers) {
      const hasActiveCredential = withCred.has(provider);
      const enabled = enabledMap.get(provider) ?? true;
      facts.set(provider, { hasActiveCredential, enabled, usable: hasActiveCredential && enabled });
    }
    return facts;
  }
}
