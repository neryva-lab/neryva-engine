import { and, desc, eq, isNotNull, lte, sql } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { env } from '../../common/config/env';
import { contentPosts, contentRevisions } from './public.schema';
import { ContentPostDto } from './dto';

/**
 * Content admin v2 (E-3 to production grade): a real CMS discipline —
 * immutable REVISIONS on every save with restore; scheduled publishing
 * (publish_at + the worker); SEO/category/featured/cover/author fields the
 * marketing site needs; unpublish-to-draft; the static-site EXPORT BUNDLE
 * (what the website builds from, etag-able); and the public surfaces the
 * blog renders from (list, by-slug, RSS/Atom/JSON feeds, sitemap).
 */
@Injectable()
export class ContentService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  async list(includeDrafts: boolean): Promise<Array<typeof contentPosts.$inferSelect>> {
    return this.db.root
      .select()
      .from(contentPosts)
      .where(includeDrafts ? undefined : eq(contentPosts.status, 'published'))
      .orderBy(desc(contentPosts.publishedAt), desc(contentPosts.createdAt))
      .limit(500);
  }

  /** Create or update; every save writes an immutable revision snapshot. */
  async upsert(dto: ContentPostDto, authorAccountId: string): Promise<typeof contentPosts.$inferSelect> {
    const tags = (dto.tags ?? '')
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0 && t.length <= 32)
      .slice(0, 12);
    const existing = await this.db.root.select().from(contentPosts).where(eq(contentPosts.slug, dto.slug)).limit(1);

    if (existing[0]) {
      const version = await this.nextVersion(existing[0].id);
      const updated = await this.db.root
        .update(contentPosts)
        .set({
          title: dto.title,
          summary: dto.summary ?? null,
          bodyMd: dto.body_md,
          tags,
          category: dto.category ?? existing[0].category,
          seoDescription: dto.seo_description ?? existing[0].seoDescription,
          coverImage: dto.cover_image ?? existing[0].coverImage,
          authorName: dto.author_name ?? existing[0].authorName,
          ...(dto.featured !== undefined ? { featured: dto.featured } : {}),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(contentPosts.id, existing[0].id))
        .returning();
      await this.snapshotRevision(updated[0], version, authorAccountId);
      await this.audit.add({
        action: 'content.post_updated',
        resourceType: 'content_post',
        resourceId: existing[0].id,
        actorType: 'account',
        actorId: authorAccountId,
        details: { slug: dto.slug, version: String(version) },
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
        category: dto.category ?? null,
        seoDescription: dto.seo_description ?? null,
        coverImage: dto.cover_image ?? null,
        authorName: dto.author_name ?? null,
        featured: dto.featured ?? false,
        authorAccount: authorAccountId,
      })
      .onConflictDoNothing({ target: contentPosts.slug })
      .returning();
    if (!inserted[0]) {
      throw ApiError.conflict('slug already exists');
    }
    await this.snapshotRevision(inserted[0], 1, authorAccountId);
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

  /** Immediate publish (keeps a future publish_at only if still in the future). */
  async publish(slug: string, actorAccountId: string): Promise<void> {
    const post = await this.require(slug);
    const nowIso = new Date().toISOString();
    await this.db.root
      .update(contentPosts)
      .set({
        status: 'published',
        publishedAt: post.publishedAt ?? nowIso,
        publishAt: post.publishAt && post.publishAt > nowIso ? post.publishAt : null,
        updatedAt: nowIso,
      })
      .where(eq(contentPosts.id, post.id));
    await this.audit.add({
      action: 'content.post_published',
      resourceType: 'content_post',
      resourceId: post.id,
      actorType: 'account',
      actorId: actorAccountId,
      details: { slug },
    });
  }

  /** Schedule: the worker publishes at the instant. */
  async schedule(slug: string, publishAtIso: string, actorAccountId: string): Promise<void> {
    const post = await this.require(slug);
    const at = new Date(publishAtIso);
    if (!Number.isFinite(at.getTime())) {
      throw ApiError.validation({ publish_at: 'ISO-8601 required' });
    }
    await this.db.root
      .update(contentPosts)
      .set({ publishAt: at.toISOString(), updatedAt: new Date().toISOString() })
      .where(eq(contentPosts.id, post.id));
    await this.audit.add({
      action: 'content.post_scheduled',
      resourceType: 'content_post',
      resourceId: post.id,
      actorType: 'account',
      actorId: actorAccountId,
      details: { slug, publish_at: at.toISOString() },
    });
  }

  async archive(slug: string, actorAccountId: string): Promise<void> {
    const post = await this.require(slug);
    await this.db.root
      .update(contentPosts)
      .set({ status: 'archived', publishAt: null, updatedAt: new Date().toISOString() })
      .where(eq(contentPosts.id, post.id));
    await this.audit.add({
      action: 'content.post_archived',
      resourceType: 'content_post',
      resourceId: post.id,
      actorType: 'account',
      actorId: actorAccountId,
      details: { slug },
    });
  }

  /** Unpublish back to draft (content stays; feeds drop it). */
  async unpublish(slug: string, actorAccountId: string): Promise<void> {
    const post = await this.require(slug);
    await this.db.root
      .update(contentPosts)
      .set({ status: 'draft', publishAt: null, updatedAt: new Date().toISOString() })
      .where(eq(contentPosts.id, post.id));
    await this.audit.add({
      action: 'content.post_unpublished',
      resourceType: 'content_post',
      resourceId: post.id,
      actorType: 'account',
      actorId: actorAccountId,
      details: { slug },
    });
  }

  // ── revisions ──────────────────────────────────────────────────────────────

  async revisions(slug: string): Promise<Array<typeof contentRevisions.$inferSelect>> {
    const post = await this.require(slug);
    return this.db.root
      .select()
      .from(contentRevisions)
      .where(eq(contentRevisions.postId, post.id))
      .orderBy(desc(contentRevisions.version))
      .limit(100);
  }

  /** Restore a revision: writes it as the CURRENT content (a NEW revision — history never rewrites). */
  async restore(slug: string, version: number, actorAccountId: string): Promise<void> {
    const post = await this.require(slug);
    const rows = await this.db.root
      .select()
      .from(contentRevisions)
      .where(and(eq(contentRevisions.postId, post.id), eq(contentRevisions.version, version)))
      .limit(1);
    const revision = rows[0];
    if (!revision) {
      throw ApiError.notFound('revision');
    }
    const next = await this.nextVersion(post.id);
    const updated = await this.db.root
      .update(contentPosts)
      .set({ title: revision.title, summary: revision.summary, bodyMd: revision.bodyMd, tags: revision.tags, updatedAt: new Date().toISOString() })
      .where(eq(contentPosts.id, post.id))
      .returning();
    await this.snapshotRevision(updated[0], next, actorAccountId);
    await this.audit.add({
      action: 'content.post_restored',
      resourceType: 'content_post',
      resourceId: post.id,
      actorType: 'account',
      actorId: actorAccountId,
      details: { slug, restored_version: String(version), new_version: String(next) },
    });
  }

  // ── worker: scheduled publish pass ─────────────────────────────────────────

  async publishDue(): Promise<number> {
    const result = await this.db.root
      .update(contentPosts)
      .set({ status: 'published', publishedAt: sql`coalesce(${contentPosts.publishedAt}, now())`, publishAt: null, updatedAt: new Date().toISOString() })
      .where(and(eq(contentPosts.status, 'draft'), isNotNull(contentPosts.publishAt), lte(contentPosts.publishAt, new Date().toISOString())))
      .returning({ id: contentPosts.id, slug: contentPosts.slug });
    for (const post of result) {
      await this.audit.add({
        action: 'content.post_published',
        resourceType: 'content_post',
        resourceId: post.id,
        actorType: 'system',
        details: { slug: post.slug, scheduled: true },
      });
    }
    return result.length;
  }

  // ── public surfaces ────────────────────────────────────────────────────────

  /** The website build feed: published posts, full bodies, CMS fields. */
  async publishedFeed(): Promise<unknown> {
    const rows = await this.list(false);
    return { posts: rows.map((row) => this.publicView(row)), generated_at: new Date().toISOString() };
  }

  async publishedBySlug(slug: string): Promise<unknown | null> {
    const rows = await this.db.root
      .select()
      .from(contentPosts)
      .where(and(eq(contentPosts.slug, slug), eq(contentPosts.status, 'published')))
      .limit(1);
    return rows[0] ? this.publicView(rows[0]) : null;
  }

  async publishedList(limit = 50): Promise<unknown[]> {
    const rows = await this.db.root
      .select()
      .from(contentPosts)
      .where(eq(contentPosts.status, 'published'))
      .orderBy(desc(contentPosts.publishedAt))
      .limit(Math.min(limit, 100));
    return rows.map((row) => this.publicView(row, true));
  }

  /** Staff draft preview (no public exposure of drafts). */
  async preview(slug: string): Promise<unknown | null> {
    const rows = await this.db.root.select().from(contentPosts).where(eq(contentPosts.slug, slug)).limit(1);
    return rows[0] ? this.publicView(rows[0]) : null;
  }

  public publicView(row: typeof contentPosts.$inferSelect, summaryOnly = false) {
    const base = {
      slug: row.slug,
      title: row.title,
      summary: row.summary,
      category: row.category,
      tags: row.tags,
      cover_image: row.coverImage,
      author: row.authorName,
      featured: row.featured,
      seo_description: row.seoDescription,
      published_at: row.publishedAt,
      updated_at: row.updatedAt,
    };
    return summaryOnly ? base : { ...base, body_md: row.bodyMd };
  }

  private async require(slug: string) {
    const rows = await this.db.root.select().from(contentPosts).where(eq(contentPosts.slug, slug)).limit(1);
    if (!rows[0]) {
      throw ApiError.notFound('post');
    }
    return rows[0];
  }

  private async nextVersion(postId: string): Promise<number> {
    const rows = await this.db.root
      .select({ max: sql<number>`coalesce(max(${contentRevisions.version}), 0)::int` })
      .from(contentRevisions)
      .where(eq(contentRevisions.postId, postId));
    return (rows[0]?.max ?? 0) + 1;
  }

  private async snapshotRevision(post: typeof contentPosts.$inferSelect, version: number, editorAccount: string): Promise<void> {
    await this.db.root
      .insert(contentRevisions)
      .values({
        postId: post.id,
        version,
        title: post.title,
        summary: post.summary,
        bodyMd: post.bodyMd,
        tags: post.tags,
        editorAccount,
      })
      .onConflictDoNothing({ target: [contentRevisions.postId, contentRevisions.version] });
  }
}

/** The blog's site base — feed/sitemap URLs are absolute by RSS/Atom spec. */
export function siteBaseUrl(): string {
  return (env.ENGINE_UI_BASE_URL || env.ENGINE_BASE_URL).replace(/\/$/, '');
}
