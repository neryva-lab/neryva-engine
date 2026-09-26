/**
 * PostgreSQL channel-identity repository (P3) — `channel_identities`.
 * Mechanical move of the ingest identity upsert + identity-scoped reads.
 *
 * The cross-module `conversations` reads keep the exact SQL the current
 * ingest/widget code runs (documented seam on the interface).
 */
import { and, eq, sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { channelIdentities } from '../schema';
import type { IChannelIdentityRepository } from './channel-identity.repository';

export class PgChannelIdentityRepository implements IChannelIdentityRepository {
  constructor(private readonly db: DbService) {}

  async upsertInboundIdentity(input: {
    orgId: string;
    accountId: string;
    platform: string;
    externalUserId: string;
    displayName: string | null;
    locale: string | null;
    hasWindow: boolean;
  }): Promise<string> {
    return this.db.withBypass(async (tx) => {
      const now = new Date().toISOString();
      const windowExpires = input.hasWindow
        ? new Date(Date.now() + 24 * 3600 * 1000).toISOString()
        : null;
      await tx
        .insert(channelIdentities)
        .values({
          id: uuidv7(),
          organizationId: input.orgId,
          channelAccountId: input.accountId,
          platform: input.platform,
          externalUserId: input.externalUserId.slice(0, 255),
          displayName: input.displayName?.slice(0, 255) ?? null,
          locale: input.locale?.slice(0, 32) ?? null,
          lastInboundAt: now,
          windowExpiresAt: windowExpires,
        })
        .onConflictDoUpdate({
          target: [channelIdentities.channelAccountId, channelIdentities.externalUserId],
          set: { lastInboundAt: now, windowExpiresAt: windowExpires, updatedAt: now },
        });
      const identityRows = await tx
        .select({ id: channelIdentities.id })
        .from(channelIdentities)
        .where(
          and(
            eq(channelIdentities.channelAccountId, input.accountId),
            eq(channelIdentities.externalUserId, input.externalUserId.slice(0, 255)),
          ),
        )
        .limit(1);
      const identityId = identityRows[0]?.id;
      if (!identityId) {
        throw new Error('channel identity vanished after upsert');
      }
      return identityId;
    });
  }

  async findActiveConversationIdByIdentity(
    orgId: string,
    identityId: string,
  ): Promise<string | null> {
    return this.db.withBypass(async (tx) => {
      const convRows = await tx.execute(sql`
        select id from conversations
        where organization_id = ${orgId}::uuid
          and channel_binding->>'channel_identity_id' = ${identityId}
          and status = 'active'
        order by updated_at desc
        limit 1
      `);
      return (convRows.rows[0] as { id: string } | undefined)?.id ?? null;
    });
  }

  async getIdentityWindow(
    orgId: string,
    identityId: string,
  ): Promise<{ windowExpiresAt: string | null } | null> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({ windowExpiresAt: channelIdentities.windowExpiresAt })
        .from(channelIdentities)
        .where(eq(channelIdentities.id, identityId))
        .limit(1),
    );
    return rows[0] ?? null;
  }

  async externalUserIdFor(orgId: string, identityId: string): Promise<string | null> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({ externalUserId: channelIdentities.externalUserId })
        .from(channelIdentities)
        .where(eq(channelIdentities.id, identityId))
        .limit(1),
    );
    return rows[0]?.externalUserId ?? null;
  }
}
