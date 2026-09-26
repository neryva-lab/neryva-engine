/**
 * PostgreSQL channel-session repository (P3) — `channel_sessions` +
 * `channel_identities` for the website widget plane, plus the widget-flow
 * reads against the conversation plane.
 *
 * Mechanical move of `WidgetService`'s persistence:
 * - `mintSession`: identity + session insert in ONE bypass TX.
 * - `findSessionByTokenHash`: raw row read; the service applies the
 *   active/expiry checks so the 401 reasons stay byte-identical.
 * - `touchSession`: the sliding-TTL write (conditional in the caller).
 * - `bindSessionConversation`: the bypass conversation-binding write.
 * - `getConversationStatus` / `getRunConversationId`: withOrg raw-SQL
 *   reads, exactly as the service ran them inline.
 * - `markRecentAssistantMessagesRead`: the FL-3.19 read-marker upsert loop.
 */
import { and, eq, sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { uuidv7 } from '../../../common/ids/uuidv7';
import {
  channelIdentities,
  channelSessions,
  messageReceipts,
  type ChannelSession,
} from '../schema';
import type { IChannelSessionRepository } from './channel-session.repository';

export class PgChannelSessionRepository implements IChannelSessionRepository {
  constructor(private readonly db: DbService) {}

  async mintSession(input: {
    orgId: string;
    accountId: string;
    sessionId: string;
    identityId: string;
    visitorRef: string;
    tokenHash: string;
    expiresAt: string;
    ipHash: string | null;
    userAgentHash: string | null;
  }): Promise<void> {
    const now = new Date().toISOString();
    await this.db.withBypass(async (tx) => {
      await tx.insert(channelIdentities).values({
        id: input.identityId,
        organizationId: input.orgId,
        channelAccountId: input.accountId,
        platform: 'web',
        externalUserId: input.visitorRef,
        displayName: null,
        locale: null,
        lastInboundAt: now,
        windowExpiresAt: null, // no Meta window on web
      });
      await tx.insert(channelSessions).values({
        id: input.sessionId,
        organizationId: input.orgId,
        channelAccountId: input.accountId,
        identityId: input.identityId,
        tokenHash: input.tokenHash,
        status: 'active',
        expiresAt: input.expiresAt,
        createdIpHash: input.ipHash,
        userAgentHash: input.userAgentHash,
      });
    });
  }

  async findSessionByTokenHash(
    accountId: string,
    tokenHash: string,
  ): Promise<ChannelSession | null> {
    const rows = await this.db.withBypass((tx) =>
      tx
        .select()
        .from(channelSessions)
        .where(
          and(
            eq(channelSessions.tokenHash, tokenHash),
            eq(channelSessions.channelAccountId, accountId),
          ),
        )
        .limit(1),
    );
    return rows[0] ?? null;
  }

  async touchSession(sessionId: string, expiresAt: string, lastActiveAt: string): Promise<void> {
    await this.db.withBypass((tx) =>
      tx
        .update(channelSessions)
        .set({ expiresAt, lastActiveAt })
        .where(eq(channelSessions.id, sessionId)),
    );
  }

  async bindSessionConversation(
    orgId: string,
    sessionId: string,
    conversationId: string,
  ): Promise<void> {
    await this.db.withBypass((tx) =>
      tx
        .update(channelSessions)
        .set({ conversationId })
        .where(
          and(
            eq(channelSessions.id, sessionId),
            eq(channelSessions.organizationId, orgId),
          ),
        ),
    );
  }

  async getConversationStatus(orgId: string, conversationId: string): Promise<string | null> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx.execute(
        sql`select status from conversations where id = ${conversationId}::uuid and organization_id = ${orgId}::uuid limit 1`,
      ),
    );
    return ((rows.rows[0] as { status: string } | undefined)?.status ?? null) as string | null;
  }

  async getRunConversationId(orgId: string, runId: string): Promise<string | null> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx.execute(
        sql`select conversation_id from runs where id = ${runId}::uuid and organization_id = ${orgId}::uuid limit 1`,
      ),
    );
    return (
      ((rows.rows[0] as { conversation_id: string } | undefined)?.conversation_id ?? null) as
        | string
        | null
    );
  }

  async markRecentAssistantMessagesRead(input: {
    orgId: string;
    conversationId: string;
    accountId: string;
  }): Promise<number> {
    return this.db.withOrg(input.orgId, async (tx) => {
      const rows = await tx.execute(sql`
        select id from messages
        where conversation_id = ${input.conversationId}::uuid
          and organization_id = ${input.orgId}::uuid
          and role = 'assistant'
          and superseded_by is null
        order by sequence desc
        limit 50
      `);
      let added = 0;
      for (const row of rows.rows as Array<{ id: string }>) {
        const inserted = await tx
          .insert(messageReceipts)
          .values({
            id: uuidv7(),
            organizationId: input.orgId,
            conversationId: input.conversationId,
            messageId: row.id,
            channelAccountId: input.accountId,
            platform: 'web',
            state: 'read',
            occurredAt: new Date().toISOString(),
          })
          .onConflictDoNothing()
          .returning({ id: messageReceipts.id });
        added += inserted.length;
      }
      return added;
    });
  }
}
