/**
 * Share repository (P3) — the persistence port for conversation share links
 * (`ConversationsService` share operations).
 *
 * Each method owns its transaction. The public-share resolution is a
 * bypass-lane read scoped by token hash, never by tenant.
 */
import type { ConversationShare } from '../schema';

/** Redacted public-share projection (bypass read, scoped by token). */
export interface PublicShareResolution {
  title: string | null;
  created_at: string;
  messages: Array<{
    sequence: number;
    role: string;
    text: string;
    citations?: unknown;
    suggested_followups?: string[];
    pinned: boolean;
    created_at: string;
  }>;
}

export interface IShareRepository {
  /** Issue a share row; the token itself is service-generated. */
  createShare(input: {
    orgId: string;
    conversationId: string;
    /** Already hashed (sha256 hex) by the service. */
    tokenHash: string;
    /** Already computed by the service (ttl clamp), null = never expires. */
    expiresAt: string | null;
    actor: string;
  }): Promise<ConversationShare>;

  listShares(orgId: string, conversationId: string): Promise<ConversationShare[]>;

  revokeShare(input: {
    orgId: string;
    shareId: string;
    actor: string;
  }): Promise<ConversationShare>;

  /**
   * Bypass read scoped by token hash (never by tenant): share → conversation
   * → latest 200 non-superseded messages, redacted. Null when the share is
   * missing, revoked, expired, or the conversation is deleted.
   */
  resolvePublicShare(tokenHash: string): Promise<PublicShareResolution | null>;
}
