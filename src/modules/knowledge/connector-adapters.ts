import { fetchBounded, fetchJsonBounded, fetchTextBounded, stripHtmlToText } from './connector-http';
import type { ConnectorDocument, ConnectorFetchResult, ConnectorPort, SourcePrincipal } from './connector.port';

/**
 * P0-1 — production source adapters. Each adapter is a thin translator:
 * provider API → ConnectorDocument[] + tombstones + skips. No Engine state,
 * no secrets at rest (the usable bearer/static secret arrives per-call via
 * `credentials` after the service's ensureFresh step). Pure parsers are
 * exported for unit tests with fixture payloads (no network in tests).
 *
 * Bounds (every adapter): maxDocuments caps fetched docs per sync; binary
 * downloads are byte-capped; per-doc failures become `skipped` entries, never
 * sync failures. Pagination loops are iteration-capped so a lying API cannot
 * spin the worker.
 */

const MAX_PAGES = 20;

function bearer(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}` };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null) : [];
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

// ── Google Drive (OAuth2 user dance) ─────────────────────────────────────

const DRIVE_FIELDS = 'id,name,mimeType,modifiedTime,trashed,permissions(id,type,emailAddress,domain,role)';
const GOOGLE_NATIVE_EXPORT: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
  'application/vnd.google-apps.drawing': 'image/png',
};
const DRIVE_TEXT_MIMES = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json']);

export function drivePermissionToAcl(permissions: Array<Record<string, unknown>>): ConnectorDocument['acl'] {
  const principals: SourcePrincipal[] = [];
  for (const p of permissions) {
    if (p['type'] === 'anyone' || p['type'] === 'domain') {
      return { mode: 'open' };
    }
    if ((p['type'] === 'user' || p['type'] === 'group') && typeof p['id'] === 'string') {
      principals.push({
        kind: p['type'] as 'user' | 'group',
        id: p['id'] as string,
        ...(typeof p['emailAddress'] === 'string' ? { email: p['emailAddress'] as string } : {}),
      });
    }
  }
  if (principals.length === 0) {
    return { mode: 'open' };
  }
  return { mode: 'restricted', principals };
}

export class GoogleDriveAdapter implements ConnectorPort {
  readonly provider = 'google_drive';

  async fetchUpdates(input: {
    config: Record<string, unknown>;
    credentials?: string;
    cursor: Record<string, unknown>;
    maxDocuments: number;
  }): Promise<ConnectorFetchResult> {
    if (!input.credentials) {
      throw new Error('google_drive sync requires a linked OAuth account (run the OAuth dance first)');
    }
    const headers = bearer(input.credentials);
    const documents: ConnectorDocument[] = [];
    const skipped: Array<{ externalId: string; title: string; reason: string }> = [];
    const deletedExternalIds: string[] = [];
    let pageToken = typeof input.cursor['drivePageToken'] === 'string' ? (input.cursor['drivePageToken'] as string) : null;
    let truncated = false;

    if (pageToken === null) {
      // First sync: enumerate current files, then seed the changes cursor.
      let token: string | null = null;
      let pages = 0;
      const seen = new Set<string>();
      for (;;) {
        if (pages++ >= MAX_PAGES || documents.length + skipped.length >= input.maxDocuments) {
          truncated = true;
          break;
        }
        const params: URLSearchParams = new URLSearchParams();
        params.set('q', 'trashed = false');
        params.set('orderBy', 'modifiedTime desc');
        params.set('pageSize', '100');
        params.set('fields', `nextPageToken, files(${DRIVE_FIELDS})`);
        if (token) {
          params.set('pageToken', token);
        }
        const page: { files?: unknown[]; nextPageToken?: string } = await fetchJsonBounded<{ files?: unknown[]; nextPageToken?: string }>(
          `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
          { headers },
        );
        for (const f of asArray(page.files)) {
          if (documents.length + skipped.length >= input.maxDocuments) {
            truncated = true;
            break;
          }
          const id = str(f['id']);
          if (!id || seen.has(id)) {
            continue;
          }
          seen.add(id);
          await this.fetchOne(headers, f, documents, skipped);
        }
        token = typeof page.nextPageToken === 'string' ? page.nextPageToken : null;
        if (!token) {
          break;
        }
      }
      const start = await fetchJsonBounded<{ startPageToken?: string }>('https://www.googleapis.com/drive/v3/changes/startPageToken', { headers });
      pageToken = typeof start.startPageToken === 'string' ? start.startPageToken : '';
    } else {
      // Delta: changed + removed file ids, then hydrate metadata per id.
      let token: string | null = pageToken;
      let pages = 0;
      for (;;) {
        if (pages++ >= MAX_PAGES) {
          truncated = true;
          break;
        }
        const params: URLSearchParams = new URLSearchParams();
        params.set('pageToken', token ?? '');
        params.set('pageSize', '100');
        params.set('fields', `nextPageToken,newStartPageToken,changes(fileId,removed,time,file(${DRIVE_FIELDS}))`);
        const page: { changes?: unknown[]; nextPageToken?: string; newStartPageToken?: string } = await fetchJsonBounded<{
          changes?: unknown[];
          nextPageToken?: string;
          newStartPageToken?: string;
        }>(
          `https://www.googleapis.com/drive/v3/changes?${params.toString()}`,
          { headers },
        );
        for (const c of asArray(page.changes)) {
          const fileId = str(c['fileId']);
          if (!fileId) {
            continue;
          }
          if (c['removed'] === true) {
            deletedExternalIds.push(fileId);
            continue;
          }
          if (documents.length + skipped.length >= input.maxDocuments) {
            truncated = true;
            break;
          }
          const file = asRecord(c['file']);
          if (Object.keys(file).length > 0 && file['id'] !== undefined) {
            await this.fetchOne(headers, file, documents, skipped);
          } else {
            const meta = await fetchJsonBounded<unknown>(
              `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(DRIVE_FIELDS)}`,
              { headers },
            );
            await this.fetchOne(headers, asRecord(meta), documents, skipped);
          }
        }
        if (typeof page.nextPageToken === 'string') {
          token = page.nextPageToken;
          continue;
        }
        pageToken = typeof page.newStartPageToken === 'string' ? page.newStartPageToken : token ?? '';
        break;
      }
    }
    return { documents, nextCursor: { drivePageToken: pageToken }, truncated, deletedExternalIds, skipped };
  }

  private async fetchOne(
    headers: Record<string, string>,
    file: Record<string, unknown>,
    documents: ConnectorDocument[],
    skipped: Array<{ externalId: string; title: string; reason: string }>,
  ): Promise<void> {
    const id = str(file['id']);
    const title = str(file['name']) || id;
    const mime = str(file['mimeType']);
    try {
      const exportMime = GOOGLE_NATIVE_EXPORT[mime];
      if (exportMime) {
        const text = await fetchTextBounded(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}/export?${new URLSearchParams({ mimeType: exportMime }).toString()}`,
          { headers },
        );
        documents.push({
          externalId: id,
          title,
          mediaType: exportMime.startsWith('image/') ? exportMime : 'text/plain',
          content: exportMime.startsWith('image/') ? '' : text,
          ...(exportMime.startsWith('image/') ? { contentBytesB64: Buffer.from(text, 'binary').toString('base64') } : {}),
          acl: drivePermissionToAcl(asArray(file['permissions'])),
        });
        return;
      }
      if (DRIVE_TEXT_MIMES.has(mime)) {
        const text = await fetchTextBounded(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`, { headers });
        documents.push({ externalId: id, title, mediaType: mime, content: text, acl: drivePermissionToAcl(asArray(file['permissions'])) });
        return;
      }
      skipped.push({ externalId: id, title, reason: `unsupported_mime:${mime || 'unknown'}` });
    } catch (err) {
      skipped.push({ externalId: id, title, reason: `fetch_failed:${(err as Error).message.slice(0, 120)}` });
    }
  }
}

