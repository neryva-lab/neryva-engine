import { and, eq, inArray } from 'drizzle-orm';
import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { ApiError } from '../../common/http/api-error';
import { AuditService } from '../../common/audit/audit.service';
import { StorageService } from '../../common/infra/storage/storage.service';
import { envelopeDecrypt, envelopeEncrypt } from '../../common/infra/crypto/envelope';
import { uuidv7 } from '../../common/ids/uuidv7';
import { sha256Hex } from '../../common/infra/crypto/envelope';
import { connectorAccounts, connectorDocuments, connectorOAuthApps, type ConnectorAccount } from './connectors.schema';
import { artifacts, documents, documentSourceAcls, uploadSessions } from './schema';
import {
  CONNECTOR_PROVIDERS,
  CONNECTOR_PROVIDER_IDS,
  ConnectorOAuthRequiredError,
  type ConnectorDocument,
} from './connector.port';
import {
  bundleNeedsRefresh,
  buildAuthorizeUrl,
  exchangeCode,
  fetchMsalCcToken,
  OAUTH_PROVIDER_META,
  openDanceState,
  parseCredentialBundle,
  refreshAccessToken,
  sealBundle,
  sealDanceState,
  type ConnectorCredentialBundle,
} from './connector-oauth';

export interface ConnectorAccountView {
  id: string;
  provider: string;
  displayName: string;
  state: string;
  lastSyncedAt: string | null;
  lastError: string | null;
  /** Credential presence only — sealed material never leaves the vault. */
  hasCredentials: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** Connector slug namespace: deterministic per external id, stable across syncs (kebab-safe). */
export function connectorDocSlug(provider: string, externalId: string): string {
  const safeProvider = provider.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `ext-${safeProvider}-${sha256Hex(`${provider}:${externalId}`).slice(0, 8)}`;
}

/**
 * Link-time credential shape check (fail fast at link, not at 3am sync).
 * google_drive binds tokens exclusively via the OAuth dance; sharepoint
 * needs an msal-cc JSON bundle; static providers take the raw secret.
 * Pure — unit-tested.
 */
export function validateLinkCredentials(provider: string, credentials: string | undefined): void {
  if (provider === 'google_drive') {
    if (credentials !== undefined && credentials !== '') {
      throw ApiError.validation({ credentials: 'google_drive binds tokens via the OAuth dance — link without credentials, then authorize' });
    }
    return;
  }
  if (provider === 'sitemap') {
    return;
  }
  if (provider === 'sharepoint') {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(credentials ?? '');
    } catch {
      throw ApiError.validation({ credentials: 'sharepoint needs an msal-cc JSON bundle {client_id, tenant, secret}' });
    }
    const b = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
    if (typeof b['client_id'] !== 'string' || typeof b['tenant'] !== 'string' || typeof b['secret'] !== 'string' || (b['secret'] as string).length < 8) {
      throw ApiError.validation({ credentials: 'sharepoint needs an msal-cc JSON bundle {client_id, tenant, secret}' });
    }
    return;
  }
  if (credentials === undefined || credentials.trim().length < 4) {
    throw ApiError.validation({ credentials: `${provider} needs its credential at link time (or link without, then authorize)` });
  }
}

/**
 * Connectors service (FL-2.5) — account CRUD + incremental sync. Synced
 * content lands in the EXISTING ingestion pipeline: bytes are stored under
 * the org's tenant-bound SOURCE_DOCUMENT prefix, an artifact row and an
 * UPLOADED upload_session are created, and the ingestion worker owns scan →
 * extract → index exactly as for user uploads. No second ingestion path.
 */
@Injectable()
export class ConnectorsService {
  private static readonly logger = new Logger(ConnectorsService.name);
  private static readonly MAX_DOCUMENTS_PER_SYNC = 10;
  private static readonly MAX_BYTES_PER_DOCUMENT = 5 * 1024 * 1024;

