/**
 * PostgreSQL content repository (P3) — `content_posts` + `content_revisions`.
 * Mechanical move of the `ContentService` (+ `FeedsService` reads)
 * persistence. Corporate tables are global (non-tenant, no RLS) — every
 * method runs through `withBypass`, matching the original `db.root` usage.
 *
 * The `content_posts.slug` and `(post_id, version)` unique violations are
 * mapped to client-facing conflicts here (the DB never returns raw 23505s).
 */
import { and, desc, eq, isNotNull, lte, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DbService } from '../../../common/infra/db/db.service';
import { ApiError } from '../../../common/http/api-error';
import { pgViolation } from '../../../common/infra/db/pg-types';
import { contentPosts, contentRevisions } from '../public.schema';
import type {
  ContentPostRow,
  ContentRevisionRow,
  IContentRepository,
  UpsertContentPostInput,
} from './content.repository';

function mapContentViolation(err: unknown): never {
  if (pgViolation(err).code === '23505') {
    throw ApiError.conflict('slug already exists');
  }
  throw err as Error;
}

type ContentPostDrizzleRow = typeof contentPosts.$inferSelect;
type ContentRevisionDrizzleRow = typeof contentRevisions.$inferSelect;

function mapPostRow(row: ContentPostDrizzleRow): ContentPostRow {
  return {
    ...row,
    tags: row.tags as string[],
  };
}

function mapRevisionRow(row: ContentRevisionDrizzleRow): ContentRevisionRow {
  return {
    ...row,
    tags: row.tags as string[],
  };
}

export class PgContentRepository implements IContentRepository {
  constructor(private readonly db: DbService) {}

  async listPosts(includeDrafts: boolean): Promise<ContentPostRow[]> {
    const rows = await this.db.withBypass((tx) =>
      tx
        .select()
        .from(contentPosts)
        .where(includeDrafts ? undefined : eq(contentPosts.status, 'published'))
        .orderBy(desc(contentPosts.publishedAt), desc(contentPosts.createdAt))
        .limit(500),
    );
    return rows.map(mapPostRow);
  }

  async getPostBySlug(slug: string): Promise<ContentPostRow | null> {
    const rows = await this.db.withBypass((tx) =>
      tx.select().from(contentPosts).where(eq(contentPosts.slug, slug)).limit(1),
    );
    return rows[0] ? mapPostRow(rows[0]) : null;
  }

  async upsertPost(input: UpsertContentPostInput): Promise<{ row: ContentPostRow; version: number; created: boolean }> {
    try {
      return await this.db.withBypass(async (tx) => {
        const existing = await tx.select().from(contentPosts).where(eq(contentPosts.slug, input.dto.slug)).limit(1);
        if (existing[0]) {
          const version = await this.nextVersionTx(tx, existing[0].id);
          const updated = await tx
            .update(contentPosts)
            .set({
              title: input.dto.title,
              summary: input.dto.summary ?? null,
              bodyMd: input.dto.body_md,
              tags: input.tags,
              category: input.dto.category ?? existing[0].category,
              seoDescription: input.dto.seo_description ?? existing[0].seoDescription,
              coverImage: input.dto.cover_image ?? existing[0].coverImage,
              authorName: input.dto.author_name ?? existing[0].authorName,
              ...(input.dto.featured !== undefined ? { featured: input.dto.featured } : {}),
              updatedAt: new Date().toISOString(),
            })
            .where(eq(contentPosts.id, existing[0].id))
            .returning();
          await this.snapshotRevisionTx(tx, { post: mapPostRow(updated[0]), version, editorAccountId: input.authorAccountId });
          return { row: mapPostRow(updated[0]), version, created: false };
        }
        const inserted = await tx
          .insert(contentPosts)
          .values({
            slug: input.dto.slug,
            title: input.dto.title,
            summary: input.dto.summary ?? null,
            bodyMd: input.dto.body_md,
            tags: input.tags,
            category: input.dto.category ?? null,
            seoDescription: input.dto.seo_description ?? null,
            coverImage: input.dto.cover_image ?? null,
            authorName: input.dto.author_name ?? null,
            featured: input.dto.featured ?? false,
            authorAccount: input.authorAccountId,
          })
          .onConflictDoNothing({ target: contentPosts.slug })
          .returning();
        if (!inserted[0]) {
          throw ApiError.conflict('slug already exists');
        }
        await this.snapshotRevisionTx(tx, { post: mapPostRow(inserted[0]), version: 1, editorAccountId: input.authorAccountId });
        return { row: mapPostRow(inserted[0]), version: 1, created: true };
      });
    } catch (err) {
      mapContentViolation(err);
    }
  }

  /** Internal: compute next version within an existing transaction. */
  private async nextVersionTx(tx: NodePgDatabase, postId: string): Promise<number> {
    const rows = await tx
      .select({ max: sql<number>`coalesce(max(${contentRevisions.version}), 0)::int` })
      .from(contentRevisions)
      .where(eq(contentRevisions.postId, postId));
    return (rows[0]?.max ?? 0) + 1;
  }

  /** Internal: snapshot a revision within an existing transaction. */
  private async snapshotRevisionTx(
    tx: NodePgDatabase,
    input: { post: ContentPostRow; version: number; editorAccountId: string },
  ): Promise<void> {
    await tx
      .insert(contentRevisions)
      .values({
        postId: input.post.id,
        version: input.version,
        title: input.post.title,
        summary: input.post.summary,
        bodyMd: input.post.bodyMd,
        tags: input.post.tags,
        editorAccount: input.editorAccountId,
      })
      .onConflictDoNothing({ target: [contentRevisions.postId, contentRevisions.version] });
  }

  async nextVersion(postId: string): Promise<number> {
    return this.db.withBypass((tx) => this.nextVersionTx(tx, postId));
  }