// ── SharePoint / OneDrive via Microsoft Graph (client-credentials) ───────

const GRAPH_TEXT_MIMES = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json', 'application/pdf']);

export interface GraphPermission {
  roles: string[];
  grantedToV2?: unknown;
  grantedToIdentitiesV2?: unknown;
  grantedTo?: unknown;
  link?: unknown;
}

export function graphPermissionToAcl(permissions: GraphPermission[]): ConnectorDocument['acl'] {
  const principals: SourcePrincipal[] = [];
  for (const p of permissions) {
    const link = asRecord(p.link);
    if (link['scope'] === 'anonymous' || link['scope'] === 'organization') {
      return { mode: 'open' };
    }
    // grantedToV2/grantedTo are single DriveRecipient objects;
    // grantedToIdentitiesV2 is the array form. Collect all three shapes.
    const candidates = [asRecord(p['grantedToV2']), asRecord(p['grantedTo']), ...asArray(p['grantedToIdentitiesV2'])].filter(
      (o) => Object.keys(o).length > 0,
    );
    for (const ident of candidates) {
      const user = asRecord(ident['user']);
      const group = asRecord(ident['group']);
      if (typeof user['id'] === 'string') {
        principals.push({ kind: 'user', id: user['id'] as string, ...(typeof user['email'] === 'string' ? { email: user['email'] as string } : {}) });
      } else if (typeof group['id'] === 'string') {
        principals.push({ kind: 'group', id: group['id'] as string });
      }
    }
  }
  if (principals.length === 0) {
    return { mode: 'open' };
  }
  return { mode: 'restricted', principals };
}

