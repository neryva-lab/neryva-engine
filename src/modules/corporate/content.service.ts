import { and, desc, eq } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { contentPosts } from './public.schema';
import { ContentPostDto } from './dto';

/**
 * Content admin (corporate E-3): staff-authored posts in Postgres; the
 * website renders statically and syncs from the public export feed at
 * build time (no server-side rendering coupling to the engine).
 *
 * Lifecycle: draft → published (published_at set once) → archived. Slugs
 * are immutable identity; republishing an archived post re-publishes the
 * same slug.
 */
@Injectable()
export class ContentService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  async list(includeDrafts: boolean): Promise<Array<typeof contentPosts.$inferSelect>> {
    const rows = await this.db.root
      .select()
      .from(contentPosts)
      .where(includeDrafts ? undefined : eq(contentPosts.status, 'published'))
      .orderBy(desc(contentPosts.publishedAt), desc(contentPosts.createdAt))
      .limit(500);
    return rows;
  }

  async upsert(dto: ContentPostDto, authorAccountId: string): Promise<typeof contentPosts.$inferSelect> {
    const tags = (dto.tags ?? '')
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0 && t.length <= 32)
      .slice(0, 12);
    const existing = await this.db.root.select().from(contentPosts).where(eq(contentPosts.slug, dto.slug)).limit(1);

    if (existing[0]) {
      const updated = await this.db.root
        .update(contentPosts)
        .set({ title: dto.title, summary: dto.summary ?? null, bodyMd: dto.body_md, tags, updatedAt: new Date().toISOString() })
        .where(eq(contentPosts.id, existing[0].id))
        .returning();
      await this.audit.add({
        action: 'content.post_updated',
        resourceType: 'content_post',
        resourceId: existing[0].id,
        actorType: 'account',
        actorId: authorAccountId,
        details: { slug: dto.slug },
      });
      return updated[0];
    }

    const inserted = await this.db.root
      .insert(contentPosts)
      .values({
        slug: dto.slug,
        title: dto.title,
        summary: dto.summary ?? null,
        bodyMd: dto.body_md,
        tags,
        authorAccount: authorAccountId,
      })
      .onConflictDoNothing({ target: contentPosts.slug })
      .returning();
    if (!inserted[0]) {
      throw ApiError.conflict('slug already exists');
    }
    await this.audit.add({
      action: 'content.post_created',
      resourceType: 'content_post',
      resourceId: inserted[0].id,
      actorType: 'account',
      actorId: authorAccountId,
      details: { slug: dto.slug },
    });
    return inserted[0];
  }

  async publish(slug: string, actorAccountId: string): Promise<void> {
    const rows = await this.db.root.select().from(contentPosts).where(eq(contentPosts.slug, slug)).limit(1);
    if (!rows[0]) {
      throw ApiError.notFound('post');
    }
    await this.db.root
      .update(contentPosts)
      .set({ status: 'published', publishedAt: rows[0].publishedAt ?? new Date().toISOString(), updatedAt: new Date().toISOString() })
      .where(eq(contentPosts.id, rows[0].id));
    await this.audit.add({
      action: 'content.post_published',
      resourceType: 'content_post',
      resourceId: rows[0].id,
      actorType: 'account',
      actorId: actorAccountId,
      details: { slug },
    });
  }

  async archive(slug: string, actorAccountId: string): Promise<void> {
    const rows = await this.db.root.select().from(contentPosts).where(eq(contentPosts.slug, slug)).limit(1);
    if (!rows[0]) {
      throw ApiError.notFound('post');
    }
    await this.db.root
      .update(contentPosts)
      .set({ status: 'archived', updatedAt: new Date().toISOString() })
      .where(eq(contentPosts.id, rows[0].id));
    await this.audit.add({
      action: 'content.post_archived',
      resourceType: 'content_post',
      resourceId: rows[0].id,
      actorType: 'account',
      actorId: actorAccountId,
      details: { slug },
    });
  }

  /** The website build feed: published posts only, markdown bodies. */
  async publishedFeed(): Promise<unknown> {
    const rows = await this.list(false);
    return {
      posts: rows.map((row) => ({
        slug: row.slug,
        title: row.title,
        summary: row.summary,
        body_md: row.bodyMd,
        tags: row.tags,
        published_at: row.publishedAt,
        updated_at: row.updatedAt,
      })),
    };
  }

  async publishedBySlug(slug: string): Promise<unknown | null> {
    const rows = await this.db.root
      .select()
      .from(contentPosts)
      .where(and(eq(contentPosts.slug, slug), eq(contentPosts.status, 'published')))
      .limit(1);
    if (!rows[0]) {
      return null;
    }
    const row = rows[0];
    return {
      slug: row.slug,
      title: row.title,
      summary: row.summary,
      body_md: row.bodyMd,
      tags: row.tags,
      published_at: row.publishedAt,
      updated_at: row.updatedAt,
    };
  }
}
