/**
 * MongoDB lane for `IRefreshTokenRepository` (P3) — the persistence port for
 * the `oauth_refresh_tokens` security bookkeeping rows (the full payload
 * continues to live behind `IOidcPayloadRepository`).
 *
 * The reuse tripwire (`consumeWithReuseDetection`) is the
 * concurrency-critical method: it performs the family revocation and
 * returns a discriminated outcome so the caller can emit metrics / events /
 * audit without ever holding a transaction handle. Statement ordering
 * mirrors the pg lane exactly (separate statements, no transaction).
 *
 * Behavioral truth: `src/modules/identity/oidc/oidc-adapter.ts`.
 */
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { toRefreshTokenRow, type OauthRefreshTokenMongoDoc } from './mongo-documents';
import type { IRefreshTokenRepository, RefreshConsumeOutcome, RefreshTokenRow } from './refresh-token.repository';

export class MongoRefreshTokenRepository implements IRefreshTokenRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private tokens() {
    return this.mongo.root.collection<OauthRefreshTokenMongoDoc>('oauth_refresh_tokens');
  }

  async findExpiresAt(jti: string): Promise<string | null> {
    const doc = await this.tokens().findOne({ jti }, { projection: { expires_at: 1 } });
    return doc?.expires_at ?? null;
  }

  async upsert(input: {
    jti: string;
    familyId: string;
    sessionId: string | null;
    tokenHash: string;
    grantId: string | null;
    expiresAt: string;
    rotatedFrom: string | null;
    nowIso: string;
  }): Promise<void> {
    // The pg onConflictDoUpdate sets ONLY expiresAt on conflict — the
    // $set/$setOnInsert split below reproduces that.
    await this.tokens().updateOne(
      { jti: input.jti },
      {
        $set: { expires_at: input.expiresAt },
        $setOnInsert: {
          family_id: input.familyId,
          session_id: input.sessionId,
          token_hash: input.tokenHash,
          grant_id: input.grantId,
          rotated_from: input.rotatedFrom,
          consumed_at: null,
          retired_at: null,
          revoked_at: null,
          created_at: new Date().toISOString(),
        },
      },
      { upsert: true },
    );
    if (input.rotatedFrom) {
      await this.tokens().updateOne({ jti: input.rotatedFrom }, { $set: { consumed_at: input.nowIso } });
    }
  }

  async findByJti(jti: string): Promise<RefreshTokenRow | null> {
    const doc = await this.tokens().findOne({ jti });
    return doc ? toRefreshTokenRow(doc) : null;
  }

  async consumeWithReuseDetection(jti: string, nowIso: string): Promise<RefreshConsumeOutcome> {
    const row = await this.tokens().findOne({ jti });
    if (!row) {
      return { status: 'not_found' };
    }
    if (!row.consumed_at && !row.revoked_at) {
      // Atomic single-winner consume: exactly one concurrent caller wins
      // the rotation. The losers fall through to the reuse path below.
      const won = await this.tokens().findOneAndUpdate(
        { jti, consumed_at: null, revoked_at: null },
        { $set: { consumed_at: nowIso } },
        { returnDocument: 'after' },
      );
      if (won) {
        return { status: 'consumed' };
      }
      // Lost the race — re-read for the reuse path (the winner's stamp is
      // now visible).
      const fresh = await this.tokens().findOne({ jti });
      return this.revokeFamily(fresh ?? row, nowIso);
    }
    // REUSE: a consumed or revoked token was presented again — revoke the
    // family. (A revoked-but-unconsumed token takes this path too: rotation
    // of a dead token is a replay.)
    return this.revokeFamily(row, nowIso);
  }

  /**
   * Family revocation with exactly-once first-detection: the guarded update
   * (`revoked_at: null`) ensures only the first concurrent detector gets
   * `firstDetection: true`; the rest still revoke (idempotent) but stay
   * silent. The caller alerts exactly once per family but audits every
   * attempt.
   */
  private async revokeFamily(
    row: OauthRefreshTokenMongoDoc,
    nowIso: string,
  ): Promise<RefreshConsumeOutcome> {
    const result = await this.tokens().updateMany(
      { family_id: row.family_id, revoked_at: null },
      { $set: { revoked_at: nowIso, retired_at: nowIso } },
    );
    return {
      status: 'reused',
      familyId: row.family_id,
      sessionId: row.session_id,
      firstDetection: result.modifiedCount > 0,
    };
  }

  async revoke(jti: string, nowIso: string): Promise<void> {
    await this.tokens().updateOne({ jti }, { $set: { revoked_at: nowIso } });
  }

  async revokeByGrantId(grantId: string, nowIso: string): Promise<void> {
    await this.tokens().updateMany({ grant_id: grantId }, { $set: { revoked_at: nowIso } });
  }

  async revokeByJtis(jtis: string[], nowIso: string): Promise<void> {
    if (jtis.length === 0) {
      return;
    }
    await this.tokens().updateMany({ jti: { $in: jtis } }, { $set: { revoked_at: nowIso } });
  }
}
