/**
 * Content repository port (P3) — `content_posts` + `content_revisions`.
 *
 * CORPORATE TABLES ARE GLOBAL (non-tenant): per `public.schema.ts`, the
 * corporate plane is "Platform-plane like accounts: NOT tenant-scoped, no
 * RLS — the engine is the only writer". No orgId on these methods by design.
 *
 * No DbService/Drizzle/Mongo types — plain domain types only.
 */

/** Plain domain input for post upsert (DTO-free; the API layer maps its validated DTO to this). */
export interface UpsertContentPostDto {
  slug: string;
  title: string;
  body_md: string;
  summary?: string;
  category?: string;
  seo_description?: string;
  cover_image?: string;
  author_name?: string;
  featured?: boolean;
}

/** Plain domain view of a `content_posts` row (drizzle-free). */
export interface ContentPostRow {
  id: string;
  slug: string;
  title: string;
  summary: string | null;
  bodyMd: string;
  status: string;
  tags: string[];
  category: string | null;
  seoDescription: string | null;
  coverImage: string | null;
  authorName: string | null;
  featured: boolean;
  publishAt: string | null;
  authorAccount: string;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Plain domain view of a `content_revisions` row (drizzle-free). */
export interface ContentRevisionRow {
  id: string;
  postId: string;
  version: number;
  title: string;
  summary: string | null;
  bodyMd: string;
  tags: string[];
  editorAccount: string | null;
  createdAt: string;
}

export interface UpsertContentPostInput {
  dto: UpsertContentPostDto;
  authorAccountId: string;
  tags: string[];
}

export interface IContentRepository {
  /** List posts; drafts included only when asked. */
  listPosts(includeDrafts: boolean): Promise<ContentPostRow[]>;
  /** Get a post by slug; null when unknown. */
  getPostBySlug(slug: string): Promise<ContentPostRow | null>;
  /**
   * Create or update a post; every save writes an immutable revision.
   * Returns the row and the revision version written.
   * Throws `conflict('slug already exists')` when the insert loses a race.
   */
  upsertPost(input: UpsertContentPostInput): Promise<{ row: ContentPostRow; version: number; created: boolean }>;
  /** Next revision version for a post (max + 1). */
  nextVersion(postId: string): Promise<number>;
  /** Write an immutable revision snapshot (idempotent on post+version). */
  snapshotRevision(input: { post: ContentPostRow; version: number; editorAccountId: string }): Promise<void>;
  /** Publish now; keeps a future publish_at only if still in the future. */
  publishPost(input: { postId: string; currentPublishedAt: string | null; currentPublishAt: string | null }): Promise<void>;
  /** Schedule a future publish. */
  schedulePost(input: { postId: string; publishAtIso: string }): Promise<void>;
  /** Archive a post. */
  archivePost(postId: string): Promise<void>;
  /** Unpublish back to draft. */
  unpublishPost(postId: string): Promise<void>;
  /** Revisions for a post, newest version first. */
  listRevisions(postId: string): Promise<ContentRevisionRow[]>;
  /** One revision by post + version; null when unknown. */
  getRevision(postId: string, version: number): Promise<ContentRevisionRow | null>;
  /**
   * Restore a revision as current content (writes a NEW revision).
   * Returns the new version number.
   */
  restoreRevision(input: { postId: string; revision: ContentRevisionRow; editorAccountId: string }): Promise<number>;
  /**
   * Worker: publish all due scheduled drafts. Returns the published
   * post ids + slugs (the service audits each one).
   */
  publishDue(): Promise<Array<{ id: string; slug: string }>>;
  /** Public: one published post by slug; null when unknown/unpublished. */
  getPublishedBySlug(slug: string): Promise<ContentPostRow | null>;
  /** Public: published posts, newest first (summary projection). */
  listPublished(limit: number): Promise<ContentPostRow[]>;
  /** Feeds: recent published posts (projected fields for syndication). */
  recentPublishedPosts(limit: number): Promise<Array<Pick<ContentPostRow, 'slug' | 'title' | 'summary' | 'category' | 'authorName' | 'publishedAt' | 'updatedAt'>>>;
  /** Sitemap: published post slugs + updated_at. */
  sitemapPosts(limit: number): Promise<Array<Pick<ContentPostRow, 'slug' | 'updatedAt'>>>;
}
