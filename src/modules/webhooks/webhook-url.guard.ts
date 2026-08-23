import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Logger } from '@nestjs/common';
import { env, isProduction } from '../../common/config/env';

/**
 * SSRF protection for customer webhook targets (the class of attack where
 * a tenant points a webhook at the platform's own internals — metadata
 * services, localhost admin ports, private ranges).
 *
 * Validation at CREATE/UPDATE time (and re-checked at delivery for DNS
 * drift): protocol must be https in production (http allowed in dev for
 * local testing), the host must RESOLVE to public addresses only — every
 * A/AAAA record is checked against the blocked ranges. Lookups are cached
 * (60s positive / 10s negative) so the delivery hot path stays cheap.
 */
const logger = new Logger('WebhookUrlGuard');

const BLOCKED_V4_CIDRS: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local / cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved
];

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p) || p < 0 || p > 255)) {
    return -1;
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function ipv4Blocked(ip: string): boolean {
  const value = ipv4ToInt(ip);
  if (value < 0) {
    return true;
  }
  return BLOCKED_V4_CIDRS.some(([base, bits]) => {
    const baseValue = ipv4ToInt(base);
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) === (baseValue & mask);
  });
}

function ipv6Blocked(ip: string): boolean {
  const normalized = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === '::' || normalized === '::1') {
    return true; // unspecified + loopback
  }
  if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) {
    return true; // link-local fe80::/10
  }
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) {
    return true; // unique-local fc00::/7
  }
  if (normalized.startsWith('ff')) {
    return true; // multicast
  }
  // IPv4-mapped (::ffff:a.b.c.d) — reduce to the v4 check.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped) {
    return ipv4Blocked(mapped[1]);
  }
  return false;
}

export function ipBlocked(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    return ipv4Blocked(ip);
  }
  if (family === 6) {
    return ipv6Blocked(ip);
  }
  return true; // not an IP we understand — refuse
}

const cache = new Map<string, { ok: boolean; at: number }>();
const POSITIVE_TTL_MS = 60_000;
const NEGATIVE_TTL_MS = 10_000;

export interface UrlCheckResult {
  ok: boolean;
  reason?: string;
}

/** Parse + protocol + host-resolution check. Async (DNS). */
export async function checkWebhookUrl(rawUrl: string): Promise<UrlCheckResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'malformed URL' };
  }
  if (url.protocol !== 'https:' && (isProduction || url.protocol !== 'http:')) {
    return { ok: false, reason: 'https required' };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'credentials in URL are not allowed' };
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  // Literal IPs skip DNS; hostnames resolve and every record is checked.
  const family = isIP(host);
  if (family !== 0) {
    return ipBlocked(host) ? { ok: false, reason: 'target address is in a blocked range' } : { ok: true };
  }

  const cached = cache.get(host);
  if (cached) {
    const ttl = cached.ok ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS;
    if (Date.now() - cached.at < ttl) {
      return cached.ok ? { ok: true } : { ok: false, reason: 'target resolves to a blocked address' };
    }
  }
  try {
    const records = await lookup(host, { all: true, verbatim: true });
    if (records.length === 0) {
      cache.set(host, { ok: false, at: Date.now() });
      return { ok: false, reason: 'host does not resolve' };
    }
    const blocked = records.some((record) => ipBlocked(record.address));
    cache.set(host, { ok: !blocked, at: Date.now() });
    return blocked ? { ok: false, reason: 'target resolves to a blocked address' } : { ok: true };
  } catch (err) {
    logger.warn(`webhook host lookup failed for ${host}: ${(err as Error).message}`);
    cache.set(host, { ok: false, at: Date.now() });
    return { ok: false, reason: 'host does not resolve' };
  }
}