export class SharePointGraphAdapter implements ConnectorPort {
  readonly provider = 'sharepoint';

  async fetchUpdates(input: {
    config: Record<string, unknown>;
    credentials?: string;
    cursor: Record<string, unknown>;
    maxDocuments: number;
  }): Promise<ConnectorFetchResult> {
    if (!input.credentials) {
      throw new Error('sharepoint sync requires a configured Entra app (client credentials on the account)');
    }
    const headers = bearer(input.credentials);
    const driveId = str(input.config['drive_id']);
    if (!driveId) {
      throw new Error('connector config.drive_id is required (SharePoint document library drive id)');
    }
    const documents: ConnectorDocument[] = [];
    const skipped: Array<{ externalId: string; title: string; reason: string }> = [];
    const deletedExternalIds: string[] = [];
    const deltaLink = typeof input.cursor['deltaLink'] === 'string' ? (input.cursor['deltaLink'] as string) : null;
    let url: string | null =
      deltaLink ?? `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(driveId)}/root/delta?$select=id,name,file,folder,deleted,lastModifiedDateTime`;
    let pages = 0;
    let nextDeltaLink: string | null = deltaLink;
    let truncated = false;
    for (;;) {
      if (pages++ >= MAX_PAGES || documents.length + skipped.length >= input.maxDocuments) {
        truncated = true;
        break;
      }
      if (!url) {
        break;
      }
      const page = await fetchJsonBounded<{ value?: unknown[]; '@odata.nextLink'?: string; '@odata.deltaLink'?: string }>(url, { headers });
      for (const item of asArray(page.value)) {
        const id = str(item['id']);
        if (!id) {
          continue;
        }
        if (item['deleted'] !== undefined || item['folder'] !== undefined) {
          if (item['deleted'] !== undefined) {
            deletedExternalIds.push(id);
          }
          continue;
        }
        if (documents.length + skipped.length >= input.maxDocuments) {
          truncated = true;
          break;
        }
        const name = str(item['name']) || id;
        const mime = str(asRecord(item['file'])['mimeType']);
        try {
          if (!GRAPH_TEXT_MIMES.has(mime) && mime !== 'application/pdf') {
            skipped.push({ externalId: id, title: name, reason: `unsupported_mime:${mime || 'unknown'}` });
            continue;
          }
          const perms = await fetchJsonBounded<{ value?: unknown[] }>(
            `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(id)}/permissions?$select=roles,grantedToV2,grantedTo,link`,
            { headers },
          );
          if (mime === 'application/pdf' || mime.startsWith('image/')) {
            const dl = await fetchBounded(`https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(id)}/content`, headers, {
              maxBytes: 5 * 1024 * 1024,
            });
            const b64 = Buffer.from(await dl.arrayBuffer()).toString('base64');
            documents.push({
              externalId: id,
              title: name,
              mediaType: mime,
              content: '',
              contentBytesB64: b64,
              acl: graphPermissionToAcl(asArray(perms.value) as unknown as GraphPermission[]),
            });
          } else {
            const text = await fetchTextBounded(
              `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(id)}/content`,
              { headers },
            );
            documents.push({ externalId: id, title: name, mediaType: mime, content: text, acl: graphPermissionToAcl(asArray(perms.value) as unknown as GraphPermission[]) });
          }
        } catch (err) {
          skipped.push({ externalId: id, title: name, reason: `fetch_failed:${(err as Error).message.slice(0, 120)}` });
        }
      }
      if (typeof page['@odata.nextLink'] === 'string') {
        url = page['@odata.nextLink'] as string;
        continue;
      }
      if (typeof page['@odata.deltaLink'] === 'string') {
        nextDeltaLink = page['@odata.deltaLink'] as string;
      }
      break;
    }
    return { documents, nextCursor: { deltaLink: nextDeltaLink }, truncated, deletedExternalIds, skipped };
  }

