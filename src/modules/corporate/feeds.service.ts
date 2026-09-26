import { Inject, Injectable } from '@nestjs/common';
import { CONTENT_REPOSITORY } from './repositories/repository-tokens';
import type { IContentRepository } from './repositories/content.repository';
import { siteBaseUrl } from './content.service';

/**
 * The blog's syndication surfaces (E-3 depth): RSS 2.0, Atom 1.0, JSON
 * Feed, and a posts sitemap — everything a marketing site needs for
 * distribution and search indexing. XML is generated with strict escaping;
 * dates are RFC-822 (RSS) / ISO-8601 (Atom, JSON, sitemap) per spec.
 *
 * Feeds carry the 25 most recent published posts (summary, not full body —
 * feeds are discovery surfaces; the site owns the reading experience).
 *
 * Persistence-blind (P3): post reads go through `IContentRepository`.
 * Corporate tables are global (non-tenant).
 */
const FEED_LIMIT = 25;

@Injectable()
export class FeedsService {
  constructor(@Inject(CONTENT_REPOSITORY) private readonly content: IContentRepository) {}

  private recentPosts() {
    return this.content.recentPublishedPosts(FEED_LIMIT);
  }

  async rss(): Promise<string> {
    const base = siteBaseUrl();
    const posts = await this.recentPosts();
    const items = posts
      .map((post) => {
        const url = `${base}/blog/${post.slug}`;
        return `    <item>
      <title>${xml(post.title)}</title>
      <link>${xml(url)}</link>
      <guid isPermaLink="true">${xml(url)}</guid>
      <pubDate>${rfc822(post.publishedAt)}</pubDate>
      ${post.category ? `<category>${xml(post.category)}</category>` : ''}
      <description>${xml(post.summary ?? '')}</description>
    </item>`;
      })
      .join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Neryva Blog</title>
    <link>${xml(base)}/blog</link>
    <atom:link href="${xml(base)}/public/feed.xml" rel="self" type="application/rss+xml"/>
    <description>Builds, ships, and engineering from the Neryva team.</description>
    <language>en</language>
${items}
  </channel>
</rss>`;
  }

  async atom(): Promise<string> {
    const base = siteBaseUrl();
    const posts = await this.recentPosts();
    const entries = posts
      .map((post) => {
        const url = `${base}/blog/${post.slug}`;
        return `    <entry>
      <title>${xml(post.title)}</title>
      <link href="${xml(url)}"/>
      <id>tag:neryva.com,2026:${xml(post.slug)}</id>
      <updated>${iso(post.updatedAt)}</updated>
      <published>${iso(post.publishedAt)}</published>
      <summary>${xml(post.summary ?? '')}</summary>
      ${post.authorName ? `<author><name>${xml(post.authorName)}</name></author>` : ''}
    </entry>`;
      })
      .join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Neryva Blog</title>
  <link href="${xml(base)}/blog"/>
  <link href="${xml(base)}/public/feed.atom" rel="self"/>
  <id>tag:neryva.com,2026:blog</id>
  <updated>${posts[0] ? iso(posts[0].updatedAt) : iso(new Date().toISOString())}</updated>
${entries}
</feed>`;
  }

  async jsonFeed(): Promise<string> {
    const base = siteBaseUrl();
    const posts = await this.recentPosts();
    return JSON.stringify(
      {
        version: 'https://jsonfeed.org/version/1.1',
        title: 'Neryva Blog',
        home_page_url: `${base}/blog`,
        feed_url: `${base}/public/feed.json`,
        items: posts.map((post) => ({
          id: `${base}/blog/${post.slug}`,
          url: `${base}/blog/${post.slug}`,
          title: post.title,
          summary: post.summary ?? undefined,
          date_published: post.publishedAt,
          date_modified: post.updatedAt,
          tags: post.category ? [post.category] : undefined,
          authors: post.authorName ? [{ name: post.authorName }] : undefined,
        })),
      },
      null,
      2,
    );
  }

  /** The posts fragment of the site sitemap (the site merges it with static routes). */
  async sitemap(): Promise<string> {
    const base = siteBaseUrl();
    const posts = await this.content.sitemapPosts(1000);
    const urls = posts
      .map((post) => `  <url>
    <loc>${xml(`${base}/blog/${post.slug}`)}</loc>
    <lastmod>${iso(post.updatedAt)}</lastmod>
  </url>`)
      .join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;
  }
}

function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function iso(value: string | null): string {
  return value ? new Date(value).toISOString() : new Date().toISOString();
}

function rfc822(value: string | null): string {
  return new Date(value ?? Date.now()).toUTCString();
}
