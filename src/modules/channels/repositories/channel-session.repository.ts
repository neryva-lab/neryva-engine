/**
 * Channel-session repository (P3) — the persistence port for the website
 * widget plane: `channel_sessions` (hash-at-rest session tokens) plus the
 * widget-flow reads against the conversation plane.
 *
 * Each method owns its transaction. No transaction handle or callback leaks
 * through this interface — callers get plain domain results.
 *
 * Tenant discipline: session lifecycle writes run under `db.withBypass`
 * (the widget plane is anonymous by design — the token hash IS the
 * capability), with the org traveling explicitly in the rows, mirroring the
 * pg lane exactly. The MongoDB implementation applies the same explicit
 * `organization_id` scoping.
 *
 * CROSS-MODULE READ SEAM (documented, not hidden): `getConversationStatus`,
 * `getRunConversationId`, and `markRecentAssistantMessagesRead` read the
 * conversations plane (`conversations`, `runs`, `messages`) — the same
 * queries the current widget service runs inline. Both lanes keep the reads
 * inside this port so the service never touches another module's tables
 * directly.
 *
 * Row types are imported as *types only* from the module schema — the
 * interface carries no drizzle runtime dependency.
 */
import type { ChannelSession } from '../schema';

export interface IChannelSessionRepository {
  /**
   * Mint a widget session: insert the visitor identity row + the session
   * row in ONE bypass transaction. Only the token HASH is stored — the raw
   * token never touches the DB.
   */
  mintSession(input: {
    orgId: string;
    accountId: string;
    sessionId: string;
    identityId: string;
    visitorRef: string;
    tokenHash: string;
    expiresAt: string;
    ipHash: string | null;
    userAgentHash: string | null;
  }): Promise<void>;

  /**
   * Resolve a session by (account, token hash) — bypass read. Returns the
   * raw row (or null); the service applies the active/expiry checks so the
   * 401 reasons stay byte-identical.
   */
  findSessionByTokenHash(accountId: string, tokenHash: string): Promise<ChannelSession | null>;

  /** Sliding-TTL touch (bypass write). */
  touchSession(sessionId: string, expiresAt: string, lastActiveAt: string): Promise<void>;

  /** Bind the session's single conversation (bypass write). */
  bindSessionConversation(orgId: string, sessionId: string, conversationId: string): Promise<void>;

  /** Conversation status read for the archived-conversation check. */
  getConversationStatus(orgId: string, conversationId: string): Promise<string | null>;

  /** The conversation a run belongs to (stream authorization). */
  getRunConversationId(orgId: string, runId: string): Promise<string | null>;

  /**
   * Mark the session conversation's recent (≤50) non-superseded assistant
   * messages as `read` (upsert per (message, account, state); first report
   * wins). Returns the number of rows this call added.
   */
  markRecentAssistantMessagesRead(input: {
    orgId: string;
    conversationId: string;
    accountId: string;
  }): Promise<number>;
}
