/**
 * MongoDB lane for `IContentRepository` (P3).
 *
 * Plan D4: UUIDs as BSON Binary subtype 4, pg snake_case field names,
 * ISO-8601 timestamp strings. Corporate tables are global (non-tenant) —
 * every method is one `withBypass` unit with plain collection handles.
 *
 * The `content_posts.slug` duplicate-key is mapped to the same
 * client-facing conflict the pg lane raises, without further reads in the
 * aborted transaction.
 */
import type { Db } from 'mongodb';
import { ApiError } from '../../../common/http/api-error';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { uuidv7 } from '../../../common/ids/uuidv7';
import type {
  ContentPostRow,
  ContentRevisionRow,
  IContentRepository,
  UpsertContentPostInput,
} from './content.repository';
import {
  binUuid,
  corporateCollections,
  isDuplicateKey,
  toContentPost,
  toContentRevision,
} from './mongo-documents';

export class MongoContentRepository implements IContentRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private tx(db: Db, ctx: MongoTxContext) {
    return { session: { session: ctx.session }, ...corporateCollections(db) };
  }

  private async nextVersionTx(
    t: ReturnType<MongoContentRepository['tx']>,
    postId: string,
  ): Promise<number> {
    const pipeline = [
      { $match: { post_id: binUuid(postId, 'postId') } },
      { $group: { _id: null, max: { $max: '$version' } } },
    ];
    const docs = await t.contentRevisions.aggregate(pipeline, t.session).toArray();
    const max = (docs[0] as { max?: number } | undefined)?.max ?? 0;
    return max + 1;
  }

  private async snapshotRevisionTx(
    t: ReturnType<MongoContentRepository['tx']>,
    input: { post: ContentPostRow; version: number; editorAccountId: string },
  ): Promise<void> {
    // Atomic upsert = the pg lane's onConflictDoNothing on (post_id, version).
    await t.contentRevisions.updateOne(
      { post_id: binUuid(input.post.id, 'postId'), version: input.version },
      {
        $setOnInsert: {
          id: binUuid(uuidv7()),
          post_id: binUuid(input.post.id, 'postId'),
          version: input.version,
          title: input.post.title,
          summary: input.post.summary,
          body_md: input.post.bodyMd,
          tags: input.post.tags,
          editor_account: binUuid(input.editorAccountId, 'editorAccountId'),
          created_at: new Date().toISOString(),
        },
      },
      { ...t.session, upsert: true },
    );
  }

  async listPosts(includeDrafts: boolean): Promise<ContentPostRow[]> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const filter = includeDrafts ? {} : { status: 'published' };
      const docs = await t.contentPosts
        .find(filter, t.session)
        .sort({ published_at: -1, created_at: -1 })
        .limit(500)
        .toArray();
      return docs.map(toContentPost);
    });
  }

  async getPostBySlug(slug: string): Promise<ContentPostRow | null> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const doc = await t.contentPosts.findOne({ slug }, t.session);
      return doc ? toContentPost(doc) : null;
    });
  }

  async upsertPost(input: UpsertContentPostInput): Promise<{ row: ContentPostRow; version: number; created: boolean }> {
    const db = this.mongo.root;
    const now = new Date().toISOString();
    try {
      return await this.mongo.withBypass(async (ctx) => {
        const t = this.tx(db, ctx);
        const existing = await t.contentPosts.findOne({ slug: input.dto.slug }, t.session);
        if (existing) {
          const existingRow = toContentPost(existing);
          const version = await this.nextVersionTx(t, existingRow.id);
          const update: Record<string, unknown> = {
            title: input.dto.title,
            summary: input.dto.summary ?? null,
            body_md: input.dto.body_md,
            tags: input.tags,
            category: input.dto.category ?? existingRow.category,
            seo_description: input.dto.seo_description ?? existingRow.seoDescription,
            cover_image: input.dto.cover_image ?? existingRow.coverImage,
            author_name: input.dto.author_name ?? existingRow.authorName,
            updated_at: now,
          };
          if (input.dto.featured !== undefined) {
            update['featured'] = input.dto.featured;
          }
          const updated = await t.contentPosts.findOneAndUpdate(
            { id: existing.id },
            { $set: update },
            { ...t.session, returnDocument: 'after' },
          );
          if (!updated) {
            throw ApiError.notFound('post');
          }
          await this.snapshotRevisionTx(t, { post: toContentPost(updated), version, editorAccountId: input.authorAccountId });
          return { row: toContentPost(updated), version, created: false };
        }
        const doc = {
          id: binUuid(uuidv7()),
          slug: input.dto.slug,
          title: input.dto.title,
          summary: input.dto.summary ?? null,
          body_md: input.dto.body_md,
          status: 'draft',
          tags: input.tags,
          category: input.dto.category ?? null,
          seo_description: input.dto.seo_description ?? null,
          cover_image: input.dto.cover_image ?? null,
          author_name: input.dto.author_name ?? null,
          featured: input.dto.featured ?? false,
          publish_at: null,
          author_account: binUuid(input.authorAccountId, 'authorAccountId'),
          published_at: null,
          created_at: now,
          updated_at: now,
        };
        await t.contentPosts.insertOne(doc, t.session);
        const row = toContentPost({ ...doc, _id: undefined as never });
        await this.snapshotRevisionTx(t, { post: row, version: 1, editorAccountId: input.authorAccountId });
        return { row, version: 1, created: true };
      });
    } catch (err) {
      // Insert race lost: the pg lane's onConflictDoNothing + empty-returning
      // maps to the same client-facing conflict. No reads in the aborted txn.
      if (isDuplicateKey(err)) {
        throw ApiError.conflict('slug already exists');
      }
      throw err as Error;
    }
  }

  async nextVersion(postId: string): Promise<number> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      return this.nextVersionTx(t, postId);
    });
  }

  async snapshotRevision(input: { post: ContentPostRow; version: number; editorAccountId: string }): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      await this.snapshotRevisionTx(t, input);
    });
  }

  async publishPost(input: { postId: string; currentPublishedAt: string | null; currentPublishAt: string | null }): Promise<void> {
    const db = this.mongo.root;
    const nowIso = new Date().toISOString();
    await this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      await t.contentPosts.updateOne(
        { id: binUuid(input.postId, 'postId') },
        {
          $set: {
            status: 'published',
            published_at: input.currentPublishedAt ?? nowIso,
            publish_at: input.currentPublishAt && input.currentPublishAt > nowIso ? input.currentPublishAt : null,
            updated_at: nowIso,
          },
        },
        t.session,
      );
    });
  }

  async schedulePost(input: { postId: string; publishAtIso: string }): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      await t.contentPosts.updateOne(
        { id: binUuid(input.postId, 'postId') },
        { $set: { publish_at: input.publishAtIso, updated_at: new Date().toISOString() } },
        t.session,
      );
    });
  }

  async archivePost(postId: string): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      await t.contentPosts.updateOne(
        { id: binUuid(postId, 'postId') },
        { $set: { status: 'archived', publish_at: null, updated_at: new Date().toISOString() } },
        t.session,
      );
    });
  }

  async unpublishPost(postId: string): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      await t.contentPosts.updateOne(
        { id: binUuid(postId, 'postId') },
        { $set: { status: 'draft', publish_at: null, updated_at: new Date().toISOString() } },
        t.session,
      );
    });
  }

  async listRevisions(postId: string): Promise<ContentRevisionRow[]> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const docs = await t.contentRevisions
        .find({ post_id: binUuid(postId, 'postId') }, t.session)
        .sort({ version: -1 })
        .limit(100)
        .toArray();
      return docs.map(toContentRevision);
    });
  }

  async getRevision(postId: string, version: number): Promise<ContentRevisionRow | null> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const doc = await t.contentRevisions.findOne(
        { post_id: binUuid(postId, 'postId'), version },
        t.session,
      );
      return doc ? toContentRevision(doc) : null;
    });
  }

  async restoreRevision(input: { postId: string; revision: ContentRevisionRow; editorAccountId: string }): Promise<number> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const next = await this.nextVersionTx(t, input.postId);
      const updated = await t.contentPosts.findOneAndUpdate(
        { id: binUuid(input.postId, 'postId') },
        {
          $set: {
            title: input.revision.title,
            summary: input.revision.summary,
            body_md: input.revision.bodyMd,
            tags: input.revision.tags,
            updated_at: new Date().toISOString(),
          },
        },
        { ...t.session, returnDocument: 'after' },
      );
      if (!updated) {
        throw ApiError.notFound('post');
      }
      await this.snapshotRevisionTx(t, { post: toContentPost(updated), version: next, editorAccountId: input.editorAccountId });
      return next;
    });
  }

  async publishDue(): Promise<Array<{ id: string; slug: string }>> {
    const db = this.mongo.root;
    const nowIso = new Date().toISOString();
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      // Find due drafts first (the pg lane's UPDATE..RETURNING in one step;
      // here a find + bulk update inside the same transaction).
      const due = await t.contentPosts
        .find(
          { status: 'draft', publish_at: { $ne: null, $lte: nowIso } },
          { ...t.session, projection: { id: 1, slug: 1, published_at: 1 } },
        )
        .toArray();
      for (const doc of due) {
        await t.contentPosts.updateOne(
          { id: doc.id },
          {
            $set: {
              status: 'published',
              published_at: doc.published_at ?? nowIso,
              publish_at: null,
              updated_at: nowIso,
            },
          },
          t.session,
        );
      }
      return due.map((d) => ({ id: d.id.toUUID().toString(), slug: d.slug }));
    });
  }

  async getPublishedBySlug(slug: string): Promise<ContentPostRow | null> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const doc = await t.contentPosts.findOne({ slug, status: 'published' }, t.session);
      return doc ? toContentPost(doc) : null;
    });
  }

  async listPublished(limit: number): Promise<ContentPostRow[]> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const docs = await t.contentPosts
        .find({ status: 'published' }, t.session)
        .sort({ published_at: -1 })
        .limit(Math.min(limit, 100))
        .toArray();
      return docs.map(toContentPost);
    });
  }

  async recentPublishedPosts(limit: number): Promise<Array<Pick<ContentPostRow, 'slug' | 'title' | 'summary' | 'category' | 'authorName' | 'publishedAt' | 'updatedAt'>>> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const docs = await t.contentPosts
        .find({ status: 'published' }, t.session)
        .sort({ published_at: -1 })
        .limit(limit)
        .toArray();
      return docs.map((d) => {
        const row = toContentPost(d);
        return {
          slug: row.slug,
          title: row.title,
          summary: row.summary,
          category: row.category,
          authorName: row.authorName,
          publishedAt: row.publishedAt,
          updatedAt: row.updatedAt,
        };
      });
    });
  }

  async sitemapPosts(limit: number): Promise<Array<Pick<ContentPostRow, 'slug' | 'updatedAt'>>> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const docs = await t.contentPosts
        .find({ status: 'published' }, t.session)
        .sort({ published_at: -1 })
        .limit(limit)
        .toArray();
      return docs.map((d) => ({ slug: d.slug, updatedAt: d.updated_at }));
    });
  }
}
