/**
 * PostgreSQL channel-account repository (P3) — `channel_accounts`.
 * Mechanical move of the `ChannelsService` account persistence.
 *
 * The (org, platform, display_name) unique violation is mapped to the
 * client-facing conflict here (the DB never returns raw 23505s).
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { ApiError } from '../../../common/http/api-error';
import { pgViolation } from '../../../common/infra/db/pg-types';
import {
  channelAccounts,
  channelSessions,
  type ChannelAccount,
  type ChannelConfig,
} from '../schema';
import type {
  CreateChannelAccountInput,
  IChannelAccountRepository,
  UpdateChannelAccountPatch,
} from './channel-account.repository';

/**
 * The DB never returns raw 23505s — an (org, platform, display_name)
 * collision is a client conflict the console can explain.
 */
function mapAccountUniqueViolation(err: unknown): never {
  if (pgViolation(err).code === '23505') {
    throw ApiError.conflict('a channel with this name already exists for this platform');
  }
  throw err as Error;
}

export class PgChannelAccountRepository implements IChannelAccountRepository {
  constructor(private readonly db: DbService) {}

  async createAccount(input: CreateChannelAccountInput): Promise<ChannelAccount> {
    try {
      return await this.db.withOrg(input.orgId, async (tx) => {
        const countRows = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(channelAccounts)
          .where(
            and(
              eq(channelAccounts.organizationId, input.orgId),
              sql`${channelAccounts.status} <> 'suspended'`,
            ),
          );
        if (Number(countRows[0]?.n ?? 0) >= input.cap) {
          throw ApiError.conflict(`channel account cap reached (${input.cap})`, { cap: input.cap });
        }
        const rows = await tx
          .insert(channelAccounts)
          .values({
            id: input.accountId,
            organizationId: input.orgId,
            platform: input.platform,
            displayName: input.displayName,
            publicKey: input.publicKey,
            credentialsSealed: input.credentialsSealed as never,
            verifyTokenSealed: input.verifyTokenSealed,
            config: input.config as never,
            status: 'pending',
            createdBy: input.createdBy,
          })
          .returning();
        return rows[0];
      });
    } catch (err) {
      mapAccountUniqueViolation(err);
    }
  }

  async getAccount(orgId: string, accountId: string): Promise<ChannelAccount | null> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx.select().from(channelAccounts).where(eq(channelAccounts.id, accountId)).limit(1),
    );
    return rows[0] ?? null;
  }

  async getAccountByIdForIngest(accountId: string): Promise<ChannelAccount | null> {
    const rows = await this.db.withBypass((tx) =>
      tx.select().from(channelAccounts).where(eq(channelAccounts.id, accountId)).limit(1),
    );
    return rows[0] ?? null;
  }

  async getAccountByPublicKey(publicKey: string): Promise<ChannelAccount | null> {
    const rows = await this.db.withBypass((tx) =>
      tx.select().from(channelAccounts).where(eq(channelAccounts.publicKey, publicKey)).limit(1),
    );
    return rows[0] ?? null;
  }

  async listAccounts(orgId: string): Promise<ChannelAccount[]> {
    return this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(channelAccounts)
        .where(eq(channelAccounts.organizationId, orgId))
        .orderBy(desc(channelAccounts.updatedAt))
        .limit(200),
    );
  }

  async updateAccount(
    orgId: string,
    accountId: string,
    patch: UpdateChannelAccountPatch,
  ): Promise<ChannelAccount> {
    let rows: ChannelAccount[];
    try {
      rows = await this.db.withOrg(orgId, (tx) =>
        tx
          .update(channelAccounts)
          .set({
            ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
            ...(patch.status !== undefined ? { status: patch.status } : {}),
            ...(patch.config !== undefined ? { config: patch.config as never } : {}),
            updatedAt: new Date().toISOString(),
          })
          .where(and(eq(channelAccounts.id, accountId), eq(channelAccounts.organizationId, orgId)))
          .returning(),
      );
    } catch (err) {
      mapAccountUniqueViolation(err);
    }
    if (rows.length === 0) {
      throw ApiError.notFound('channel account');
    }
    return rows[0];
  }

  async deactivateAccount(orgId: string, accountId: string): Promise<void> {
    await this.db.withOrg(orgId, async (tx) => {
      const rows = await tx
        .update(channelAccounts)
        .set({
          status: 'suspended',
          // Credentials are destroyed on deactivate — reconnect re-seals.
          credentialsSealed: {},
          verifyTokenSealed: null,
          updatedAt: new Date().toISOString(),
        })
        .where(and(eq(channelAccounts.id, accountId), eq(channelAccounts.organizationId, orgId)))
        .returning({ id: channelAccounts.id });
      if (rows.length === 0) {
        throw ApiError.notFound('channel account');
      }
      // Widget sessions die with the account.
      await tx
        .update(channelSessions)
        .set({ status: 'revoked', expiresAt: new Date().toISOString() })
        .where(eq(channelSessions.channelAccountId, accountId));
    });
  }

  async rotateCredentials(
    orgId: string,
    accountId: string,
    input: {
      credentialsSealed: Record<string, string>;
      verifyTokenSealed: string | null;
      reverify: boolean;
    },
  ): Promise<ChannelAccount> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .update(channelAccounts)
        .set({
          credentialsSealed: input.credentialsSealed as never,
          ...(input.verifyTokenSealed ? { verifyTokenSealed: input.verifyTokenSealed } : {}),
          ...(input.reverify ? { status: 'pending', health: { last_verified: null } } : {}),
          updatedAt: new Date().toISOString(),
        })
        .where(and(eq(channelAccounts.id, accountId), eq(channelAccounts.organizationId, orgId)))
        .returning(),
    );
    return rows[0];
  }

  async setHealth(
    orgId: string,
    accountId: string,
    input: { health: Record<string, unknown>; markActive: boolean },
  ): Promise<void> {
    await this.db.withOrg(orgId, (tx) =>
      tx
        .update(channelAccounts)
        .set({
          health: input.health as never,
          ...(input.markActive ? { status: 'active' } : {}),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(channelAccounts.id, accountId)),
    );
  }
}