  private async downloadBytes(url: string, headers: Record<string, string>): Promise<Buffer> {
    const { fetchBounded } = await import('./connector-http');
    const res = await fetchBounded(url, { headers }, { maxBytes: 5 * 1024 * 1024 });
    return Buffer.from(await res.arrayBuffer());
  }
}

// ── Confluence Cloud (static email+API token) ────────────────────────────

export function confluenceRestrictionToAcl(restrictions: unknown): ConnectorDocument['acl'] {
  const ops = asRecord(asRecord(restrictions)['read']);
  const users = asArray(ops['restrictions'] ?? ops['userResults'] ?? []);
  void users;
  const flat = asArray(ops['userResults']).length > 0 ? asArray(ops['userResults']) : asArray(ops['groupResults']);
  void flat;
  return confluenceAcls(asRecord(restrictions));
}

function confluenceAcls(restrictions: Record<string, unknown>): ConnectorDocument['acl'] {
  const read = asRecord(restrictions['read']);
  const userResults = asArray(read['userResults'] ?? read['restrictions']);
  const groupResults = asArray(read['groupResults']);
  const principals: SourcePrincipal[] = [];
  for (const u of userResults) {
    const accountId = str(u['accountId'] ?? u['account_id'] ?? u['key']);
    if (accountId) {
      principals.push({ kind: 'user', id: accountId, ...(typeof u['email'] === 'string' ? { email: u['email'] as string } : {}) });
    }
  }
  for (const g of groupResults) {
    const name = str(g['name'] ?? g['id']);
    if (name) {
      principals.push({ kind: 'group', id: name });
    }
  }
  if (principals.length === 0) {
    return { mode: 'open' };
  }
  return { mode: 'restricted', principals };
}

