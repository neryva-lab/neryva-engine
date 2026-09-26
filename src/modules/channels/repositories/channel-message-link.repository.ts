/**
 * Channel message-link repository (P3) — the persistence port for
 * `channel_message_links` (inbound dedup anchors + outbound claim-before-send
 * anchors) and `message_receipts` (delivery/read receipts).
 *
 * Each method owns its transaction. No transaction handle or callback leaks
 * through this interface — callers get plain domain results.
 *
 * Delivery contract (mechanical move of the outbound service): delivery is
 * AT LEAST ONCE with a claim-before-send anchor (unique on `message_id`).
 * `claimOutboundLink` is the send boundary — a lost race returns
 * `claimed: false` with the existing state; a link already durably
 * `sent`/`delivered`/`read` never re-sends, while a `pending` link from a
 * crashed twin re-sends (at-least-once, preserved across the split from the
 * service's former single outer transaction — the provider send always ran
 * outside any commit boundary anyway).
 *
 * Tenant discipline: every method takes the organization id explicitly. The
 * PostgreSQL implementation applies it via `DbService.withOrg` (RLS); the
 * MongoDB implementation applies it as an explicit `organization_id`
 * predicate on every tenant collection access.
 *
 * CROSS-MODULE READ SEAM (documented, not hidden): `loadOutboundMessage`,
 * `loadOutboundBinding`, and `loadOutboundArtifact` read the conversations
 * plane (`messages`, `conversations.channel_binding`) and the knowledge
 * plane (`artifacts`) — the same queries the current outbound consumer runs
 * inline. Both lanes keep the reads inside this port so the service never
 * touches another module's tables directly.
 */
import type { ChannelAccount } from '../schema';

export interface OutboundBinding {
  conversationId: string;
  account: ChannelAccount;
  binding: {
    platform?: string;
    channel_account_id?: string;
    channel_identity_id?: string;
  };
}

export interface IChannelMessageLinkRepository {
  /**
   * Inbound dedup anchor: one row per (account, external message id).
   * `onConflictDoNothing` — redelivered inbound messages add nothing.
   */
  recordInboundLink(input: {
    orgId: string;
    conversationId: string;
    messageId: string;
    accountId: string;
    platform: string;
    externalMessageId: string | null;
  }): Promise<void>;

  /**
   * Status-event write-back: update the link's delivery state + provider
   * error, and upsert a `message_receipts` row for OUTBOUND delivered/read
   * reports (first platform report wins, per the unique
   * (message, account, state) key) — all in one transaction.
   */
  applyStatusEvent(input: {
    orgId: string;
    accountId: string;
    externalMessageId: string;
    status: string;
    providerError: { code: string; message: string | null } | null;
    occurredAtMs?: number;
  }): Promise<void>;

  /**
   * Claim-before-send: insert the outbound link anchor. When the anchor
   * already exists, `claimed` is false and `existingState` carries the
   * current delivery state (`sent`/`delivered`/`read` → never re-send;
   * `pending`/`skipped`/`failed` → the service decides the retry policy).
   */
  claimOutboundLink(input: {
    orgId: string;
    conversationId: string;
    messageId: string;
    accountId: string;
    platform: string;
  }): Promise<{ claimed: boolean; existingState: string | null }>;

  /** Durable sent update after a provider ack. */
  markLinkSent(orgId: string, messageId: string, externalMessageId: string | null): Promise<void>;

  /**
   * Terminal non-delivery update (`skipped` / `failed`). Own transaction —
   * mirrors the current `markLink`, which already commits separately from
   * the claim unit.
   */
  markLinkState(
    orgId: string,
    messageId: string,
    state: 'skipped' | 'failed',
    reason: Record<string, unknown> | null,
  ): Promise<void>;

  /** Outbound message content read (conversations plane). */
  loadOutboundMessage(
    orgId: string,
    messageId: string,
  ): Promise<{ id: string; content: unknown } | null>;

  /**
   * Outbound binding read: conversation + channel account. Null when the
   * conversation is missing, has no channel binding (console-originated),
   * or the account is missing/suspended.
   */
  loadOutboundBinding(orgId: string, conversationId: string): Promise<OutboundBinding | null>;

  /** GENERATED_MEDIA artifact read for the media-delivery path. */
  loadOutboundArtifact(
    orgId: string,
    artifactId: string,
  ): Promise<{ id: string; objectKey: string; state: string; purpose: string } | null>;
}
