/**
 * PostgreSQL channel message-link repository (P3) — `channel_message_links`
 * + `message_receipts`.
 *
 * Mechanical move of the ingest/outbound link logic. Delivery is AT LEAST
 * ONCE with a claim-before-send anchor (unique on `message_id`).
 *
 * The cross-module `conversations`/`artifacts` reads keep the exact SQL the
 * current outbound consumer runs (documented seam on the interface).
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { uuidv7 } from '../../../common/ids/uuidv7';
import {
  channelAccounts,
  channelMessageLinks,
  messageReceipts,
  type ChannelAccount,
} from '../schema';
import type {
  IChannelMessageLinkRepository,
  OutboundBinding,
} from './channel-message-link.repository';

export class PgChannelMessageLinkRepository implements IChannelMessageLinkRepository {
  constructor(private readonly db: DbService) {}

  async recordInboundLink(input: {
    orgId: string;
    conversationId: string;
    messageId: string;
    accountId: string;
    platform: string;
    externalMessageId: string | null;
  }): Promise<void> {
    await this.db.withBypass((tx) =>
      tx
        .insert(channelMessageLinks)
        .values({
          id: uuidv7(),
          organizationId: input.orgId,
          conversationId: input.conversationId,
          messageId: input.messageId,
          channelAccountId: input.accountId,
          direction: 'inbound',
          platform: input.platform,
          externalMessageId: input.externalMessageId?.slice(0, 255) ?? null,
          deliveryState: 'sent',
        })
        .onConflictDoNothing(),
    );
  }

  async applyStatusEvent(input: {
    orgId: string;
    accountId: string;
    externalMessageId: string;
    status: string;
    providerError: { code: string; message: string | null } | null;
    occurredAtMs?: number;
  }): Promise<void> {
    // Tenant-scoped like the original handleStatus (withOrg) — the status
    // report resolves inside the account's org, never a bypass scan.
    await this.db.withOrg(input.orgId, async (tx) => {
      // Status reports attach to the outbound link for this account's message.
      // When there is no matching link the report is a no-op — the redrive
      // consumer still marks the event processed.
      const links = await tx
        .select()
        .from(channelMessageLinks)
        .where(
          and(
            eq(channelMessageLinks.channelAccountId, input.accountId),
            eq(channelMessageLinks.externalMessageId, input.externalMessageId),
          ),
        )
        .limit(1);
      const link = links[0];
      if (!link) {
        return;
      }
      await tx
        .update(channelMessageLinks)
        .set({
          deliveryState: input.status,
          providerError: input.providerError,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(channelMessageLinks.id, link.id));

      // Delivery/read receipts are OUTBOUND only (original handleStatus gates
      // on link.direction === 'outbound'). First platform report wins
      // (unique on message, account, state) — retries cannot rewrite history.
      if (link.direction === 'outbound' && (input.status === 'delivered' || input.status === 'read')) {
        await tx
          .insert(messageReceipts)
          .values({
            id: uuidv7(),
            organizationId: input.orgId,
            conversationId: link.conversationId,
            messageId: link.messageId,
            channelAccountId: link.channelAccountId,
            platform: link.platform,
            state: input.status,
            occurredAt: input.occurredAtMs ? new Date(input.occurredAtMs).toISOString() : new Date().toISOString(),
          })
          .onConflictDoNothing();
      }
    });
  }

  async claimOutboundLink(input: {
    orgId: string;
    conversationId: string;
    messageId: string;
    accountId: string;
    platform: string;
  }): Promise<{ claimed: boolean; existingState: string | null }> {
    // Atomic claim: insert-onConflictDoNothing is the race-safe anchor (the
    // original deliverMessage claim). A lost race returns the existing row's
    // state so the caller can apply the sent/delivered/read skip vs pending
    // re-send policy — never two concurrent sends from one claim.
    return this.db.withOrg(input.orgId, async (tx) => {
      const inserted = await tx
        .insert(channelMessageLinks)
        .values({
          id: uuidv7(),
          organizationId: input.orgId,
          conversationId: input.conversationId,
          messageId: input.messageId,
          channelAccountId: input.accountId,
          direction: 'outbound',
          platform: input.platform,
          deliveryState: 'pending',
        })
        .onConflictDoNothing()
        .returning({ id: channelMessageLinks.id });
      if (inserted.length > 0) {
        return { claimed: true, existingState: null };
      }
      const existing = await tx
        .select({ deliveryState: channelMessageLinks.deliveryState })
        .from(channelMessageLinks)
        .where(eq(channelMessageLinks.messageId, input.messageId))
        .limit(1);
      return { claimed: false, existingState: existing[0]?.deliveryState ?? null };
    });
  }

  async markLinkSent(
    orgId: string,
    messageId: string,
    externalMessageId: string | null,
  ): Promise<void> {
    await this.db.withOrg(orgId, (tx) =>
      tx
        .update(channelMessageLinks)
        .set({
          deliveryState: 'sent',
          externalMessageId: externalMessageId?.slice(0, 255) ?? null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(channelMessageLinks.messageId, messageId)),
    );
  }

  async markLinkState(
    orgId: string,
    messageId: string,
    state: 'skipped' | 'failed',
    reason: Record<string, unknown> | null,
  ): Promise<void> {
    await this.db.withOrg(orgId, (tx) =>
      tx
        .update(channelMessageLinks)
        .set({
          deliveryState: state,
          providerError: reason,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(channelMessageLinks.messageId, messageId)),
    );
  }

  async loadOutboundMessage(
    orgId: string,
    messageId: string,
  ): Promise<{ id: string; content: unknown } | null> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx.execute(sql`select id, content from messages where id = ${messageId}::uuid limit 1`),
    );
    const row = rows.rows[0] as { id: string; content: unknown } | undefined;
    return row ? { id: row.id, content: row.content } : null;
  }

  async loadOutboundBinding(
    orgId: string,
    conversationId: string,
  ): Promise<OutboundBinding | null> {
    return this.db.withOrg(orgId, async (tx) => {
      const convRows = await tx.execute(sql`
        select id, channel_binding from conversations
        where id = ${conversationId}::uuid
          and organization_id = ${orgId}::uuid
        limit 1
      `);
      const conv = convRows.rows[0] as
        | { id: string; channel_binding: unknown | null }
        | undefined;
      const binding = (conv?.channel_binding ?? null) as {
        platform?: string;
        channel_account_id?: string;
        channel_identity_id?: string;
      } | null;
      if (!conv || !binding || !binding.platform || !binding.channel_account_id) {
        return null;
      }
      const accountRows = await tx
        .select()
        .from(channelAccounts)
        .where(eq(channelAccounts.id, binding.channel_account_id))
        .limit(1);
      const account: ChannelAccount | undefined = accountRows[0];
      if (!account || account.status === 'suspended') {
        return null;
      }
      return { conversationId: conv.id, account, binding };
    });
  }

  async loadOutboundArtifact(
    orgId: string,
    artifactId: string,
  ): Promise<{ id: string; objectKey: string; state: string; purpose: string } | null> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx.execute(sql`
        select id, object_key, state, purpose from artifacts
        where id = ${artifactId}::uuid
          and organization_id = ${orgId}::uuid
          and deleted_at is null
        limit 1
      `),
    );
    const row = rows.rows[0] as
      | { id: string; object_key: string; state: string; purpose: string }
      | undefined;
    return row
      ? { id: row.id, objectKey: row.object_key, state: row.state, purpose: row.purpose }
      : null;
  }
}
