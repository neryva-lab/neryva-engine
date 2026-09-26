/**
 * MongoDB lane for `IEmailCodeRepository` (P3) — the persistence port for
 * `email_login_codes`.
 *
 * Issue semantics are preserved exactly: `issue` voids ALL previous codes
 * for the account (unconditional `consumed_at` stamp), purges dead rows
 * (consumed OR expired), then inserts the new code — three separate
 * statements, not one transaction. `findLive` is the verify read; the
 * caller applies the expiry / attempt-ceiling policy. Consumption is the
 * atomic `consume` (exactly one concurrent consumer wins). Rate limiting
 * stays in the service (Redis), not in this port.
 *
 * Behavioral truth: `src/modules/identity/email-code.service.ts`.
 */
import { randomUUID } from 'node:crypto';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { binUuid, toEmailLoginCode, type EmailLoginCodeMongoDoc } from './mongo-documents';
import type { EmailLoginCode, IEmailCodeRepository } from './email-code.repository';

export class MongoEmailCodeRepository implements IEmailCodeRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private codes() {
    return this.mongo.root.collection<EmailLoginCodeMongoDoc>('email_login_codes');
  }

  async issue(
    accountId: string,
    codeHash: string,
    requestIp: string | null,
    expiresAt: string,
    nowIso: string,
  ): Promise<void> {
    const accountIdBin = binUuid(accountId);
    // Three separate statements, exactly like the pg lane — not one
    // transaction. A fresh issue voids ALL previous codes for the account
    // (unconditional stamp, no null guard), dead rows (consumed or
    // expired) are purged so the per-account history stays bounded, then
    // the new code is inserted.
    await this.codes().updateMany({ account_id: accountIdBin }, { $set: { consumed_at: nowIso } });
    await this.codes().deleteMany({
      account_id: accountIdBin,
      $or: [{ consumed_at: { $ne: null } }, { expires_at: { $lte: nowIso } }],
    });
    await this.codes().insertOne({
      id: binUuid(randomUUID()),
      account_id: accountIdBin,
      code_hash: codeHash,
      expires_at: expiresAt,
      attempts: 0,
      consumed_at: null,
      request_ip: requestIp,
      created_at: nowIso,
    });
  }

  async findLive(accountId: string, codeHash: string): Promise<EmailLoginCode | null> {
    // Newest first: the live code is always at the head even for accounts
    // with a long history (an unordered LIMIT could miss it entirely).
    const docs = await this.codes()
      .find({ account_id: binUuid(accountId) })
      .sort({ created_at: -1 })
      .limit(20)
      .toArray();
    const live = docs.find((d) => d.code_hash === codeHash && d.consumed_at === null);
    return live ? toEmailLoginCode(live) : null;
  }

  async consume(accountId: string, codeHash: string): Promise<boolean> {
    // Atomic single-use consumption — exactly one concurrent consumer wins.
    const result = await this.codes().updateOne(
      { account_id: binUuid(accountId), code_hash: codeHash, consumed_at: null },
      { $set: { consumed_at: new Date().toISOString() } },
    );
    return result.modifiedCount === 1;
  }

  async registerFailedAttempt(accountId: string): Promise<void> {
    await this.codes().updateMany(
      { account_id: binUuid(accountId), consumed_at: null },
      { $inc: { attempts: 1 } },
    );
  }
}
