/**
 * P0-1 — bounded outbound HTTP for connectors. Every source fetch goes
 * through here: abort timeout (no hung syncs), preflight content-length
 * guard, and a hard byte cap so a hostile source cannot OOM the worker.
 * Pure fetch wrapper — no Engine state, fully unit-testable via fetch stubs.
 */
export interface FetchBounds {
  timeoutMs?: number;
  maxBytes?: number;
}

export class ConnectorFetchError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

export async function fetchBounded(url: string, init: RequestInit = {}, bounds: FetchBounds = {}): Promise<Response> {
  const timeoutMs = bounds.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = bounds.maxBytes ?? DEFAULT_MAX_BYTES;
  const res = await fetch(url, { redirect: 'follow', ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    throw new ConnectorFetchError(`source fetch HTTP ${res.status} for ${url}`, res.status);
  }
  const declared = res.headers.get('content-length');
  if (declared !== null && Number.isFinite(Number(declared)) && Number(declared) > maxBytes) {
    throw new ConnectorFetchError(`source object exceeds byte cap (${declared} > ${maxBytes}) for ${url}`, 413);
  }
  return res;
}

export async function fetchTextBounded(url: string, init: RequestInit = {}, bounds: FetchBounds = {}): Promise<string> {
  const res = await fetchBounded(url, init, bounds);
  const text = await res.text();
  return text;
}

export async function fetchJsonBounded<T>(url: string, init: RequestInit = {}, bounds: FetchBounds = {}): Promise<T> {
  const res = await fetchBounded(url, init, bounds);
  return (await res.json()) as T;
}

/** Strip HTML to text content (script/style dropped, entities decoded, ws collapsed). */
export function stripHtmlToText(html: string, maxChars = 200_000): string {
  const text = html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>|<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, maxChars);
}
