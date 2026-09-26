/**
 * MongoDB lane for `IMfaRepository` (P3) — the MFA factor registry:
 * `account_credentials` documents with `kind = 'totp' | 'totp_pending'`
 * plus `account_recovery_codes`, and the `accounts.mfa_level` transitions
 * that belong to the MFA lifecycle.
 *
 * The multi-document transitions (`activate`, `disable`,
 * `regenerateRecoveryCodes`) each own their transaction via `withBypass`
 * (identity is platform-plane/global) — callers never see a transaction
 * handle.
 *
 * Behavioral truth: `src/modules/identity/mfa.service.ts`.
 */
import { randomUUID } from 'node:crypto';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import {
  binUuid,
  toTotpCredential,
  type AccountCredentialMongoDoc,
  type AccountMongoDoc,
  type AccountRecoveryCodeMongoDoc,
} from './mongo-documents';
import type { IMfaRepository, TotpCredential } from './mfa.repository';

export class MongoMfaRepository implements IMfaRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private credentials() {
    return this.mongo.root.collection<AccountCredentialMongoDoc>('account_credentials');
  }

  async findActive(accountId: string): Promise<TotpCredential | null> {
    const doc = await this.credentials().findOne({
      account_id: binUuid(accountId),
      kind: 'totp',
      revoked_at: null,
    });
    return doc ? toTotpCredential(doc) : null;
  }

  async findPending(accountId: string): Promise<TotpCredential | null> {
    const doc = await this.credentials().findOne({ account_id: binUuid(accountId), kind: 'totp_pending' });
    return doc ? toTotpCredential(doc) : null;
  }

  async enrollPending(accountId: string, secretEnvelope: string): Promise<void> {
    const now = new Date().toISOString();
    await this.credentials().updateOne(
      { account_id: binUuid(accountId), kind: 'totp_pending' },
      {
        $set: { envelope: { secret: secretEnvelope }, updated_at: now },
        $setOnInsert: { id: binUuid(randomUUID()), created_at: now },
      },
      { upsert: true },
    );
  }

  async activate(accountId: string, secretEnvelope: string, nowIso: string): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withBypass(async (ctx) => {
      const sessionOpt = { session: ctx.session };
      const accountIdBin = binUuid(accountId);
      const credentials = db.collection<AccountCredentialMongoDoc>('account_credentials');
      // Promote: delete the pending row, upsert the active TOTP row, and
      // flip the account's MFA level — one transaction.
      await credentials.deleteOne({ account_id: accountIdBin, kind: 'totp_pending' }, sessionOpt);
      await credentials.updateOne(
        { account_id: accountIdBin, kind: 'totp' },
        {
          $set: {
            envelope: { secret: secretEnvelope },
            verified_at: nowIso,
            revoked_at: null,
            updated_at: nowIso,
          },
          $setOnInsert: { id: binUuid(randomUUID()), created_at: nowIso },
        },
        { ...sessionOpt, upsert: true },
      );
      await db
        .collection<AccountMongoDoc>('accounts')
        .updateOne({ id: accountIdBin }, { $set: { mfa_level: 'totp', updated_at: nowIso } }, sessionOpt);
    });
  }

  async disable(accountId: string, nowIso: string): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withBypass(async (ctx) => {
      const sessionOpt = { session: ctx.session };
      const accountIdBin = binUuid(accountId);
      await db
        .collection<AccountCredentialMongoDoc>('account_credentials')
        .deleteMany({ account_id: accountIdBin, kind: { $in: ['totp', 'totp_pending'] } }, sessionOpt);
      await db
        .collection<AccountRecoveryCodeMongoDoc>('account_recovery_codes')
        .deleteMany({ account_id: accountIdBin, used_at: null }, sessionOpt);
      await db
        .collection<AccountMongoDoc>('accounts')
        .updateOne({ id: accountIdBin }, { $set: { mfa_level: 'none', updated_at: nowIso } }, sessionOpt);
    });
  }

  async touchLastUsed(credentialId: string, nowIso: string): Promise<void> {
    await this.credentials().updateOne(
      { id: binUuid(credentialId, 'credentialId') },
      { $set: { last_used_at: nowIso, updated_at: nowIso } },
    );
  }

  async regenerateRecoveryCodes(accountId: string, codeHashes: string[], nowIso: string): Promise<number> {
    const db = this.mongo.root;
    await this.mongo.withBypass(async (ctx) => {
      const sessionOpt = { session: ctx.session };
      const accountIdBin = binUuid(accountId);
      const codes = db.collection<AccountRecoveryCodeMongoDoc>('account_recovery_codes');
      await codes.deleteMany({ account_id: accountIdBin }, sessionOpt);
      if (codeHashes.length > 0) {
        await codes.insertMany(
          codeHashes.map((codeHash) => ({
            id: binUuid(randomUUID()),
            account_id: accountIdBin,
            code_hash: codeHash,
            used_at: null,
            created_at: nowIso,
          })),
          sessionOpt,
        );
      }
    });
    return codeHashes.length;
  }

  async consumeRecoveryCode(accountId: string, codeHash: string, nowIso: string): Promise<boolean> {
    // Atomic single-use consumption: exactly one concurrent consumer wins.
    const updated = await this.mongo.root
      .collection<AccountRecoveryCodeMongoDoc>('account_recovery_codes')
      .findOneAndUpdate(
        { account_id: binUuid(accountId), code_hash: codeHash, used_at: null },
        { $set: { used_at: nowIso } },
        { returnDocument: 'after' },
      );
    return updated !== null;
  }

  async countUnusedRecoveryCodes(accountId: string): Promise<number> {
    return this.mongo.root
      .collection<AccountRecoveryCodeMongoDoc>('account_recovery_codes')
      .countDocuments({ account_id: binUuid(accountId), used_at: null });
  }

  async mfaLevel(accountId: string): Promise<string> {
    const doc = await this.mongo.root
      .collection<AccountMongoDoc>('accounts')
      .findOne({ id: binUuid(accountId) }, { projection: { mfa_level: 1 } });
    return doc?.mfa_level ?? 'none';
  }
}
