import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { env } from '../../common/config/env';
import { ContentPostDto } from './dto';
import { CONTENT_REPOSITORY } from './repositories/repository-tokens';
import type { ContentPostRow, ContentRevisionRow, IContentRepository } from './repositories/content.repository';

/**
 * Content admin v2 (E-3 to production grade): a real CMS discipline —
 * immutable REVISIONS on every save with restore; scheduled publishing
 * (publish_at + the worker); SEO/category/featured/cover/author fields the
 * marketing site needs; unpublish-to-draft; the static-site EXPORT BUNDLE
 * (what the website builds from, etag-able); and the public surfaces the
 * blog renders from (list, by-slug, RSS/Atom/JSON feeds, sitemap).
 *
 * Persistence-blind (P3): all storage goes through `IContentRepository`.
 * Corporate tables are global (non-tenant).
 */
@Injectable()
export class ContentService {
  constructor(
    @Inject(CONTENT_REPOSITORY) private readonly content: IContentRepository,
    private readonly audit: AuditService,
  ) {}

  async list(includeDrafts: boolean): Promise<ContentPostRow[]> {
    return this.content.listPosts(includeDrafts);
  }

  /** Create or update; every save writes an immutable revision snapshot. */
  async upsert(dto: ContentPostDto, authorAccountId: string): Promise<ContentPostRow> {
    const tags = (dto.tags ?? '')
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0 && t.length <= 32)
      .slice(0, 12);
    const { row, version, created } = await this.content.upsertPost({ dto, tags, authorAccountId });
    await this.audit.add({
      action: created ? 'content.post_created' : 'content.post_updated',
      resourceType: 'content_post',
      resourceId: row.id,
      actorType: 'account',
      actorId: authorAccountId,
      details: created ? { slug: dto.slug } : { slug: dto.slug, version: String(version) },
    });
    return row;
  }

  /** Immediate publish (keeps a future publish_at only if still in the future). */
  async publish(slug: string, actorAccountId: string): Promise<void> {
    const post = await this.require(slug);
    await this.content.publishPost({
      postId: post.id,
      currentPublishedAt: post.publishedAt,
      currentPublishAt: post.publishAt,
    });
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
    await this.content.schedulePost({ postId: post.id, publishAtIso: at.toISOString() });
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
    await this.content.archivePost(post.id);
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
    await this.content.unpublishPost(post.id);
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

  async revisions(slug: string): Promise<ContentRevisionRow[]> {
    const post = await this.require(slug);
    return this.content.listRevisions(post.id);
  }

  /** Restore a revision: writes it as the CURRENT content (a NEW revision — history never rewrites). */
  async restore(slug: string, version: number, actorAccountId: string): Promise<void> {
    const post = await this.require(slug);
    const revision = await this.content.getRevision(post.id, version);
    if (!revision) {
      throw ApiError.notFound('revision');
    }
    const next = await this.content.restoreRevision({
      postId: post.id,
      revision,
      editorAccountId: actorAccountId,
    });
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
    const published = await this.content.publishDue();
    for (const post of published) {
      await this.audit.add({
        action: 'content.post_published',
        resourceType: 'content_post',
        resourceId: post.id,
        actorType: 'system',
        details: { slug: post.slug, scheduled: true },
      });
    }
    return published.length;
  }

  // ── public surfaces ────────────────────────────────────────────────────────

  /** The website build feed: published posts, full bodies, CMS fields. */
  async publishedFeed(): Promise<unknown> {
    const rows = await this.list(false);
    return { posts: rows.map((row) => this.publicView(row)), generated_at: new Date().toISOString() };
  }

  async publishedBySlug(slug: string): Promise<unknown | null> {
    const row = await this.content.getPublishedBySlug(slug);
    return row ? this.publicView(row) : null;
  }

  async publishedList(limit = 50): Promise<unknown[]> {
    const rows = await this.content.listPublished(limit);
    return rows.map((row) => this.publicView(row, true));
  }

  /** Staff draft preview (no public exposure of drafts). */
  async preview(slug: string): Promise<unknown | null> {
    const row = await this.content.getPostBySlug(slug);
    return row ? this.publicView(row) : null;
  }

  public publicView(row: ContentPostRow, summaryOnly = false) {
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

  private async require(slug: string): Promise<ContentPostRow> {
    const row = await this.content.getPostBySlug(slug);
    if (!row) {
      throw ApiError.notFound('post');
    }
    return row;
  }
}

/** The blog's site base — feed/sitemap URLs are absolute by RSS/Atom spec. */
export function siteBaseUrl(): string {
  return (env.ENGINE_UI_BASE_URL || env.ENGINE_BASE_URL).replace(/\/$/, '');
}
