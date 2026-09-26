import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { ApiError } from '../../../common/http/api-error';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { conversations, conversationShares, messages } from '../schema';
import type { ConversationShare } from '../schema';
import type { IShareRepository, PublicShareResolution } from './share.repository';

/**
 * PostgreSQL implementation of `IShareRepository` (P3).
 *
 * Mechanical move of the `ConversationsService` share units: each method
 * owns its transaction via `DbService.withOrg` (tenant-lane), except
 * `resolvePublicShare`, which reads the bypass lane scoped by token hash,
 * never by tenant.
 *
 * What stays OUT (still the caller's job): input validation, the raw token
 * generation + sha256 (the caller passes the precomputed `tokenHash`) and
 * TTL clamp (the caller passes the computed `expiresAt`), tracing spans, and
 * audit writes (replayed by the service from inputs + results).
 */
export class PgShareRepository implements IShareRepository {
  constructor(private readonly db: DbService) {}

  /** Issue a share row; the token itself is service-generated. */
  async createShare(input: {
    orgId: string;
    conversationId: string;
    /** Already hashed (sha256 hex) by the service. */
    tokenHash: string;
    /** Already computed by the service (ttl clamp), null = never expires. */
    expiresAt: string | null;
    actor: string;
  }): Promise<ConversationShare> {
    return this.db.withOrg(input.orgId, async (tx) => {
      const conv = await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.id, input.conversationId))
        .limit(1);
      if (conv.length === 0) {
        throw ApiError.notFound('conversation');
      }
      const rows = await tx
        .insert(conversationShares)
        .values({
          id: uuidv7(),
          organizationId: input.orgId,
          conversationId: input.conversationId,
          tokenHash: input.tokenHash,
          createdBy: input.actor.slice(0, 128),
          expiresAt: input.expiresAt,
        })
        .returning();
      return rows[0];
    });
  }

  async listShares(orgId: string, conversationId: string): Promise<ConversationShare[]> {
    return this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(conversationShares)
        .where(
          and(
            eq(conversationShares.organizationId, orgId),
            eq(conversationShares.conversationId, conversationId),
          ),
        )
        .orderBy(desc(conversationShares.createdAt))
        .limit(100),
    );
  }

  async revokeShare(input: {
    orgId: string;
    shareId: string;
    actor: string;
  }): Promise<ConversationShare> {
    return this.db.withOrg(input.orgId, async (tx) => {
      const rows = await tx
        .update(conversationShares)
        .set({ revokedAt: new Date().toISOString() })
        .where(
          and(
            eq(conversationShares.id, input.shareId),
            eq(conversationShares.organizationId, input.orgId),
            isNull(conversationShares.revokedAt),
          ),
        )
        .returning();
      if (rows.length === 0) {
        throw ApiError.notFound('share');
      }
      return rows[0];
    });
  }

  /**
   * Token-only public resolution (no tenant context — the token IS the
   * credential). Serves a REDACTED projection: role/sequence/time, text,
   * citations and follow-ups only. Channel bindings, participants, artifact
   * refs and internal ids never leave the system. Expired/revoked shares
   * resolve to null and the caller renders a plain 404.
   */
  async resolvePublicShare(tokenHash: string): Promise<PublicShareResolution | null> {
    return this.db.withBypass(async (tx) => {
      const shareRows = await tx
        .select()
        .from(conversationShares)
        .where(
          and(eq(conversationShares.tokenHash, tokenHash), isNull(conversationShares.revokedAt)),
        )
        .limit(1);
      const share = shareRows[0];
      if (!share || (share.expiresAt !== null && Date.parse(share.expiresAt) <= Date.now())) {
        return null;
      }
      const convRows = await tx
        .select()
        .from(conversations)
        .where(eq(conversations.id, share.conversationId))
        .limit(1);
      const conversation = convRows[0];
      if (!conversation || conversation.status === 'deleted') {
        return null;
      }
      const msgRows = await tx
        .select()
        .from(messages)
        .where(and(eq(messages.conversationId, conversation.id), isNull(messages.supersededBy)))
        .orderBy(asc(messages.sequence))
        .limit(200);
      return {
        title: conversation.title,
        created_at: conversation.createdAt,
        messages: msgRows.map((m) => {
          const content = (m.content ?? {}) as {
            text?: unknown;
            citations?: unknown;
            suggested_followups?: unknown;
          };
          return {
            sequence: m.sequence,
            role: m.role,
            text: typeof content.text === 'string' ? content.text.slice(0, 16_000) : '',
            ...(content.citations !== undefined ? { citations: content.citations } : {}),
            ...(Array.isArray(content.suggested_followups)
              ? { suggested_followups: content.suggested_followups.map(String).slice(0, 4) }
              : {}),
            pinned: m.pinnedAt !== null,
            created_at: m.createdAt,
          };
        }),
      };
    });
  }
}
