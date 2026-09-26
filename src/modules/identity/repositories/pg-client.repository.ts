import { eq } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { oauthClients } from '../schema';
import type {
  ClientSeed,
  IOauthClientRepository,
  OauthClient,
} from './client.repository';

/**
 * PostgreSQL implementation of `IOauthClientRepository` (P3).
 *
 * Mechanical move of the `oauth_clients` units from `OidcDrizzleAdapter`
 * (`findClient`) and `IdentityModule` (`seedFirstPartyClients`).
 * Envelope encryption/decryption of the client secret stays with the
 * caller (crypto, not persistence); this port carries the opaque envelope.
 *
 * Identity tables are platform-plane / GLOBAL — no RLS, no tenant
 * dimension — so every method goes through `db.root`.
 */
export class PgOauthClientRepository implements IOauthClientRepository {
  constructor(private readonly db: DbService) {}

  async findClientRow(clientId: string): Promise<OauthClient | null> {
    const rows = await this.db.root
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.clientId, clientId))
      .limit(1);
    return rows[0] ? toOauthClient(rows[0]) : null;
  }

  /**
   * First-party client seeding: insert-or-update each seed. The secret
   * envelope is only overwritten when the seed carries one — never
   * clobbered to unusable.
   */
  async seedClients(clients: ClientSeed[]): Promise<void> {
    for (const seed of clients) {
      await this.db.root
        .insert(oauthClients)
        .values({
          clientId: seed.clientId,
          kind: seed.kind,
          name: seed.name,
          redirectUris: seed.redirectUris,
          scopes: seed.scopes,
          grantTypes: seed.grantTypes,
          ...(seed.secretEnvelope ? { secretEnvelope: seed.secretEnvelope } : {}),
        })
        .onConflictDoUpdate({
          target: oauthClients.clientId,
          set: {
            name: seed.name,
            redirectUris: seed.redirectUris,
            scopes: seed.scopes,
            grantTypes: seed.grantTypes,
            ...(seed.secretEnvelope ? { secretEnvelope: seed.secretEnvelope } : {}),
          },
        });
    }
  }

  /** The `svc-*` service-client allowlist check for client_credentials. */
  async isServiceClientActive(clientId: string): Promise<boolean> {
    const rows = await this.db.root
      .select({ disabled: oauthClients.disabled, kind: oauthClients.kind })
      .from(oauthClients)
      .where(eq(oauthClients.clientId, clientId))
      .limit(1);
    const row = rows[0];
    return !!row && !row.disabled && row.kind === 'service';
  }
}

function toOauthClient(row: typeof oauthClients.$inferSelect): OauthClient {
  return {
    clientId: row.clientId,
    kind: row.kind,
    name: row.name,
    redirectUris: stringArray(row.redirectUris),
    scopes: stringArray(row.scopes),
    grantTypes: stringArray(row.grantTypes),
    secretEnvelope: row.secretEnvelope,
    tokenTtlSeconds: row.tokenTtlSeconds,
    disabled: row.disabled,
  };
}

/** jsonb array columns arrive as `unknown` — coerce defensively. */
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? (value as string[]) : [];
}
