/**
 * MongoDB lane for `IIdentityLinkRepository` (P3) — the persistence port
 * for `account_identities` (federated social identities). The social-account
 * linking POLICY (subject-first, verified-email link, one-way binding)
 * stays in `SocialAccountService`; this port is the dumb store underneath
 * it.
 *
 * Behavioral truth: `src/modules/identity/social/social-account.service.ts`.
 */
import { randomUUID } from 'node:crypto';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { binUuid, toIdentityLink, uuidOf, type AccountIdentityMongoDoc } from './mongo-documents';
import type { IdentityLink, IIdentityLinkRepository } from './identity-link.repository';

export class MongoIdentityLinkRepository implements IIdentityLinkRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private links() {
    return this.mongo.root.collection<AccountIdentityMongoDoc>('account_identities');
  }

  async findAccountId(provider: string, subject: string): Promise<string | null> {
    const doc = await this.links().findOne({ provider, subject }, { projection: { account_id: 1 } });
    return doc ? uuidOf(doc.account_id) : null;
  }

  async touchLastUsed(provider: string, subject: string, email: string | null, nowIso: string): Promise<void> {
    // Mirrors the pg lane (and the original service statement): the stored
    // email is only refreshed when the profile carries one — a null email
    // must not clobber the previously linked address.
    const set: { last_used_at: string; email?: string | null } = { last_used_at: nowIso };
    if (email) {
      set.email = email;
    }
    await this.links().updateOne({ provider, subject }, { $set: set });
  }

  async link(accountId: string, provider: string, subject: string, email: string | null, nowIso: string): Promise<void> {
    await this.links().updateOne(
      { provider, subject },
      {
        // The (provider, subject) row stays bound to its original account —
        // account_id is insert-only (the pg lane's one-way binding rule);
        // a re-link only refreshes last-used and email.
        $set: { last_used_at: nowIso, email },
        $setOnInsert: { id: binUuid(randomUUID()), account_id: binUuid(accountId), linked_at: nowIso },
      },
      { upsert: true },
    );
  }

  async listByAccount(accountId: string): Promise<IdentityLink[]> {
    const docs = await this.links().find({ account_id: binUuid(accountId) }).toArray();
    return docs.map(toIdentityLink);
  }

  async findById(identityId: string): Promise<IdentityLink | null> {
    const doc = await this.links().findOne({ id: binUuid(identityId, 'identityId') });
    return doc ? toIdentityLink(doc) : null;
  }

  async deleteById(identityId: string): Promise<void> {
    await this.links().deleteOne({ id: binUuid(identityId, 'identityId') });
  }
}
