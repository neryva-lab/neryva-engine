/**
 * MongoDB lane for `IOidcPayloadRepository` (P3) — the persistence port for
 * `oidc_payloads`, the generic oidc-provider payload store (composite key:
 * model + id).
 *
 * The full refresh-token payload is dual-written here; `findRefreshPayload`
 * exposes the security-relevant fields (`jti`, `sessionUid`) the adapter
 * needs without dragging the whole payload shape through every caller.
 *
 * Behavioral truth: `src/modules/identity/oidc/oidc-adapter.ts`.
 */
import type { Filter } from 'mongodb';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { refreshPayloadView, type OidcPayloadMongoDoc } from './mongo-documents';
import type { IOidcPayloadRepository, RefreshTokenPayloadView } from './oidc-payload.repository';

export class MongoOidcPayloadRepository implements IOidcPayloadRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private payloads() {
    return this.mongo.root.collection<OidcPayloadMongoDoc>('oidc_payloads');
  }

  async upsert(input: {
    model: string;
    id: string;
    payload: unknown;
    grantId: string | null;
    expiresAt: string | null;
  }): Promise<void> {
    // The pg onConflictDoUpdate sets payload + grant_id + expires_at on
    // conflict; created_at is NOT NULL DEFAULT now() in pg, so the mongo
    // lane stamps it on insert. consumed_at is insert-only (null until
    // consumed).
    await this.payloads().updateOne(
      { model: input.model, id: input.id },
      {
        $set: { payload: input.payload, grant_id: input.grantId, expires_at: input.expiresAt },
        $setOnInsert: { created_at: new Date().toISOString(), consumed_at: null },
      },
      { upsert: true },
    );
  }

  async find<T = unknown>(model: string, id: string): Promise<T | undefined> {
    const doc = await this.payloads().findOne({ model, id });
    return doc ? (doc.payload as T) : undefined;
  }

  async findSessionByUid(uid: string): Promise<unknown | undefined> {
    const doc = await this.payloads().findOne({ model: 'Session', 'payload.uid': uid } as Filter<OidcPayloadMongoDoc>);
    return doc?.payload;
  }

  async findRefreshPayload(jti: string): Promise<RefreshTokenPayloadView | undefined> {
    const doc = await this.payloads().findOne({ model: 'RefreshToken', id: jti });
    return doc ? refreshPayloadView(doc.payload) : undefined;
  }

  async findIdsWherePayloadFieldEquals(model: string, field: string, value: string): Promise<string[]> {
    // The pg lane reads payload->>'field'; the mongo equivalent is the
    // dotted payload path.
    const docs = await this.payloads()
      .find({ model, [`payload.${field}`]: value } as Filter<OidcPayloadMongoDoc>, { projection: { id: 1 } })
      .toArray();
    return docs.map((d) => d.id);
  }

  async consume(model: string, id: string, nowIso: string): Promise<void> {
    await this.payloads().updateOne({ model, id }, { $set: { consumed_at: nowIso } });
  }

  async destroy(model: string, id: string): Promise<void> {
    await this.payloads().deleteOne({ model, id });
  }

  async deleteByGrantId(grantId: string): Promise<void> {
    await this.payloads().deleteMany({ grant_id: grantId });
  }
}