  constructor(
    private readonly db: DbService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  async link(input: {
    orgId: string;
    provider: string;
    displayName: string;
    config: Record<string, unknown>;
    credentials?: string;
    actor: string;
  }): Promise<ConnectorAccountView> {
    assertUuid(input.orgId, 'orgId');
    if (!(CONNECTOR_PROVIDER_IDS as readonly string[]).includes(input.provider)) {
      throw ApiError.validation({ provider: `must be one of ${CONNECTOR_PROVIDER_IDS.join(', ')}` });
    }
    if (!input.displayName.trim()) {
      throw ApiError.validation({ display_name: 'must not be empty' });
    }
    // Fail fast on credential shape (sync-time failures are harder to debug):
    // static providers take the raw secret, sharepoint takes an msal-cc JSON
    // bundle, google_drive binds exclusively via the OAuth dance.
    validateLinkCredentials(input.provider, input.credentials);
    // Normalize sharepoint input into the sealed bundle convention so
    // ensureFreshCredentials reads one shape for every provider.
    let sealedCredentials = input.credentials;
    if (input.provider === 'sharepoint' && input.credentials) {
      const b = JSON.parse(input.credentials) as { client_id: string; tenant: string; secret: string };
      sealedCredentials = JSON.stringify({ kind: 'msal-cc', client_id: b.client_id, tenant: b.tenant, secret: b.secret });
    }
    const id = uuidv7();
    const rows = await this.db.withOrg(input.orgId, async (tx) => {
      const inserted = await tx
        .insert(connectorAccounts)
        .values({
          id,
          organizationId: input.orgId,
          provider: input.provider,
          displayName: input.displayName.trim().slice(0, 128),
          config: input.config,
          ...(sealedCredentials ? { credentialsSealed: { v: envelopeEncrypt(sealedCredentials) } } : {}),
          createdBy: input.actor,
        })
        .onConflictDoUpdate({
          target: [connectorAccounts.organizationId, connectorAccounts.provider, connectorAccounts.displayName],
          set: {
            config: input.config,
            ...(sealedCredentials ? { credentialsSealed: { v: envelopeEncrypt(sealedCredentials) } } : {}),
            state: 'active',
            updatedAt: new Date().toISOString(),
          },
        })
        .returning();
      return inserted;
    });
    await this.audit.add({
      action: 'connector.linked',
      resourceType: 'connector_account',
      resourceId: rows[0].id,
      actorType: 'account',
      actorId: input.actor,
      tenantId: input.orgId,
      details: { provider: input.provider, display_name: input.displayName.trim().slice(0, 128) },
    });
    return ConnectorsService.toView(rows[0]);
  }

  /**
   * Redacted inventory: sealed credential material never leaves the vault —
   * callers learn presence only. Config is returned (connection parameters,
   * never secrets — enforced by review, not by type).
   */
  async list(orgId: string): Promise<ConnectorAccountView[]> {
    assertUuid(orgId, 'orgId');
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx.select().from(connectorAccounts).where(eq(connectorAccounts.organizationId, orgId)),
    );
    return rows.map((a) => ConnectorsService.toView(a));
  }

  private static toView(a: ConnectorAccount): ConnectorAccountView {
    return {
      id: a.id,
      provider: a.provider,
      displayName: a.displayName,
      state: a.state,
      lastSyncedAt: a.lastSyncedAt,
      lastError: a.lastError,
      hasCredentials: a.credentialsSealed != null,
      createdBy: a.createdBy,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    };
  }

  async setState(input: { orgId: string; accountId: string; state: 'active' | 'paused' | 'error'; actor: string }): Promise<ConnectorAccountView> {
    assertUuid(input.orgId, 'orgId');
    const rows = await this.db.withOrg(input.orgId, async (tx) => {
      const updated = await tx
        .update(connectorAccounts)
        .set({ state: input.state, updatedAt: new Date().toISOString() })
        .where(and(eq(connectorAccounts.organizationId, input.orgId), eq(connectorAccounts.id, input.accountId)))
        .returning();
      if (updated.length === 0) {
        throw ApiError.notFound('connector account');
      }
      return updated;
    });
    return ConnectorsService.toView(rows[0]);
  }

