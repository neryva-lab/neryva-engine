/**
 * MongoDB lane for `IAccountActionTokenRepository` (P3) — the persistence
 * port for `account_action_tokens` (the email-change / account-deletion
 * token lifecycle).
 *
 * Like email codes, `issue` voids the previous unconsumed token of the
 * same kind and inserts the new one as separate statements. `peek` is the
 * verify-without-consuming read (unconsumed row or null); the caller
 * applies the expiry / attempt-ceiling policy. `consume` is the atomic
 * single-use compare-and-set — exactly one concurrent consumer wins.
 * The Redis issue-cooldown stays in the service.
 *
 * Behavioral truth: `src/modules/identity/account-actions.service.ts`.
 */
import { randomUUID } from 'node:crypto';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { binUuid, toAccountActionToken, type AccountActionTokenMongoDoc } from './mongo-documents';
import type { AccountActionToken, IAccountActionTokenRepository } from './account-action-token.repository';

export class MongoAccountActionTokenRepository implements IAccountActionTokenRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private tokens() {
    return this.mongo.root.collection<AccountActionTokenMongoDoc>('account_action_tokens');
  }

  async issue(
    accountId: string,
    kind: string,
    tokenHash: string,
    requestIp: string | null,
    expiresAt: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    const accountIdBin = binUuid(accountId);
    // Void previous unconsumed tokens of this kind for the account, then
    // insert the new token — separate statements, not one transaction.
    await this.tokens().updateMany(
      { account_id: accountIdBin, kind, used_at: null },
      { $set: { used_at: now } },
    );
    await this.tokens().insertOne({
      id: binUuid(randomUUID()),
      account_id: accountIdBin,
      kind,
      token_hash: tokenHash,
      expires_at: expiresAt,
      attempts: 0,
      used_at: null,
      request_ip: requestIp,
      created_at: now,
    });
  }

  async peek(tokenHash: string, kind: string): Promise<AccountActionToken | null> {
    const doc = await this.tokens().findOne({ token_hash: tokenHash, kind });
    return doc && doc.used_at === null ? toAccountActionToken(doc) : null;
  }

  async consume(id: string, nowIso: string): Promise<AccountActionToken | null> {
    // Atomic single-use compare-and-set by row id — exactly one concurrent
    // consumer wins, mirroring the pg lane's `WHERE id AND used_at IS NULL`
    // CAS (the id is unique in both lanes).
    const updated = await this.tokens().findOneAndUpdate(
      { id: binUuid(id), used_at: null },
      { $set: { used_at: nowIso } },
      { returnDocument: 'after' },
    );
    return updated ? toAccountActionToken(updated) : null;
  }

  async registerFailedAttempt(tokenHash: string, kind: string): Promise<void> {
    await this.tokens().updateOne(
      { token_hash: tokenHash, kind, used_at: null },
      { $inc: { attempts: 1 } },
    );
  }
}
