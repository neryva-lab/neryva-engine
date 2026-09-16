import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';

/**
 * Rebuild a provider-readable request for oidc-provider passthrough.
 *
 * Fastify consumes the body stream of `application/x-www-form-urlencoded`
 * POSTs (e.g. `/auth/token`) before Nest handlers run, so the provider —
 * which reads the raw node stream itself — would see an empty body and
 * fail with `no client authentication mechanism provided`. When Fastify
 * already parsed a urlencoded body, re-serialize it onto a fresh stream
 * grafted onto the original request surface (headers/url/method/socket
 * untouched apart from content-length). Anything else (GETs, empty bodies,
 * non-urlencoded content) passes through verbatim.
 */
export function toProviderRequest(
  raw: Pick<IncomingMessage, 'headers' | 'method' | 'url' | 'socket'>,
  parsedBody: unknown,
): Pick<IncomingMessage, 'headers' | 'method' | 'url' | 'socket'> {
  const contentType = raw.headers['content-type'] ?? '';
  if (
    raw.method === undefined ||
    !['POST', 'PUT', 'PATCH'].includes(raw.method) ||
    !contentType.includes('application/x-www-form-urlencoded') ||
    parsedBody === null ||
    typeof parsedBody !== 'object' ||
    Array.isArray(parsedBody) ||
    Object.keys(parsedBody).length === 0
  ) {
    return raw;
  }
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsedBody as Record<string, unknown>)) {
    if (typeof value === 'string') {
      flat[key] = value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      flat[key] = String(value);
    }
    // Nested objects/arrays cannot occur in urlencoded forms — dropped
    // rather than silently mangled.
  }
  const encoded = new URLSearchParams(flat).toString();
  const stream = Readable.from([Buffer.from(encoded, 'utf8')]);
  const { 'transfer-encoding': _te, ...headers } = raw.headers;
  return Object.assign(stream, {
    headers: { ...headers, 'content-length': String(Buffer.byteLength(encoded)) },
    method: raw.method,
    url: raw.url,
    socket: raw.socket,
  });
}