function confluenceAuth(secret: string): Record<string, string> {
  // Stored static secret is "email:api_token" (documented at link time).
  const idx = secret.indexOf(':');
  const email = idx === -1 ? '' : secret.slice(0, idx);
  const token = idx === -1 ? secret : secret.slice(idx + 1);
  return { authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}` };
}

export class ConfluenceAdapter implements ConnectorPort {
  readonly provider = 'confluence';

  async fetchUpdates(input: {
    config: Record<string, unknown>;
    credentials?: string;
    cursor: Record<string, unknown>;
    maxDocuments: number;
  }): Promise<ConnectorFetchResult> {
    const baseUrl = str(input.config['base_url']).replace(/\/$/, '');
    if (!baseUrl) {
      throw new Error('connector config.base_url is required (https://<site>.atlassian.net/wiki)');
    }
    if (!input.credentials) {
      throw new Error('confluence sync requires stored credentials ("email:api_token")');
    }
    const headers = confluenceAuth(input.credentials);
    const spaces = asArray(input.config['spaces']).map((s) => str(s['key'] ?? s)).filter(Boolean);
    const spaceCql = spaces.length > 0 ? ` AND space in (${spaces.map((s) => `"${s.replace(/"/g, '')}"`).join(',')})` : '';
    const documents: ConnectorDocument[] = [];
    const skipped: Array<{ externalId: string; title: string; reason: string }> = [];
    const seen: string[] = Array.isArray(input.cursor['seen']) ? (input.cursor['seen'] as string[]) : [];
    const nextSeen: string[] = [];
    let start = 0;
    let truncated = false;
    for (;;) {
      if (documents.length + skipped.length >= input.maxDocuments) {
        truncated = true;
        break;
      }
      const params = new URLSearchParams({
        cql: `type = page AND status = current${spaceCql} ORDER BY version DESC`,
        start: String(start),
        limit: '25',
        expand: 'body.storage,version',
      });
      const page = await fetchJsonBounded<{ results?: unknown[]; size?: number }>(`${baseUrl}/rest/api/content/search?${params.toString()}`, { headers });
      const results = asArray(page.results);
      if (results.length === 0) {
        break;
      }
      for (const item of results) {
        const id = str(item['id']);
        if (!id) {
          continue;
        }
        nextSeen.push(id);
        const title = str(item['title']) || id;
        const storage = str(asRecord(asRecord(item['body'])['storage'])['value']);
        let acl: ConnectorDocument['acl'] = { mode: 'open' };
        try {
          const restr = await fetchJsonBounded<unknown>(`${baseUrl}/rest/api/content/${encodeURIComponent(id)}/restriction/byOperation/read`, { headers });
          acl = confluenceRestrictionToAcl(restr);
        } catch {
          acl = { mode: 'restricted', principals: [] };
        }
        if (storage.trim().length === 0) {
          skipped.push({ externalId: id, title, reason: 'empty_content' });
          continue;
        }
        documents.push({ externalId: id, title, mediaType: 'text/plain', content: stripHtmlToText(storage), acl });
        if (documents.length + skipped.length >= input.maxDocuments) {
          truncated = true;
          break;
        }
      }
      start += results.length;
      if (results.length < 25 || nextSeen.length >= 2000) {
        break;
      }
    }
    // Deletes: ids seen last sync but absent now (bounded cursor).
    const deletedExternalIds = seen.filter((id) => !nextSeen.includes(id));
    return { documents, nextCursor: { seen: nextSeen.slice(0, 2000) }, truncated, deletedExternalIds, skipped };
  }
}

// ── Notion (static internal integration token) ──────────────────────────

const NOTION_VERSION = '2022-06-28';

function notionHeaders(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}`, 'Notion-Version': NOTION_VERSION, 'content-type': 'application/json' };
}

export function notionBlocksToText(blocks: Array<Record<string, unknown>>, depth = 0): string {
  if (depth > 3) {
    return '';
  }
  const parts: string[] = [];
  for (const b of blocks) {
    const type = str(b['type']);
    const data = asRecord(b[type]);
    const rich = asArray(data['rich_text'])
      .map((t) => str(asRecord(t)['plain_text']))
      .join('');
    if (['paragraph', 'heading_1', 'heading_2', 'heading_3', 'bulleted_list_item', 'numbered_list_item', 'to_do', 'toggle', 'quote', 'callout', 'code'].includes(type)) {
      const codeLang = type === 'code' ? `\n\`\`\`${str(data['language'])}\n` : '';
      const codeEnd = type === 'code' ? '\n```' : '';
      if (rich.trim()) {
        parts.push(`${codeLang}${rich}${codeEnd}`);
      }
    }
    if (b['has_children'] === true && Array.isArray((b as Record<string, unknown>)['children'])) {
      parts.push(notionBlocksToText(asArray((b as Record<string, unknown>)['children']), depth + 1));
    }
  }
  return parts.join('\n\n');
}

export function notionPageTitle(page: Record<string, unknown>): string {
  const props = asRecord(page['properties']);
  for (const value of Object.values(props)) {
    const prop = asRecord(value);
    if (prop['type'] === 'title') {
      const text = asArray(prop['title'])
        .map((t) => str(asRecord(t)['plain_text']))
        .join('');
      if (text.trim()) {
        return text;
      }
    }
  }
  return str(page['id']) || 'untitled';
}

export class NotionAdapter implements ConnectorPort {
  readonly provider = 'notion';

