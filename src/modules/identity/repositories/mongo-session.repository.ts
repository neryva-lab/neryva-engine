/**
 * MongoDB lane for `ISessionRepository` (P3) — the persistence port for
 * `oauth_sessions`.
 *
 * Behavioral truth: `src/modules/identity/password.service.ts`
 * (list/revoke), `src/modules/identity/identity-public.service.ts`
 * (the SESSION_REGISTRY_PORT `isSessionActive` guard), and
 * `src/modules/identity/oidc/oidc-adapter.ts` (`syncSessionRow`,
 * the reuse-tripwire session revocation, `resolveAccountForSessionUid`).
 */
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import {
  binUuid,
  toOauthSession,
  uuidOf,
  type AccountMongoDoc,
  type OauthSessionMongoDoc,
} from './mongo-documents';
import type { ISessionRepository, OauthSession } from './session.repository';

export class MongoSessionRepository implements ISessionRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private sessions() {
    return this.mongo.root.collection<OauthSessionMongoDoc>('oauth_sessions');
  }

  async upsertSessionRow(input: {
    sid: string;
    accountId: string;
    clientId: string;
    familyId: string;
    sessionUid: string | null;
    device: unknown;
    nowIso: string;
  }): Promise<void> {
    // Preserves the pg onConflictDoUpdate refresh semantics: on conflict
    // only the last-seen bump, device, and uid refresh; the identity fields
    // are insert-only.
    await this.sessions().updateOne(
      { sid: input.sid },
      {
        $set: { last_seen_at: input.nowIso, device: input.device, session_uid: input.sessionUid },
        $setOnInsert: {
          account_id: binUuid(input.accountId),
          client_id: input.clientId,
          family_id: input.familyId,
          ip_country: null,
          revoked_at: null,
          created_at: input.nowIso,
        },
      },
      { upsert: true },
    );
  }

  async findBySidOrUid(sid: string): Promise<OauthSession | null> {
    const doc = await this.sessions().findOne({ $or: [{ sid }, { session_uid: sid }] });
    return doc ? toOauthSession(doc) : null;
  }

  async listActive(accountId: string, limit: number): Promise<OauthSession[]> {
    const docs = await this.sessions()
      .find({ account_id: binUuid(accountId), revoked_at: null })
      .sort({ created_at: -1 })
      .limit(limit)
      .toArray();
    return docs.map(toOauthSession);
  }

  async revokeOne(
    accountId: string,
    sid: string,
    nowIso: string,
  ): Promise<{ sid: string; sessionUid: string | null } | null> {
    // Account-scoped compare-and-set: marks the row revoked only when it
    // belongs to the account and is not already revoked.
    const updated = await this.sessions().findOneAndUpdate(
      { sid, account_id: binUuid(accountId), revoked_at: null },
      { $set: { revoked_at: nowIso } },
      { returnDocument: 'after' },
    );
    if (!updated) {
      return null;
    }
    return { sid: updated.sid, sessionUid: updated.session_uid };
  }

  async revokeBySid(sid: string, nowIso: string): Promise<{ accountId: string; sessionUid: string | null } | null> {
    const doc = await this.sessions().findOne({ sid });
    if (!doc) {
      return null;
    }
    await this.sessions().updateOne({ sid }, { $set: { revoked_at: nowIso } });
    return { accountId: uuidOf(doc.account_id), sessionUid: doc.session_uid };
  }

  async revokeBySessionUid(sessionUid: string, nowIso: string): Promise<void> {
    await this.sessions().updateMany({ session_uid: sessionUid }, { $set: { revoked_at: nowIso } });
  }

  async findAccountIdBySessionUid(sessionUid: string): Promise<string | null> {
    const doc = await this.sessions().findOne({ session_uid: sessionUid }, { projection: { account_id: 1 } });
    return doc ? uuidOf(doc.account_id) : null;
  }

  async findSessionGuard(
    sid: string,
  ): Promise<{ accountId: string; status: string; sessionsRevokedAt: string | null } | null> {
    const session = await this.sessions().findOne({ $or: [{ session_uid: sid }, { sid }] });
    if (!session) {
      return null;
    }
    const account = await this.mongo.root
      .collection<AccountMongoDoc>('accounts')
      .findOne({ id: session.account_id }, { projection: { status: 1, sessions_revoked_at: 1 } });
    if (!account) {
      return null;
    }
    return {
      accountId: uuidOf(session.account_id),
      status: account.status,
      sessionsRevokedAt: account.sessions_revoked_at,
    };
  }
}
