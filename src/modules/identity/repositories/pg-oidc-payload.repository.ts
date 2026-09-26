import { and, eq, sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { oidcPayloads } from '../schema';
import type {
  IOidcPayloadRepository,
  RefreshTokenPayloadView,
} from './oidc-payload.repository';

/**
 * PostgreSQL implementation of `IOidcPayloadRepository` (P3).
 *
 * Mechanical move of the `oidc_payloads` units from `OidcDrizzleAdapter`:
 * the generic oidc-provider payload store (composite key: model + id).
 * The full refresh-token payload is dual-written here;
 * `findRefreshPayload` exposes the security-relevant fields (`jti`,
 * `sessionUid`) without dragging the whole payload shape through every
 * caller.
 *
 * Identity tables are platform-plane / GLOBAL — no RLS, no tenant
 * dimension — so every method goes through `db.root`.
 */
export class PgOidcPayloadRepository implements IOidcPayloadRepository {
  constructor(private readonly db: DbService) {}

  async upsert(input: {
    model: string;
    id: string;
    payload: unknown;
    grantId: string | null;
    expiresAt: string | null;
  }): Promise<void> {
    await this.db.root
      .insert(oidcPayloads)
      .values({
        model: input.model,
        id: input.id,
        payload: input.payload,
        grantId: input.grantId,
        expiresAt: input.expiresAt,
      })
      .onConflictDoUpdate({
        target: [oidcPayloads.model, oidcPayloads.id],
        set: {
          payload: input.payload,
          grantId: input.grantId,
          expiresAt: input.expiresAt,
        },
      });
  }

  async find<T = unknown>(model: string, id: string): Promise<T | undefined> {
    const rows = await this.db.root
      .select()
      .from(oidcPayloads)
      .where(and(eq(oidcPayloads.model, model), eq(oidcPayloads.id, id)))
      .limit(1);
    return rows[0] ? (rows[0].payload as T) : undefined;
  }

  /**
   * Session lookup by stable uid (the v8 `is_session_bound` mixin path):
   * the uid lives inside the stored Session payload (`Session.uid`,
   * IN_PAYLOAD).
   */
  async findSessionByUid(uid: string): Promise<unknown | undefined> {
    const rows = await this.db.root
      .select()
      .from(oidcPayloads)
      .where(and(eq(oidcPayloads.model, 'Session'), sql`${oidcPayloads.payload}->>'uid' = ${uid}`))
      .limit(1);
    return rows[0] ? rows[0].payload : undefined;
  }

  /** The security-relevant refresh-token payload fields, or undefined. */
  async findRefreshPayload(jti: string): Promise<RefreshTokenPayloadView | undefined> {
    const rows = await this.db.root
      .select({ payload: oidcPayloads.payload })
      .from(oidcPayloads)
      .where(and(eq(oidcPayloads.model, 'RefreshToken'), eq(oidcPayloads.id, jti)))
      .limit(1);
    const payload = rows[0]?.payload as Record<string, unknown> | null | undefined;
    const payloadJti = payload?.['jti'];
    const sessionUid = payload?.['sessionUid'];
    if (typeof payloadJti === 'string' && typeof sessionUid === 'string') {
      return { jti: payloadJti, sessionUid };
    }
    return undefined;
  }

  /**
   * Ids of payloads of a model whose stored JSON field equals a value —
   * reads `payload->>field`. Used to fan session revocation out to refresh
   * tokens (`field = 'sessionUid'`).
   */
  async findIdsWherePayloadFieldEquals(
    model: string,
    field: string,
    value: string,
  ): Promise<string[]> {
    const rows = await this.db.root
      .select({ id: oidcPayloads.id })
      .from(oidcPayloads)
      .where(and(eq(oidcPayloads.model, model), sql`${oidcPayloads.payload}->>${field} = ${value}`));
    return rows.map((row) => row.id);
  }

  async consume(model: string, id: string, nowIso: string): Promise<void> {
    await this.db.root
      .update(oidcPayloads)
      .set({ consumedAt: nowIso })
      .where(and(eq(oidcPayloads.model, model), eq(oidcPayloads.id, id)));
  }

  async destroy(model: string, id: string): Promise<void> {
    await this.db.root
      .delete(oidcPayloads)
      .where(and(eq(oidcPayloads.model, model), eq(oidcPayloads.id, id)));
  }

  async deleteByGrantId(grantId: string): Promise<void> {
    await this.db.root.delete(oidcPayloads).where(eq(oidcPayloads.grantId, grantId));
  }
}