  /**
   * One incremental sync: fresh credentials → port.fetchUpdates → per-document
   * artifact + UPLOADED upload_session (the ingestion worker takes it from
   * there, writing the external-id map + source ACL at READY) → tombstones
   * for source deletions → cursor + last_synced_at update. Re-sync of a
   * mapped external id targets the SAME document (new version, never a
   * duplicate). Per-doc failures become `skipped`, never sync failures.
   */
  async sync(orgId: string, accountId: string): Promise<{ synced: number; truncated: boolean; skipped: number; tombstoned: number }> {
    // Fresh row per sync (never trust a stale caller snapshot for state or
    // sealed material): credentials rotate, admins pause accounts.
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx.select().from(connectorAccounts).where(and(eq(connectorAccounts.organizationId, orgId), eq(connectorAccounts.id, accountId))).limit(1),
    );
    const account = rows[0];
    if (!account) {
      throw ApiError.notFound('connector account');
    }
    if (account.state !== 'active') {
      return { synced: 0, truncated: false, skipped: 0, tombstoned: 0 };
    }
    const port = CONNECTOR_PROVIDERS.get(account.provider);
    if (!port) {
      throw ApiError.validation({ provider: `no connector port for ${account.provider}` });
    }
    const usable = await this.ensureFreshCredentials(orgId, account);
    let result;
    try {
      result = await port.fetchUpdates({
        config: (account.config ?? {}) as Record<string, unknown>,
        credentials: usable,
        cursor: (account.cursor ?? {}) as Record<string, unknown>,
        maxDocuments: ConnectorsService.MAX_DOCUMENTS_PER_SYNC,
      });
    } catch (err) {
      const message = err instanceof ConnectorOAuthRequiredError ? err.message : (err as Error).message;
      await this.recordError(orgId, account.id, message);
      throw err;
    }
    // Deletions first: tombstone mapped documents (state retired ⇒
    // unreachable by retrieval; mapping retained for resurrection).
    let tombstoned = 0;
    for (const externalId of result.deletedExternalIds ?? []) {
      tombstoned += await this.tombstoneExternalDocument(orgId, account.id, externalId);
    }
    let skipped = (result.skipped ?? []).length;
    let synced = 0;
    for (const doc of result.documents) {
      try {
        synced += await this.ingestConnectorDocument(orgId, account, doc);
      } catch (err) {
        skipped += 1;
        ConnectorsService.logger.warn(`connector doc skipped ${account.provider}:${doc.externalId}: ${(err as Error).message}`);
      }
    }
    await this.db.withOrg(orgId, async (tx) => {
      await tx
        .update(connectorAccounts)
        .set({
          cursor: result.nextCursor,
          lastSyncedAt: new Date().toISOString(),
          state: 'active',
          lastError: null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(connectorAccounts.id, account.id));
    });
    if (tombstoned > 0) {
      ConnectorsService.logger.log(`connector ${account.id} (${account.provider}) tombstoned ${tombstoned} deleted document(s)`);
    }
    return { synced, truncated: result.truncated, skipped, tombstoned };
  }

