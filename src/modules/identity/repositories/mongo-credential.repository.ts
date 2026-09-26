/**
 * MongoDB lane for `ICredentialRepository` (P3) — the password factor
 * (`account_credentials` documents with `kind = 'password'`).
 *
 * Behavioral truth: `src/modules/identity/credentials.service.ts`.
 */
import { randomUUID } from 'node:crypto';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { binUuid, type AccountCredentialMongoDoc } from './mongo-documents';
import type { ICredentialRepository } from './credential.repository';

export class MongoCredentialRepository implements ICredentialRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private credentials() {
    return this.mongo.root.collection<AccountCredentialMongoDoc>('account_credentials');
  }

  async getPasswordHash(accountId: string): Promise<string | null> {
    const doc = await this.credentials().findOne(
      { account_id: binUuid(accountId), kind: 'password', revoked_at: null },
      { projection: { secret: 1 } },
    );
    return doc?.secret ?? null;
  }

  async setPasswordHash(accountId: string, passwordHash: string): Promise<void> {
    // Atomic insert-or-replace on the (account_id, kind) unique key — the
    // mongo equivalent of the pg lane's onConflictDoUpdate. The set clause
    // mirrors the pg lane's conflict-update (secret + updated_at).
    const now = new Date().toISOString();
    await this.credentials().updateOne(
      { account_id: binUuid(accountId), kind: 'password' },
      {
        $set: { secret: passwordHash, updated_at: now },
        $setOnInsert: { id: binUuid(randomUUID()), created_at: now },
      },
      { upsert: true },
    );
  }
}
