/**
 * MongoDB lane for `IGrantCodeRepository` (P3) — the persistence port for
 * `oauth_grants` (authorization-code rows). The caller maps rows to the
 * oidc-provider payload shape (scope join, `consumed: true` marker); this
 * port speaks domain rows only.
 *
 * Behavioral truth: `src/modules/identity/oidc/oidc-adapter.ts`.
 */
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { binUuid, toGrantCodeRow, type OauthGrantMongoDoc } from './mongo-documents';
import type { GrantCodeRow, IGrantCodeRepository } from './grant-code.repository';

export class MongoGrantCodeRepository implements IGrantCodeRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private grants() {
    return this.mongo.root.collection<OauthGrantMongoDoc>('oauth_grants');
  }

  async upsertGrantCode(input: {
    codeHash: string;
    accountId: string;
    clientId: string;
    redirectUri: string | null;
    scopes: string[];
    pkceChallenge: string | null;
    challengeMethod: string | null;
    nonce: string | null;
    expiresAt: string;
  }): Promise<void> {
    // Plain insert, like the pg lane — a duplicate code_hash surfaces as a
    // duplicate-key error, the mongo analogue of the pg unique violation.
    await this.grants().insertOne({
      code_hash: input.codeHash,
      account_id: binUuid(input.accountId),
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      scopes: input.scopes,
      pkce_challenge: input.pkceChallenge,
      challenge_method: input.challengeMethod,
      nonce: input.nonce,
      consumed_at: null,
      expires_at: input.expiresAt,
      created_at: new Date().toISOString(),
    });
  }

  async findByCodeHash(codeHash: string): Promise<GrantCodeRow | null> {
    const doc = await this.grants().findOne({ code_hash: codeHash });
    return doc ? toGrantCodeRow(doc) : null;
  }

  async consumeByCodeHash(codeHash: string, nowIso: string): Promise<void> {
    await this.grants().updateOne({ code_hash: codeHash }, { $set: { consumed_at: nowIso } });
  }

  async destroyByCodeHash(codeHash: string): Promise<void> {
    await this.grants().deleteOne({ code_hash: codeHash });
  }

  async deleteByAccountId(accountId: string): Promise<void> {
    await this.grants().deleteMany({ account_id: binUuid(accountId) });
  }
}