  /**
   * Stage one connector document into the ingestion pipeline. Binary payloads
   * (PDF/images, base64) ride with their real media type so the extraction
   * chain (OCR/transcribe) handles them exactly like uploads.
   */
  private async ingestConnectorDocument(orgId: string, account: ConnectorAccount, doc: ConnectorDocument): Promise<number> {
    const bytes = doc.contentBytesB64 ? Buffer.from(doc.contentBytesB64, 'base64') : Buffer.from(doc.content, 'utf8');
    if (bytes.byteLength === 0) {
      return 0;
    }
    if (bytes.byteLength > ConnectorsService.MAX_BYTES_PER_DOCUMENT) {
      return 0;
    }
    const mediaType = doc.mediaType.startsWith('text/') || doc.mediaType === 'application/json' ? doc.mediaType : doc.mediaType;
    const ext = mediaType === 'application/pdf' ? 'pdf' : mediaType.startsWith('image/') ? mediaType.split('/')[1] ?? 'bin' : 'txt';
    const artifactId = uuidv7();
    const objectKey = `org/${orgId}/source_document/${artifactId}.${ext}`;
    this.storage.assertTenantKey(objectKey, orgId);
    await this.storage.putObject({ key: objectKey, contentType: `${mediaType}; charset=utf-8`, body: bytes });
    // Mapping-aware target: a known external id appends a version to its
    // document; a new one creates (slug is deterministic per external id).
    const mapped = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({ documentId: connectorDocuments.documentId })
        .from(connectorDocuments)
        .where(
          and(
            eq(connectorDocuments.organizationId, orgId),
            eq(connectorDocuments.connectorAccountId, account.id),
            eq(connectorDocuments.externalId, doc.externalId),
          ),
        )
        .limit(1),
    );
    const slug = connectorDocSlug(account.provider, doc.externalId);
    await this.db.withOrg(orgId, async (tx) => {
      await tx.insert(artifacts).values({
        id: artifactId,
        organizationId: orgId,
        purpose: 'SOURCE_DOCUMENT',
        objectKey,
        contentTypeDeclared: mediaType,
        contentTypeDetected: mediaType,
        byteLength: bytes.byteLength,
        sha256: Buffer.from(sha256Hex(doc.contentBytesB64 ?? doc.content), 'hex'),
        scanStatus: 'pending',
        state: 'active',
        createdBy: `connector:${account.provider}`,
      });
      await tx.insert(uploadSessions).values({
        id: uuidv7(),
        organizationId: orgId,
        artifactId,
        purpose: 'SOURCE_DOCUMENT',
        mediaType,
        byteLength: bytes.byteLength,
        // Straight to UPLOADED: the connector already stored the bytes.
        state: 'UPLOADED',
        sourceSlug: slug,
        title: doc.title.slice(0, 256),
        targetDocumentId: mapped[0]?.documentId ?? null,
        connectorRef: { account_id: account.id, provider: account.provider, external_id: doc.externalId },
        sourceAcl: doc.acl ?? { mode: 'open' },
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
        createdBy: `connector:${account.provider}`,
      });
    });
    return 1;
  }

  /** Tombstone a source-deleted document (retired ⇒ unreachable; mapping kept). */
  private async tombstoneExternalDocument(orgId: string, accountId: string, externalId: string): Promise<number> {
    return this.db.withOrg(orgId, async (tx) => {
      const mapped = await tx
        .select({ documentId: connectorDocuments.documentId })
        .from(connectorDocuments)
        .where(
          and(
            eq(connectorDocuments.organizationId, orgId),
            eq(connectorDocuments.connectorAccountId, accountId),
            eq(connectorDocuments.externalId, externalId),
          ),
        )
        .limit(1);
      if (!mapped[0]) {
        return 0;
      }
      await tx.update(documents).set({ state: 'retired', updatedAt: new Date().toISOString() }).where(eq(documents.id, mapped[0].documentId));
      await tx.delete(documentSourceAcls).where(eq(documentSourceAcls.documentId, mapped[0].documentId));
      return 1;
    });
  }

  /** Active accounts due for a scheduled sweep (worker path, bypass-scoped). */
  async dueAccounts(): Promise<ConnectorAccount[]> {
    return this.db.withBypass(async (tx) => {
      const rows = await tx
        .select()
        .from(connectorAccounts)
        .where(and(eq(connectorAccounts.state, 'active'), inArray(connectorAccounts.provider, [...CONNECTOR_PROVIDERS.keys()])))
        .limit(50);
      return rows;
    });
  }

  /**
   * Open an account's sealed bundle. Corrupt/missing envelopes resolve to
   * null (adapters then fail loud with a clear re-link message) — never throw
   * here, or one bad row would poison the whole sweep.
   */
  private openAccountBundle(account: ConnectorAccount): ConnectorCredentialBundle | null {
    const sealed = account.credentialsSealed as { v?: string } | null;
    const raw = typeof sealed?.v === 'string' ? sealed.v : '';
    if (!raw) {
      return null;
    }
    try {
      return parseCredentialBundle(envelopeDecrypt(raw));
    } catch {
      return null;
    }
  }

  /**
   * Resolve the USABLE secret for an adapter call. Static bundles pass
   * through; oauth2 refreshes when inside the skew window (persisting the
   * rotated bundle); msal-cc mints server-to-server. Adapters never see
   * sealed material and never implement refresh themselves.
   */
  private async ensureFreshCredentials(orgId: string, account: ConnectorAccount): Promise<string | undefined> {
    const bundle = this.openAccountBundle(account);
    if (!bundle) {
      return undefined;
    }
    if (bundle.kind === 'static') {
      return bundle.secret;
    }
    if (bundle.kind === 'msal-cc') {
      if (!bundleNeedsRefresh(bundle)) {
        return bundle.access_token as string;
      }
      const fresh = await fetchMsalCcToken({ tenant: bundle.tenant, clientId: bundle.client_id, clientSecret: bundle.secret });
      const next: ConnectorCredentialBundle = {
        ...bundle,
        access_token: fresh.access_token,
        expires_at: new Date(Date.now() + fresh.expires_in * 1000).toISOString(),
      };
      await this.persistBundle(orgId, account.id, next);
      return fresh.access_token;
    }
    // oauth2 user dance.
    if (!bundleNeedsRefresh(bundle)) {
      return bundle.access_token;
    }
    if (!bundle.refresh_token) {
      throw new Error('connector OAuth token expired and no refresh token is stored — re-run the OAuth dance');
    }
    const app = await this.getOAuthApp(orgId, account.provider);
    if (!app) {
      throw new Error(`connector OAuth app missing for ${account.provider} — register it before syncing`);
    }
    const meta = OAUTH_PROVIDER_META[account.provider];
    const fresh = await refreshAccessToken({
      tokenUrl: meta.tokenUrl,
      clientId: app.clientId,
      clientSecret: envelopeDecrypt(app.clientSecretSealed),
      refreshToken: bundle.refresh_token,
    });
    const next: ConnectorCredentialBundle = {
      kind: 'oauth2',
      access_token: fresh.access_token,
      refresh_token: fresh.refresh_token,
      expires_at: new Date(Date.now() + fresh.expires_in * 1000).toISOString(),
    };
    await this.persistBundle(orgId, account.id, next);
    return fresh.access_token;
  }

  private async persistBundle(orgId: string, accountId: string, bundle: ConnectorCredentialBundle): Promise<void> {
    await this.db.withOrg(orgId, (tx) =>
      tx
        .update(connectorAccounts)
        .set({ credentialsSealed: { v: sealBundle(bundle) }, updatedAt: new Date().toISOString() })
        .where(eq(connectorAccounts.id, accountId)),
    );
  }

  // ── OAuth apps (org BYO provider apps) ─────────────────────────────────

  async createOAuthApp(input: { orgId: string; provider: string; clientId: string; clientSecret: string; actor: string }): Promise<{ id: string; provider: string }> {
    assertUuid(input.orgId, 'orgId');
    if (!OAUTH_PROVIDER_META[input.provider]) {
      throw ApiError.validation({ provider: `OAuth dance not supported for ${input.provider}` });
    }
    if (!input.clientId.trim() || input.clientSecret.length < 8) {
      throw ApiError.validation({ client: 'client_id and a client_secret of at least 8 chars are required' });
    }
    const rows = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .insert(connectorOAuthApps)
        .values({
          id: uuidv7(),
          organizationId: input.orgId,
          provider: input.provider,
          clientId: input.clientId.trim().slice(0, 512),
          clientSecretSealed: envelopeEncrypt(input.clientSecret),
          createdBy: input.actor,
        })
        .onConflictDoUpdate({
          target: [connectorOAuthApps.organizationId, connectorOAuthApps.provider],
          set: {
            clientId: input.clientId.trim().slice(0, 512),
            clientSecretSealed: envelopeEncrypt(input.clientSecret),
            updatedAt: new Date().toISOString(),
          },
        })
        .returning({ id: connectorOAuthApps.id, provider: connectorOAuthApps.provider }),
    );
    return { id: rows[0].id, provider: rows[0].provider };
  }

  async listOAuthApps(orgId: string): Promise<Array<{ provider: string; client_id: string; has_secret: boolean; updated_at: string }>> {
    assertUuid(orgId, 'orgId');
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx.select().from(connectorOAuthApps).where(eq(connectorOAuthApps.organizationId, orgId)),
    );
    return rows.map((r) => ({ provider: r.provider, client_id: r.clientId, has_secret: true, updated_at: r.updatedAt }));
  }

  async deleteOAuthApp(orgId: string, provider: string): Promise<void> {
    assertUuid(orgId, 'orgId');
    await this.db.withOrg(orgId, (tx) => tx.delete(connectorOAuthApps).where(and(eq(connectorOAuthApps.organizationId, orgId), eq(connectorOAuthApps.provider, provider))));
  }

  private async getOAuthApp(orgId: string, provider: string): Promise<{ clientId: string; clientSecretSealed: string } | null> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx.select().from(connectorOAuthApps).where(and(eq(connectorOAuthApps.organizationId, orgId), eq(connectorOAuthApps.provider, provider))).limit(1),
    );
    return rows[0] ?? null;
  }

  /**
   * Admin-browser authorize URL for the dance. The sealed state binds
   * account+org+expiry without server-side storage; the callback validates
   * it before any token exchange.
   */
  async authorizeUrl(input: { orgId: string; accountId: string; actor: string; redirectUri: string }): Promise<{ authorize_url: string }> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.accountId, 'accountId');
    const accounts = await this.db.withOrg(input.orgId, (tx) =>
      tx.select().from(connectorAccounts).where(and(eq(connectorAccounts.organizationId, input.orgId), eq(connectorAccounts.id, input.accountId))).limit(1),
    );
    const account = accounts[0];
    if (!account) {
      throw ApiError.notFound('connector account');
    }
    const meta = OAUTH_PROVIDER_META[account.provider];
    if (!meta) {
      throw ApiError.validation({ provider: `OAuth dance not supported for ${account.provider}` });
    }
    const app = await this.getOAuthApp(input.orgId, account.provider);
    if (!app) {
      throw ApiError.conflict(`no OAuth app registered for ${account.provider} — register one first`, { reason: 'oauth_app_missing' });
    }
    const state = sealDanceState({
      orgId: input.orgId,
      accountId: account.id,
      provider: account.provider,
      nonce: uuidv7(),
      exp: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });
    return {
      authorize_url: buildAuthorizeUrl({ provider: account.provider, clientId: app.clientId, redirectUri: input.redirectUri, scope: meta.scopes, state }),
    };
  }

  /**
   * OAuth callback: validate state → exchange code → seal the bundle onto
   * the account → reactivate. Redirect target is chosen by the controller.
   */
  async handleOAuthCallback(input: { orgId: string; code: string; state: string; redirectUri: string }): Promise<{ accountId: string; provider: string }> {
    if (!input.code || input.code.length > 1024) {
      throw ApiError.validation({ code: 'invalid OAuth code' });
    }
    const dance = openDanceState(input.state, input.orgId);
    const meta = OAUTH_PROVIDER_META[dance.provider];
    if (!meta) {
      throw ApiError.validation({ provider: `OAuth dance not supported for ${dance.provider}` });
    }
    const accounts = await this.db.withOrg(input.orgId, (tx) =>
      tx.select().from(connectorAccounts).where(and(eq(connectorAccounts.organizationId, input.orgId), eq(connectorAccounts.id, dance.accountId))).limit(1),
    );
    const account = accounts[0];
    if (!account || account.provider !== dance.provider) {
      throw ApiError.validation({ state: 'connector account mismatch' });
    }
    const app = await this.getOAuthApp(input.orgId, dance.provider);
    if (!app) {
      throw ApiError.conflict(`no OAuth app registered for ${dance.provider}`, { reason: 'oauth_app_missing' });
    }
    const tokens = await exchangeCode({
      tokenUrl: meta.tokenUrl,
      clientId: app.clientId,
      clientSecret: envelopeDecrypt(app.clientSecretSealed),
      code: input.code,
      redirectUri: input.redirectUri,
    });
    const bundle: ConnectorCredentialBundle = {
      kind: 'oauth2',
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    };
    await this.persistBundle(input.orgId, account.id, bundle);
    await this.setState({ orgId: input.orgId, accountId: account.id, state: 'active', actor: 'oauth-callback' });
    return { accountId: account.id, provider: account.provider };
  }

  private async recordError(orgId: string, accountId: string, message: string): Promise<void> {
    await this.db.withOrg(orgId, async (tx) => {
      await tx
        .update(connectorAccounts)
        .set({ state: 'error', lastError: message.slice(0, 512), updatedAt: new Date().toISOString() })
        .where(eq(connectorAccounts.id, accountId));
    });
  }
}

function assertUuid(id: string, field: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw ApiError.validation({ [field]: 'must be a uuid' });
  }
}
