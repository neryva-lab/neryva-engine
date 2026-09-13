import { and, eq, inArray } from 'drizzle-orm';
import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { ApiError } from '../../common/http/api-error';
import { StorageService } from '../../common/infra/storage/storage.service';
import { envelopeDecrypt, envelopeEncrypt } from '../../common/infra/crypto/envelope';
import { uuidv7 } from '../../common/ids/uuidv7';
import { sha256Hex } from '../../common/infra/crypto/envelope';
import { connectorAccounts, type ConnectorAccount } from './connectors.schema';
import { artifacts, uploadSessions } from './schema';
import { CONNECTOR_PROVIDERS, CONNECTOR_PROVIDER_IDS, ConnectorOAuthRequiredError } from './connector.port';

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
  ) {}

  async link(input: {
    orgId: string;
    provider: string;
    displayName: string;
    config: Record<string, unknown>;
    credentials?: string;
    actor: string;
  }): Promise<ConnectorAccount> {
    assertUuid(input.orgId, 'orgId');
    if (!(CONNECTOR_PROVIDER_IDS as readonly string[]).includes(input.provider)) {
      throw ApiError.validation({ provider: `must be one of ${CONNECTOR_PROVIDER_IDS.join(', ')}` });
    }
    if (!input.displayName.trim()) {
      throw ApiError.validation({ display_name: 'must not be empty' });
    }
    const id = uuidv7();
    return this.db.withOrg(input.orgId, async (tx) => {
      const rows = await tx
        .insert(connectorAccounts)
        .values({
          id,
          organizationId: input.orgId,
          provider: input.provider,
          displayName: input.displayName.trim().slice(0, 128),
          config: input.config,
          ...(input.credentials ? { credentialsSealed: { v: envelopeEncrypt(input.credentials) } } : {}),
          createdBy: input.actor,
        })
        .onConflictDoUpdate({
          target: [connectorAccounts.organizationId, connectorAccounts.provider, connectorAccounts.displayName],
          set: {
            config: input.config,
            ...(input.credentials ? { credentialsSealed: { v: envelopeEncrypt(input.credentials) } } : {}),
            state: 'active',
            updatedAt: new Date().toISOString(),
          },
        })
        .returning();
      return rows[0];
    });
  }

  async list(orgId: string): Promise<ConnectorAccount[]> {
    assertUuid(orgId, 'orgId');
    return this.db.withOrg(orgId, (tx) =>
      tx.select().from(connectorAccounts).where(eq(connectorAccounts.organizationId, orgId)),
    );
  }

  async setState(input: { orgId: string; accountId: string; state: 'active' | 'paused' | 'error'; actor: string }): Promise<ConnectorAccount> {
    assertUuid(input.orgId, 'orgId');
    return this.db.withOrg(input.orgId, async (tx) => {
      const rows = await tx
        .update(connectorAccounts)
        .set({ state: input.state, updatedAt: new Date().toISOString() })
        .where(and(eq(connectorAccounts.organizationId, input.orgId), eq(connectorAccounts.id, input.accountId)))
        .returning();
      if (rows.length === 0) {
        throw ApiError.notFound('connector account');
      }
      return rows[0];
    });
  }

  /**
   * One incremental sync: port.fetchUpdates → per-document artifact +
   * UPLOADED upload_session (the ingestion worker takes it from there) →
   * cursor + last_synced_at update. The cursor update rides the SAME TX as
   * the artifact rows so a crash replays the batch (at-least-once, deduped
   * by the pipeline's content-addressed document versions).
   */
  async sync(orgId: string, account: ConnectorAccount): Promise<{ synced: number; truncated: boolean }> {
    const port = CONNECTOR_PROVIDERS.get(account.provider);
    if (!port) {
      throw ApiError.validation({ provider: `no connector port for ${account.provider}` });
    }
    const credentials = account.credentialsSealed
      ? envelopeDecrypt(String((account.credentialsSealed as { v?: string }).v ?? ''))
      : undefined;
    let result;
    try {
      result = await port.fetchUpdates({
        config: (account.config ?? {}) as Record<string, unknown>,
        credentials,
        cursor: (account.cursor ?? {}) as Record<string, unknown>,
        maxDocuments: ConnectorsService.MAX_DOCUMENTS_PER_SYNC,
      });
    } catch (err) {
      const message = err instanceof ConnectorOAuthRequiredError ? err.message : (err as Error).message;
      await this.recordError(orgId, account.id, message);
      throw err;
    }
    for (const doc of result.documents) {
      const bytes = Buffer.from(doc.content, 'utf8');
      if (bytes.byteLength > ConnectorsService.MAX_BYTES_PER_DOCUMENT) {
        continue;
      }
      const artifactId = uuidv7();
      const objectKey = `org/${orgId}/source_document/${artifactId}.txt`;
      this.storage.assertTenantKey(objectKey, orgId);
      await this.storage.putObject({ key: objectKey, contentType: 'text/plain; charset=utf-8', body: bytes });
      await this.db.withOrg(orgId, async (tx) => {
        await tx.insert(artifacts).values({
          id: artifactId,
          organizationId: orgId,
          purpose: 'SOURCE_DOCUMENT',
          objectKey,
          contentTypeDeclared: 'text/plain; charset=utf-8',
          contentTypeDetected: 'text/plain; charset=utf-8',
          byteLength: bytes.byteLength,
          sha256: Buffer.from(sha256Hex(doc.content), 'hex'),
          scanStatus: 'pending',
          state: 'active',
          createdBy: `connector:${account.provider}`,
        });
        await tx.insert(uploadSessions).values({
          id: uuidv7(),
          organizationId: orgId,
          artifactId,
          purpose: 'SOURCE_DOCUMENT',
          mediaType: 'text/plain; charset=utf-8',
          byteLength: bytes.byteLength,
          // Straight to UPLOADED: the connector already stored the bytes.
          state: 'UPLOADED',
          expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
          createdBy: `connector:${account.provider}`,
        });
      });
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
    return { synced: result.documents.length, truncated: result.truncated };
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
