import { and, eq, inArray, isNull } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { oauthRefreshTokens } from '../schema';
import type {
  IRefreshTokenRepository,
  RefreshConsumeOutcome,
  RefreshTokenRow,
} from './refresh-token.repository';

/**
 * PostgreSQL implementation of `IRefreshTokenRepository` (P3).
 *
 * Mechanical move of the `oauth_refresh_tokens` security bookkeeping units
 * from `OidcDrizzleAdapter` (rotation upsert, the reuse tripwire,
 * token/grant destroy paths). The full payload dual-write stays with
 * `IOidcPayloadRepository` (the caller performs it next, as before).
 *
 * The reuse tripwire (`consumeWithReuseDetection`) is the
 * concurrency-critical method: statement ordering mirrors the pg lane
 * exactly (separate statements, no transaction).
 *
 * Identity tables are platform-plane / GLOBAL — no RLS, no tenant
 * dimension — so every method goes through `db.root`.
 */
export class PgRefreshTokenRepository implements IRefreshTokenRepository {
  constructor(private readonly db: DbService) {}

  /** Expiry read for the rotation clamp caps (predecessor / existing row). */
  async findExpiresAt(jti: string): Promise<string | null> {
    const rows = await this.db.root
      .select({ expiresAt: oauthRefreshTokens.expiresAt })
      .from(oauthRefreshTokens)
      .where(eq(oauthRefreshTokens.jti, jti))
      .limit(1);
    return rows[0]?.expiresAt ?? null;
  }

  /**
   * Rotation upsert: insert-or-update the row with the caller-clamped
   * expiry (the upsert only ever refreshes `expiresAt` — never extends
   * it), then mark the predecessor `consumedAt` when this is a rotation.
   * Separate statements, no transaction — as before.
   */
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
    await this.db.root
      .insert(oauthRefreshTokens)
      .values({
        jti: input.jti,
        familyId: input.familyId,
        sessionId: input.sessionId,
        tokenHash: input.tokenHash,
        grantId: input.grantId,
        expiresAt: input.expiresAt,
        rotatedFrom: input.rotatedFrom,
      })
      .onConflictDoUpdate({
        target: oauthRefreshTokens.jti,
        set: { expiresAt: input.expiresAt },
      });
    if (input.rotatedFrom) {
      await this.db.root
        .update(oauthRefreshTokens)
        .set({ consumedAt: input.nowIso })
        .where(eq(oauthRefreshTokens.jti, input.rotatedFrom));
    }
  }

  /** Raw row read; the caller applies the `isRefreshRowUsable` policy. */
  async findByJti(jti: string): Promise<RefreshTokenRow | null> {
    const rows = await this.db.root
      .select()
      .from(oauthRefreshTokens)
      .where(eq(oauthRefreshTokens.jti, jti))
      .limit(1);
    return rows[0] ? toRefreshTokenRow(rows[0]) : null;
  }

  /**
   * The refresh-reuse tripwire, statement-for-statement like the pg lane:
   * - row absent → `{ status: 'not_found' }`
   * - row already consumed → revoke the whole family (`revokedAt` +
   *   `retiredAt`) → `{ status: 'reused', …, firstDetection }`, where
   *   `firstDetection` is true only when the row was not already revoked
   * - row live → stamp `consumedAt` → `{ status: 'consumed' }`
   *
   * Note the final consume is an unconditional `SET consumed_at WHERE
   * jti = …` (no `consumed_at IS NULL` guard) — preserved verbatim.
   */
  async consumeWithReuseDetection(jti: string, nowIso: string): Promise<RefreshConsumeOutcome> {
    const rows = await this.db.root
      .select()
      .from(oauthRefreshTokens)
      .where(eq(oauthRefreshTokens.jti, jti))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return { status: 'not_found' };
    }
    if (!row.consumedAt && !row.revokedAt) {
      // Atomic single-winner consume: exactly one concurrent caller wins
      // the rotation. The losers fall through to the reuse path below.
      const won = await this.db.root
        .update(oauthRefreshTokens)
        .set({ consumedAt: nowIso })
        .where(
          and(
            eq(oauthRefreshTokens.jti, jti),
            isNull(oauthRefreshTokens.consumedAt),
            isNull(oauthRefreshTokens.revokedAt),
          ),
        )
        .returning({ jti: oauthRefreshTokens.jti });
      if (won.length === 1) {
        return { status: 'consumed' };
      }
      // Lost the race — re-read for the reuse path (the winner's stamp is
      // now visible).
      const fresh = await this.db.root
        .select()
        .from(oauthRefreshTokens)
        .where(eq(oauthRefreshTokens.jti, jti))
        .limit(1);
      return this.revokeFamily(fresh[0] ?? row, nowIso);
    }
    // REUSE: a consumed or revoked token was presented again — revoke the
    // family. (A revoked-but-unconsumed token takes this path too: rotation
    // of a dead token is a replay.)
    return this.revokeFamily(row, nowIso);
  }

  /**
   * Family revocation with exactly-once first-detection: the guarded update
   * (`revoked_at IS NULL`) ensures only the first concurrent detector gets
   * `firstDetection: true`; the rest still revoke (idempotent) but stay
   * silent. The caller alerts exactly once per family but audits every
   * attempt.
   */
  private async revokeFamily(
    row: typeof oauthRefreshTokens.$inferSelect,
    nowIso: string,
  ): Promise<RefreshConsumeOutcome> {
    const revoked = await this.db.root
      .update(oauthRefreshTokens)
      .set({ revokedAt: nowIso, retiredAt: nowIso })
      .where(and(eq(oauthRefreshTokens.familyId, row.familyId), isNull(oauthRefreshTokens.revokedAt)))
      .returning({ jti: oauthRefreshTokens.jti });
    return {
      status: 'reused',
      familyId: row.familyId,
      sessionId: row.sessionId,
      firstDetection: revoked.length > 0,
    };
  }

  /** Retire a single refresh-token row (the provider's token-destroy path). */
  async revoke(jti: string, nowIso: string): Promise<void> {
    await this.db.root
      .update(oauthRefreshTokens)
      .set({ revokedAt: nowIso })
      .where(eq(oauthRefreshTokens.jti, jti));
  }

  /** Retire every token of a grant (the grant-destroy cascade). */
  async revokeByGrantId(grantId: string, nowIso: string): Promise<void> {
    await this.db.root
      .update(oauthRefreshTokens)
      .set({ revokedAt: nowIso })
      .where(eq(oauthRefreshTokens.grantId, grantId));
  }

  /** Retire a set of tokens by jti (session revocation fans out here). */
  async revokeByJtis(jtis: string[], nowIso: string): Promise<void> {
    if (jtis.length === 0) {
      return;
    }
    await this.db.root
      .update(oauthRefreshTokens)
      .set({ revokedAt: nowIso })
      .where(inArray(oauthRefreshTokens.jti, jtis));
  }
}

function toRefreshTokenRow(row: typeof oauthRefreshTokens.$inferSelect): RefreshTokenRow {
  return {
    jti: row.jti,
    familyId: row.familyId,
    sessionId: row.sessionId,
    tokenHash: row.tokenHash,
    grantId: row.grantId,
    expiresAt: row.expiresAt,
    rotatedFrom: row.rotatedFrom,
    consumedAt: row.consumedAt,
    retiredAt: row.retiredAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  };
}
