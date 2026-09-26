/**
 * MongoDB lane for `IOauthClientRepository` (P3) — the persistence port for
 * `oauth_clients`. Envelope encryption/decryption of the client secret stays
 * with the caller (crypto, not persistence); this port carries the opaque
 * envelope.
 *
 * Behavioral truth: `src/modules/identity/oidc/oidc-adapter.ts`
 * (`findClient`) and `src/modules/identity/identity.module.ts`
 * (`seedFirstPartyClients`).
 */
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { toOauthClient, type OauthClientMongoDoc } from './mongo-documents';
import type { ClientSeed, IOauthClientRepository, OauthClient } from './client.repository';

export class MongoClientRepository implements IOauthClientRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private clients() {
    return this.mongo.root.collection<OauthClientMongoDoc>('oauth_clients');
  }

  async findClientRow(clientId: string): Promise<OauthClient | null> {
    const doc = await this.clients().findOne({ client_id: clientId });
    return doc ? toOauthClient(doc) : null;
  }

  async seedClients(clients: ClientSeed[]): Promise<void> {
    for (const seed of clients) {
      const now = new Date().toISOString();
      const set: {
        name: string;
        redirect_uris: string[];
        scopes: string[];
        grant_types: string[];
        secret_envelope?: string | null;
      } = {
        name: seed.name,
        redirect_uris: seed.redirectUris,
        scopes: seed.scopes,
        grant_types: seed.grantTypes,
      };
      // The secret envelope is only overwritten when the seed carries one —
      // an absent envelope never clobbers the row to unusable (mirrors the
      // pg lane's truthiness guard exactly).
      if (seed.secretEnvelope) {
        set.secret_envelope = seed.secretEnvelope;
      }
      await this.clients().updateOne(
        { client_id: seed.clientId },
        {
          $set: set,
          $setOnInsert: {
            kind: seed.kind,
            secret_envelope: seed.secretEnvelope ?? null,
            disabled: false,
            token_ttl_seconds: null,
            created_at: now,
            updated_at: now,
          },
        },
        { upsert: true },
      );
    }
  }

  async isServiceClientActive(clientId: string): Promise<boolean> {
    const doc = await this.clients().findOne({ client_id: clientId }, { projection: { kind: 1, disabled: 1 } });
    return !!doc && doc.kind === 'service' && doc.disabled === false;
  }
}