  async fetchUpdates(input: {
    config: Record<string, unknown>;
    credentials?: string;
    cursor: Record<string, unknown>;
    maxDocuments: number;
  }): Promise<ConnectorFetchResult> {
    if (!input.credentials) {
      throw new Error('notion sync requires a stored internal integration token');
    }
    const headers = notionHeaders(input.credentials);
    const documents: ConnectorDocument[] = [];
    const skipped: Array<{ externalId: string; title: string; reason: string }> = [];
    const seen: string[] = Array.isArray(input.cursor['seen']) ? (input.cursor['seen'] as string[]) : [];
    const nextSeen: string[] = [];
    let startCursor: string | null = typeof input.cursor['start_cursor'] === 'string' ? (input.cursor['start_cursor'] as string) : null;
    let truncated = false;
    for (;;) {
      if (documents.length + skipped.length >= input.maxDocuments) {
        truncated = true;
        break;
      }
      const body: Record<string, unknown> = {
        filter: { property: 'object', value: 'page' },
        sort: { direction: 'descending', timestamp: 'last_edited_time' },
        page_size: 25,
        ...(startCursor ? { start_cursor: startCursor } : {}),
      };
      const page = await fetchJsonBounded<{ results?: unknown[]; has_more?: boolean; next_cursor?: string | null }>('https://api.notion.com/v1/search', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      const results = asArray(page.results);
      if (results.length === 0) {
        break;
      }
      for (const item of results) {
        const id = str(item['id']);
        if (!id) {
          continue;
        }
        nextSeen.push(id);
        if (item['archived'] === true) {
          continue;
        }
        if (documents.length + skipped.length >= input.maxDocuments) {
          truncated = true;
          break;
        }
        const title = notionPageTitle(item);
        try {
          const text = await this.readBlocks(headers, id);
          if (!text.trim()) {
            skipped.push({ externalId: id, title, reason: 'empty_content' });
            continue;
          }
          // Notion exposes no per-page ACL over the API — the integration
          // token's workspace scope governs. Recorded open + documented.
          documents.push({ externalId: id, title, mediaType: 'text/plain', content: text, acl: { mode: 'open' } });
        } catch (err) {
          skipped.push({ externalId: id, title, reason: `fetch_failed:${(err as Error).message.slice(0, 120)}` });
        }
      }
      if (page.has_more === true && typeof page.next_cursor === 'string') {
        startCursor = page.next_cursor;
        if (nextSeen.length >= 2000) {
          truncated = true;
          break;
        }
        continue;
      }
      break;
    }
    const deletedExternalIds = seen.filter((id) => !nextSeen.includes(id));
    return { documents, nextCursor: { seen: nextSeen.slice(0, 2000), start_cursor: truncated ? startCursor : null }, truncated, deletedExternalIds, skipped };
  }

  private async readBlocks(headers: Record<string, string>, pageId: string, depth = 0): Promise<string> {
    if (depth > 2) {
      return '';
    }
    const parts: string[] = [];
    let cursor: string | null = null;
    let params: URLSearchParams | undefined;
    let res: { results?: unknown[]; has_more?: boolean; next_cursor?: string | null } | undefined;
    for (let page = 0; page < 10; page++) {
      params = new URLSearchParams();
      params.set('page_size', '100');
      if (cursor) {
        params.set('start_cursor', cursor);
      }
      res = await fetchJsonBounded<{ results?: unknown[]; has_more?: boolean; next_cursor?: string | null }>(
        `https://api.notion.com/v1/blocks/${encodeURIComponent(pageId)}/children?${params.toString()}`,
        { headers },
      );
      const blocks = asArray(res.results);
      const enriched: Array<Record<string, unknown>> = [];
      for (const b of blocks) {
        if (b['has_children'] === true && depth < 2) {
          enriched.push({ ...b, children: await this.readChildBlocks(headers, str(b['id']), depth + 1) });
        } else {
          enriched.push(b);
        }
      }
      parts.push(notionBlocksToText(enriched, depth));
      if (res.has_more === true && typeof res.next_cursor === 'string') {
        cursor = res.next_cursor;
        continue;
      }
      break;
    }
    return parts.filter(Boolean).join('\n\n');
  }

  private async readChildBlocks(headers: Record<string, string>, blockId: string, depth: number): Promise<Array<Record<string, unknown>>> {
    if (!blockId) {
      return [];
    }
    const params = new URLSearchParams({ page_size: '50' });
    const res = await fetchJsonBounded<{ results?: unknown[] }>(`https://api.notion.com/v1/blocks/${encodeURIComponent(blockId)}/children?${params.toString()}`, {
      headers,
    });
    void depth;
    return asArray(res.results);
  }
}

// ── Zendesk Guide (static email/API token) ──────────────────────────────

export interface ZendeskArticle {
  id: number;
  title: string | null;
  body: string | null;
  draft: boolean;
  locale: string;
  updated_at: string;
  user_segment_id: number | null;
}

export function zendeskArticleToAcl(article: ZendeskArticle): ConnectorDocument['acl'] {
  if (article.user_segment_id === null || article.user_segment_id === undefined) {
    return { mode: 'open' };
  }
  return { mode: 'restricted', principals: [{ kind: 'group', id: `zendesk-segment-${article.user_segment_id}` }] };
}

function zendeskAuth(secret: string): Record<string, string> {
  // Stored static secret is "email/api_token".
  const idx = secret.indexOf('/');
  const email = idx === -1 ? '' : secret.slice(0, idx);
  const token = idx === -1 ? secret : secret.slice(idx + 1);
  return { authorization: `Basic ${Buffer.from(`${email}/token:${token}`).toString('base64')}` };
}

export class ZendeskAdapter implements ConnectorPort {
  readonly provider = 'zendesk';

