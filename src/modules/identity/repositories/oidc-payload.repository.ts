/**
 * `IOidcPayloadRepository` — the persistence port for `oidc_payloads`, the
 * generic oidc-provider payload store (composite key: model + id).
 *
 * The full refresh-token payload is dual-written here; `findRefreshPayload`
 * exposes the security-relevant fields (`jti`, `sessionUid`) the adapter
 * needs without dragging the whole payload shape through every caller.
 *
 * Behavioral truth: `src/modules/identity/oidc/oidc-adapter.ts`.
 */
export interface RefreshTokenPayloadView {
  jti: string;
  sessionUid: string;
}

export interface IOidcPayloadRepository {
  upsert(input: { model: string; id: string; payload: unknown; grantId: string | null; expiresAt: string | null }): Promise<void>;
  find<T = unknown>(model: string, id: string): Promise<T | undefined>;
  findSessionByUid(uid: string): Promise<unknown | undefined>;
  findRefreshPayload(jti: string): Promise<RefreshTokenPayloadView | undefined>;
  /**
   * Ids of payloads of a model whose stored JSON field equals a value —
   * the pg lane reads `payload->>'field'`. Used to fan session revocation
   * out to refresh tokens (`field = 'sessionUid'`).
   */
  findIdsWherePayloadFieldEquals(model: string, field: string, value: string): Promise<string[]>;
  consume(model: string, id: string, nowIso: string): Promise<void>;
  destroy(model: string, id: string): Promise<void>;
  deleteByGrantId(grantId: string): Promise<void>;
}