  async snapshotRevision(input: { post: ContentPostRow; version: number; editorAccountId: string }): Promise<void> {
    await this.db.withBypass((tx) => this.snapshotRevisionTx(tx, input));
  }

  async publishPost(input: { postId: string; currentPublishedAt: string | null; currentPublishAt: string | null }): Promise<void> {
    const nowIso = new Date().toISOString();
    await this.db.withBypass((tx) =>
      tx
        .update(contentPosts)
        .set({
          status: 'published',
          publishedAt: input.currentPublishedAt ?? nowIso,
          publishAt: input.currentPublishAt && input.currentPublishAt > nowIso ? input.currentPublishAt : null,
          updatedAt: nowIso,
        })
        .where(eq(contentPosts.id, input.postId)),
    );
  }

  async schedulePost(input: { postId: string; publishAtIso: string }): Promise<void> {
    await this.db.withBypass((tx) =>
      tx
        .update(contentPosts)
        .set({ publishAt: input.publishAtIso, updatedAt: new Date().toISOString() })
        .where(eq(contentPosts.id, input.postId)),
    );
  }

  async archivePost(postId: string): Promise<void> {
    await this.db.withBypass((tx) =>
      tx
        .update(contentPosts)
        .set({ status: 'archived', publishAt: null, updatedAt: new Date().toISOString() })
        .where(eq(contentPosts.id, postId)),
    );
  }

  async unpublishPost(postId: string): Promise<void> {
    await this.db.withBypass((tx) =>
      tx
        .update(contentPosts)
        .set({ status: 'draft', publishAt: null, updatedAt: new Date().toISOString() })
        .where(eq(contentPosts.id, postId)),
    );
  }

  async listRevisions(postId: string): Promise<ContentRevisionRow[]> {
    const rows = await this.db.withBypass((tx) =>
      tx
        .select()
        .from(contentRevisions)
        .where(eq(contentRevisions.postId, postId))
        .orderBy(desc(contentRevisions.version))
        .limit(100),
    );
    return rows.map(mapRevisionRow);
  }

  async getRevision(postId: string, version: number): Promise<ContentRevisionRow | null> {
    const rows = await this.db.withBypass((tx) =>
      tx
        .select()
        .from(contentRevisions)
        .where(and(eq(contentRevisions.postId, postId), eq(contentRevisions.version, version)))
        .limit(1),
    );
    return rows[0] ? mapRevisionRow(rows[0]) : null;
  }

  async restoreRevision(input: { postId: string; revision: ContentRevisionRow; editorAccountId: string }): Promise<number> {
    return this.db.withBypass(async (tx) => {
      const next = await this.nextVersionTx(tx, input.postId);
      const updated = await tx
        .update(contentPosts)
        .set({
          title: input.revision.title,
          summary: input.revision.summary,
          bodyMd: input.revision.bodyMd,
          tags: input.revision.tags,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(contentPosts.id, input.postId))
        .returning();
      await this.snapshotRevisionTx(tx, { post: mapPostRow(updated[0]), version: next, editorAccountId: input.editorAccountId });
      return next;
    });
  }

  async publishDue(): Promise<Array<{ id: string; slug: string }>> {
    return this.db.withBypass((tx) =>
      tx
        .update(contentPosts)
        .set({
          status: 'published',
          publishedAt: sql`coalesce(${contentPosts.publishedAt}, now())`,
          publishAt: null,
          updatedAt: new Date().toISOString(),
        })
        .where(
          and(
            eq(contentPosts.status, 'draft'),
            isNotNull(contentPosts.publishAt),
            lte(contentPosts.publishAt, new Date().toISOString()),
          ),
        )
        .returning({ id: contentPosts.id, slug: contentPosts.slug }),
    );
  }

  async getPublishedBySlug(slug: string): Promise<ContentPostRow | null> {
    const rows = await this.db.withBypass((tx) =>
      tx
        .select()
        .from(contentPosts)
        .where(and(eq(contentPosts.slug, slug), eq(contentPosts.status, 'published')))
        .limit(1),
    );
    return rows[0] ? mapPostRow(rows[0]) : null;
  }

  async listPublished(limit: number): Promise<ContentPostRow[]> {
    const rows = await this.db.withBypass((tx) =>
      tx
        .select()
        .from(contentPosts)
        .where(eq(contentPosts.status, 'published'))
        .orderBy(desc(contentPosts.publishedAt))
        .limit(Math.min(limit, 100)),
    );
    return rows.map(mapPostRow);
  }

  async recentPublishedPosts(limit: number): Promise<Array<Pick<ContentPostRow, 'slug' | 'title' | 'summary' | 'category' | 'authorName' | 'publishedAt' | 'updatedAt'>>> {
    return this.db.withBypass((tx) =>
      tx
        .select({
          slug: contentPosts.slug,
          title: contentPosts.title,
          summary: contentPosts.summary,
          category: contentPosts.category,
          authorName: contentPosts.authorName,
          publishedAt: contentPosts.publishedAt,
          updatedAt: contentPosts.updatedAt,
        })
        .from(contentPosts)
        .where(eq(contentPosts.status, 'published'))
        .orderBy(desc(contentPosts.publishedAt))
        .limit(limit),
    );
  }

  async sitemapPosts(limit: number): Promise<Array<Pick<ContentPostRow, 'slug' | 'updatedAt'>>> {
    return this.db.withBypass((tx) =>
      tx
        .select({ slug: contentPosts.slug, updatedAt: contentPosts.updatedAt })
        .from(contentPosts)
        .where(eq(contentPosts.status, 'published'))
        .orderBy(desc(contentPosts.publishedAt))
        .limit(limit),
    );
  }
}