  async fetchUpdates(input: {
    config: Record<string, unknown>;
    credentials?: string;
    cursor: Record<string, unknown>;
    maxDocuments: number;
  }): Promise<ConnectorFetchResult> {
    const subdomain = str(input.config['subdomain']);
    if (!subdomain) {
      throw new Error('connector config.subdomain is required (your Zendesk subdomain)');
    }
    if (!input.credentials) {
      throw new Error('zendesk sync requires stored credentials ("email/api_token")');
    }
    const headers = zendeskAuth(input.credentials);
    const locales = asArray(input.config['locales']).map((l) => str(l)).filter(Boolean);
    const base = `https://${encodeURIComponent(subdomain)}.zendesk.com/api/v2/help_center`;
    const documents: ConnectorDocument[] = [];
    const skipped: Array<{ externalId: string; title: string; reason: string }> = [];
    const seen: string[] = Array.isArray(input.cursor['seen_ids']) ? (input.cursor['seen_ids'] as string[]) : [];
    const nextSeen: string[] = [];
    let startTime = typeof input.cursor['start_time'] === 'number' ? (input.cursor['start_time'] as number) : 0;
    let endTime = startTime;
    let truncated = false;
    for (;;) {
      if (documents.length + skipped.length >= input.maxDocuments) {
        truncated = true;
        break;
      }
      const params = new URLSearchParams({ start_time: String(startTime), per_page: '100' });
      if (locales.length > 0) {
        params.set('locale', locales[0]);
      }
      const page = await fetchJsonBounded<{ articles?: unknown[]; end_time?: number }>(`${base}/incremental/articles.json?${params.toString()}`, { headers });
      const articles = asArray(page.articles) as unknown as ZendeskArticle[];
      if (articles.length === 0) {
        if (typeof page.end_time === 'number') {
          endTime = page.end_time;
        }
        break;
      }
      for (const a of articles) {
        const externalId = `article-${a.id}`;
        nextSeen.push(externalId);
        endTime = Math.max(endTime, Math.floor(Date.parse(a.updated_at) / 1000) || endTime);
        if (a.draft === true) {
          continue;
        }
        if (documents.length + skipped.length >= input.maxDocuments) {
          truncated = true;
          break;
        }
        const title = a.title ?? externalId;
        const body = a.body ?? '';
        if (!body.trim()) {
          skipped.push({ externalId, title, reason: 'empty_content' });
          continue;
        }
        documents.push({ externalId, title, mediaType: 'text/plain', content: stripHtmlToText(body), acl: zendeskArticleToAcl(a) });
      }
      if (typeof page.end_time === 'number') {
        startTime = page.end_time;
      } else {
        break;
      }
      if (nextSeen.length >= 5000) {
        truncated = true;
        break;
      }
    }
    const deletedExternalIds = seen.filter((id) => !nextSeen.includes(id));
    return { documents, nextCursor: { start_time: endTime, seen_ids: nextSeen.slice(0, 5000) }, truncated, deletedExternalIds, skipped };
  }
}

// ── Slack (static bot token) ────────────────────────────────────────────

export function slackFileToAcl(file: Record<string, unknown>): ConnectorDocument['acl'] {
  const shares = asRecord(file['shares']);
  const pub = asRecord(shares['public']);
  if (Object.keys(pub).length > 0) {
    return { mode: 'open' };
  }
  return { mode: 'restricted', principals: [] };
}

export class SlackAdapter implements ConnectorPort {
  readonly provider = 'slack';

