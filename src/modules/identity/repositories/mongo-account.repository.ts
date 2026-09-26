/**
 * MongoDB lane for `IAccountRepository` (P3) — the persistence port for the
 * `accounts` collection.
 *
 * Platform-plane / GLOBAL: identity documents carry no org predicate (see
 * `mongo-documents.ts`). UUIDs are BSON Binary subtype 4, timestamps are
 * ISO-8601 strings. Email filters carry a strength-2 collation to mirror
 * the pg lane's citext semantics; a duplicate-key error on the unique
 * email index is rethrown with the pg unique-violation code (`23505`).
 *
 * Behavioral truth: `src/modules/identity/accounts.service.ts`,
 * `src/modules/identity/account-deletion.service.ts`,
 * `src/modules/identity/email-change.service.ts`.
 */
import { randomUUID } from 'node:crypto';
import type { CollationOptions } from 'mongodb';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import {
  binUuid,
  isDuplicateKey,
  throwAsUniqueViolation,
  toAccount,
  uuidOf,
  type AccountMongoDoc,
} from './mongo-documents';
import type { Account, IAccountRepository } from './account.repository';

/** Strength-2 collation mirrors the pg lane's citext on `email`. */
const EMAIL_COLLATION: CollationOptions = { locale: 'en', strength: 2 };

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class MongoAccountRepository implements IAccountRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private accounts() {
    return this.mongo.root.collection<AccountMongoDoc>('accounts');
  }

  async findByEmail(email: string): Promise<Account | null> {
    const doc = await this.accounts().findOne(
      { email: normalizeEmail(email) },
      { collation: EMAIL_COLLATION },
    );
    return doc ? toAccount(doc) : null;
  }

  async findById(accountId: string): Promise<Account | null> {
    const doc = await this.accounts().findOne({ id: binUuid(accountId) });
    return doc ? toAccount(doc) : null;
  }

  async upsertByEmail(email: string): Promise<{ account: Account; created: boolean }> {
    const normalized = normalizeEmail(email);
    const now = new Date().toISOString();
    const id = randomUUID();
    const displayName = normalized.split('@')[0]?.slice(0, 256) ?? normalized;
    try {
      await this.accounts().insertOne({
        id: binUuid(id),
        email: normalized,
        display_name: displayName,
        email_verified_at: null,
        mfa_level: 'none',
        status: 'active',
        created_via: 'email_code',
        last_login_at: null,
        sessions_revoked_at: null,
        deleted_at: null,
        created_at: now,
        updated_at: now,
      });
    } catch (err) {
      if (!isDuplicateKey(err)) {
        throw err;
      }
      // Lost an insert race — the winner's row is the truth. The reread may
      // surface a non-active row; the caller enforces the active gate.
      const raced = await this.accounts().findOne({ email: normalized }, { collation: EMAIL_COLLATION });
      if (!raced) {
        throw new Error('account upsert race produced no row');
      }
      return { account: toAccount(raced), created: false };
    }
    return {
      account: {
        id,
        email: normalized,
        displayName,
        emailVerifiedAt: null,
        mfaLevel: 'none',
        status: 'active',
        createdVia: 'email_code',
        lastLoginAt: null,
        sessionsRevokedAt: null,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
      },
      created: true,
    };
  }

  async markLoginSuccess(accountId: string, nowIso: string): Promise<void> {
    await this.accounts().updateOne({ id: binUuid(accountId) }, { $set: { last_login_at: nowIso } });
  }

  async markEmailVerified(accountId: string, nowIso: string): Promise<void> {
    await this.accounts().updateOne({ id: binUuid(accountId) }, { $set: { email_verified_at: nowIso } });
  }

  async updateDisplayName(accountId: string, displayName: string): Promise<void> {
    await this.accounts().updateOne(
      { id: binUuid(accountId) },
      { $set: { display_name: displayName, updated_at: new Date().toISOString() } },
    );
  }

  async revokeAllSessions(accountId: string, nowIso: string): Promise<void> {
    await this.mongo.withBypass(async (ctx) => {
      const sessionOpt = { session: ctx.session };
      const accountIdBin = binUuid(accountId);
      await this.accounts().updateOne({ id: accountIdBin }, { $set: { sessions_revoked_at: nowIso } }, sessionOpt);
      // Observable kill-switch: `listActive` filters `revoked_at == null`,
      // so unmarked rows would still be presented as live sessions.
      await this.mongo.root
        .collection('oauth_sessions')
        .updateMany({ account_id: accountIdBin, revoked_at: null }, { $set: { revoked_at: nowIso } }, sessionOpt);
    });
  }

  async swapEmail(accountId: string, newEmail: string): Promise<void> {
    // Single-statement update is atomic on MongoDB — no transaction needed.
    // A lost uniqueness race surfaces as a duplicate-key error, rethrown
    // with the pg unique-violation code for the caller's conflict mapping.
    try {
      await this.accounts().updateOne({ id: binUuid(accountId) }, { $set: { email: normalizeEmail(newEmail) } });
    } catch (err) {
      throwAsUniqueViolation(err);
    }
  }

  async setScheduledDeletion(accountId: string, scheduledPurgeAt: string): Promise<void> {
    await this.accounts().updateOne(
      { id: binUuid(accountId) },
      { $set: { deleted_at: scheduledPurgeAt, updated_at: new Date().toISOString() } },
    );
  }

  async clearScheduledDeletion(accountId: string): Promise<void> {
    await this.accounts().updateOne(
      { id: binUuid(accountId), status: 'active' },
      { $set: { deleted_at: null, updated_at: new Date().toISOString() } },
    );
  }

  async findDeletionSchedule(accountId: string): Promise<{ deletedAt: string | null } | null> {
    const doc = await this.accounts().findOne({ id: binUuid(accountId) }, { projection: { deleted_at: 1 } });
    if (!doc) {
      return null;
    }
    return { deletedAt: doc.deleted_at };
  }

  async listPurgeDue(nowIso: string, limit: number): Promise<string[]> {
    const docs = await this.accounts()
      .find({ deleted_at: { $lte: nowIso } }, { projection: { id: 1 } })
      .sort({ deleted_at: 1 })
      .limit(limit)
      .toArray();
    return docs.map((d) => uuidOf(d.id));
  }

  async purgeAccount(accountId: string): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withBypass(async (ctx) => {
      const sessionOpt = { session: ctx.session };
      const id = binUuid(accountId);
      // Order mirrors the pg lane: grants, notifications, group memberships,
      // org memberships (every tenant — the documented administrative
      // bypass), then the account row itself.
      await db.collection('oauth_grants').deleteMany({ account_id: id }, sessionOpt);
      await db.collection('notifications').deleteMany({ account_id: id }, sessionOpt);
      await db.collection('org_group_members').deleteMany({ account_id: id }, sessionOpt);
      await db.collection('org_memberships').deleteMany({ account_id: id }, sessionOpt);
      // The pg lane cascades these off the accounts row (onDelete: cascade);
      // MongoDB has no FK cascades, so delete them explicitly for the same
      // net effect. oauth_refresh_tokens and oidc_payloads carry no account
      // FK on pg either, so they are left to expire exactly like the pg lane.
      for (const name of [
        'account_onboarding',
        'account_credentials',
        'account_recovery_codes',
        'account_identities',
        'oauth_sessions',
        'email_login_codes',
        'account_action_tokens',
      ]) {
        await db.collection(name).deleteMany({ account_id: id }, sessionOpt);
      }
      await db.collection('accounts').deleteOne({ id }, sessionOpt);
    });
  }

  async sessionGuardState(accountId: string): Promise<{ status: string; sessionsRevokedAt: string | null } | null> {
    const doc = await this.accounts().findOne(
      { id: binUuid(accountId) },
      { projection: { status: 1, sessions_revoked_at: 1 } },
    );
    if (!doc) {
      return null;
    }
    return { status: doc.status, sessionsRevokedAt: doc.sessions_revoked_at };
  }
}
