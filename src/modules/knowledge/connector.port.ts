/**
 * Connector port (FL-2.5) — an incremental source of documents that flows
 * into the EXISTING upload-session pipeline (scan → extract → index). The
 * port NEVER touches Engine tables; the connectors service owns persistence.
 *
 * Sitemap is the first REAL adapter (no OAuth): it diffs <url><lastmod>
 * entries against the stored cursor and fetches changed pages as text.
 * Google Drive / Notion / Confluence are registered with full port shapes
 * but require per-tenant OAuth apps — their adapters throw
 * CONNECTOR_OAUTH_REQUIRED (a documented seam, FL-2.5/FL-2.18) rather than
 * pretending to sync.
 */
import { Logger } from '@nestjs/common';
import {
  ConfluenceAdapter,
  GoogleDriveAdapter,
  NotionAdapter,
  SharePointGraphAdapter,
  SlackAdapter,
  ZendeskAdapter,
} from './connector-adapters';

export interface ConnectorDocument {
  /** Stable external identity — the cursor dedup key. */
  externalId: string;
  title: string;
  mediaType: string;
  /**
   * Extracted plain text for text/* content. Binary content (PDF/images)
   * travels in contentBytesB64 with the real mediaType so the extraction
   * pipeline (OCR/transcribe) handles it like an upload.
   */
  content: string;
  contentBytesB64?: string;
  sourceUrl?: string;
  /**
   * Source permission verdict. Absent = open (org visibility). Restricted
   * principals are matched by linked account or verified email at retrieval;
   * unknown principals default-deny. Enforced inside the retrieval SQL.
   */
  acl?: { mode: 'open' } | { mode: 'restricted'; principals: SourcePrincipal[] };
}

/** An external user/group/domain known to the source system. */
export interface SourcePrincipal {
  kind: 'user' | 'group' | 'domain';
  id: string;
  email?: string;
  display?: string;
}

export interface ConnectorFetchResult {
  documents: ConnectorDocument[];
  nextCursor: Record<string, unknown>;
  /** True when the source reported more changes than this sync consumed. */
  truncated: boolean;
  /** External ids deleted at the source — tombstoned, never hard-dropped. */
  deletedExternalIds?: string[];
  /** Seen but not ingested (unsupported mime, oversize, fetch failure). */
  skipped?: Array<{ externalId: string; title: string; reason: string }>;
}

export class ConnectorOAuthRequiredError extends Error {
  constructor(provider: string) {
    super(`CONNECTOR_OAUTH_REQUIRED: ${provider} requires a per-tenant OAuth app (FL-2.18 seam)`);
  }
}

export interface ConnectorPort {
  readonly provider: string;
  fetchUpdates(input: {
    config: Record<string, unknown>;
    credentials?: string;
    cursor: Record<string, unknown>;
    maxDocuments: number;
  }): Promise<ConnectorFetchResult>;
}

const HTML_TAG_RE = /<(script|style)[^>]*>[\s\S]*?<\/\1>|<[^>]+>/g;

/** Fetch a URL as bounded text (HTML stripped to its text content). */
export async function fetchPageAsText(url: string, maxChars = 200_000): Promise<string> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`source fetch HTTP ${res.status} for ${url}`);
  }
  const html = await res.text();
  const text = html
    .replace(HTML_TAG_RE, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, maxChars);
}

export class SitemapConnector implements ConnectorPort {
  readonly provider = 'sitemap';

  async fetchUpdates(input: {
    config: Record<string, unknown>;
    cursor: Record<string, unknown>;
    maxDocuments: number;
  }): Promise<ConnectorFetchResult> {
    const sitemapUrl = String(input.config['sitemap_url'] ?? '');
    if (!sitemapUrl) {
      throw new Error('connector config.sitemap_url is required');
    }
    const res = await fetch(sitemapUrl, { redirect: 'follow' });
    if (!res.ok) {
      throw new Error(`sitemap fetch HTTP ${res.status}`);
    }
    const xml = await res.text();
    // Minimal <url> entry parse — loc + optional lastmod.
    const entries = new Map<string, string | null>();
    const urlBlocks = xml.match(/<url>[\s\S]*?<\/url>/g) ?? [];
    for (const block of urlBlocks) {
      const loc = /<loc>\s*([^<\s]+)\s*<\/loc>/.exec(block)?.[1];
      if (!loc) continue;
      const lastmod = /<lastmod>\s*([^<\s]+)\s*<\/lastmod>/.exec(block)?.[1] ?? null;
      entries.set(loc, lastmod);
    }
    const cursorEntries = (input.cursor['entries'] ?? {}) as Record<string, string>;
    const changed: Array<{ url: string; lastmod: string | null }> = [];
    for (const [url, lastmod] of entries) {
      if (cursorEntries[url] !== (lastmod ?? '')) {
        changed.push({ url, lastmod });
      }
    }
    const nextCursor: Record<string, unknown> = { entries: Object.fromEntries(entries) };
    const batch = changed.slice(0, input.maxDocuments);
    const documents: ConnectorDocument[] = [];
    for (const entry of batch) {
      // Source fetch failures skip the page but do not fail the sync —
      // the cursor records its lastmod so a dead page is not retried forever.
      try {
        documents.push({
          externalId: entry.url,
          title: entry.url.replace(/\/$/, '').split('/').pop() || entry.url,
          mediaType: 'text/plain',
          content: await fetchPageAsText(entry.url),
          sourceUrl: entry.url,
        });
      } catch (err) {
        Logger.warn(`sitemap page skipped: ${(err as Error).message}`);
      }
    }
    return { documents, nextCursor, truncated: changed.length > batch.length };
  }
}

export class OAuthConnectorStub implements ConnectorPort {
  readonly provider: string;

  constructor(provider: string) {
    this.provider = provider;
  }

  async fetchUpdates(): Promise<ConnectorFetchResult> {
    throw new ConnectorOAuthRequiredError(this.provider);
  }
}

export const CONNECTOR_PROVIDERS: ReadonlyMap<string, ConnectorPort> = new Map<string, ConnectorPort>([
  ['sitemap', new SitemapConnector()],
  ['google_drive', new GoogleDriveAdapter()],
  ['sharepoint', new SharePointGraphAdapter()],
  ['confluence', new ConfluenceAdapter()],
  ['notion', new NotionAdapter()],
  ['zendesk', new ZendeskAdapter()],
  ['slack', new SlackAdapter()],
]);

/** The org-facing provider list — errors surface at sync, not at link time. */
export const CONNECTOR_PROVIDER_IDS = ['sitemap', 'google_drive', 'sharepoint', 'confluence', 'notion', 'zendesk', 'slack'] as const;