  async fetchUpdates(input: {
    config: Record<string, unknown>;
    credentials?: string;
    cursor: Record<string, unknown>;
    maxDocuments: number;
  }): Promise<ConnectorFetchResult> {
    if (!input.credentials) {
      throw new Error('slack sync requires a stored bot token (xoxb-…)');
    }
    const headers = bearer(input.credentials);
    const types = str(input.config['file_types'] || 'text,pdf,docs');
    const documents: ConnectorDocument[] = [];
    const skipped: Array<{ externalId: string; title: string; reason: string }> = [];
    const seen: string[] = Array.isArray(input.cursor['seen_ids']) ? (input.cursor['seen_ids'] as string[]) : [];
    const nextSeen: string[] = [];
    const tsFrom = typeof input.cursor['ts_from'] === 'number' ? (input.cursor['ts_from'] as number) : 0;
    let page = 1;
    let latestTs = tsFrom;
    let truncated = false;
    for (;;) {
      if (documents.length + skipped.length >= input.maxDocuments || page > MAX_PAGES) {
        truncated = true;
        break;
      }
      const params: URLSearchParams = new URLSearchParams({ types, count: '100', page: String(page), ts_from: String(tsFrom) });
      const res: { ok?: boolean; error?: string; files?: unknown[]; paging?: { pages?: number } } = await fetchJsonBounded<{
        ok?: boolean;
        error?: string;
        files?: unknown[];
        paging?: { pages?: number };
      }>(
        `https://slack.com/api/files.list?${params.toString()}`,
        { headers },
      );
      if (res.ok !== true) {
        throw new Error(`slack files.list failed: ${str(res.error) || 'unknown'}`);
      }
      const files = asArray(res.files);
      if (files.length === 0) {
        break;
      }
      for (const f of files) {
        const id = str(f['id']);
        if (!id) {
          continue;
        }
        nextSeen.push(id);
        const ts = Number(f['timestamp'] ?? 0);
        if (Number.isFinite(ts) && ts > latestTs) {
          latestTs = ts;
        }
        const title = str(f['title'] ?? f['name']) || id;
        const mimetype = str(f['mimetype']);
        const downloadUrl = str(f['url_private_download']);
        if (!downloadUrl) {
          skipped.push({ externalId: id, title, reason: 'no_download_url' });
          continue;
        }
        if (documents.length + skipped.length >= input.maxDocuments) {
          truncated = true;
          break;
        }
        try {
          if (mimetype.startsWith('text/') || mimetype === 'application/json' || mimetype === 'text/markdown') {
            const text = await fetchTextBounded(downloadUrl, { headers });
            if (!text.trim()) {
              skipped.push({ externalId: id, title, reason: 'empty_content' });
              continue;
            }
            documents.push({ externalId: id, title, mediaType: mimetype, content: text, acl: slackFileToAcl(f) });
          } else if (mimetype === 'application/pdf' || mimetype.startsWith('image/')) {
            const { fetchBounded } = await import('./connector-http');
            const dl = await fetchBounded(downloadUrl, { headers }, { maxBytes: 5 * 1024 * 1024 });
            const b64 = Buffer.from(await dl.arrayBuffer()).toString('base64');
            documents.push({ externalId: id, title, mediaType: mimetype, content: '', contentBytesB64: b64, acl: slackFileToAcl(f) });
          } else {
            skipped.push({ externalId: id, title, reason: `unsupported_mime:${mimetype || 'unknown'}` });
          }
        } catch (err) {
          skipped.push({ externalId: id, title, reason: `fetch_failed:${(err as Error).message.slice(0, 120)}` });
        }
      }
      const totalPages = Number(asRecord(res.paging)['pages'] ?? 1);
      page += 1;
      if (page > totalPages) {
        break;
      }
      if (nextSeen.length >= 2000) {
        truncated = true;
        break;
      }
    }
    const deletedExternalIds = seen.filter((id) => !nextSeen.includes(id));
    return { documents, nextCursor: { ts_from: latestTs, seen_ids: nextSeen.slice(0, 2000) }, truncated, deletedExternalIds, skipped };
  }
}
