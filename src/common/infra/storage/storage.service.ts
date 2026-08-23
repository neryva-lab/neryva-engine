import { createHash, createHmac } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { env } from '../../config/env';

/**
 * S3-compatible object storage with presigned uploads/downloads (ADR-008):
 * S3, MinIO, Cloudflare R2 — anything speaking SigV4. Two real mechanisms,
 * nothing invented:
 *
 *  - UPLOAD: policy-based presigned POST (the documented browser-upload
 *    flow). The base64 policy binds bucket, exact key, exact Content-Type
 *    AND a content-length-range — S3 enforces the size window at upload,
 *    which presigned PUT cannot do. Clients multipart-POST `fields` plus
 *    the file as the final form part; the engine never proxies bytes.
 *  - DOWNLOAD: presigned GET with response-content-type/disposition
 *    overrides, time-limited to the minute-scale TTL.
 *
 * Availability: configured exactly when S3_BUCKET + S3_REGION + keys are
 * set. Optional-by-design — presign callers degrade loudly (503) instead of
 * ever failing boot.
 */
@Injectable()
export class StorageService {
  private static readonly logger = new Logger(StorageService.name);

  get available(): boolean {
    return Boolean(env.S3_BUCKET && env.S3_REGION && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY);
  }

  /** Assert configured — controllers translate this into a clean 503. */
  requireAvailable(): void {
    if (!this.available) {
      StorageService.logger.error('object storage requested but S3_* env is not configured');
      throw new Error('object storage is not configured (S3_BUCKET/S3_REGION/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY)');
    }
  }

  /**
   * Presign a direct upload. Returns the POST endpoint and the exact form
   * fields the client must send (file last). `sizeRange` is enforced by the
   * storage service itself via the policy's content-length-range condition.
   */
  presignUpload(input: {
    key: string;
    contentType: string;
    sizeRange?: { min: number; max: number };
    expiresIn?: number;
  }): { url: string; fields: Record<string, string>; expiresIn: number } {
    this.requireAvailable();
    const expiresIn = clamp(input.expiresIn ?? 300, 60, 3600);
    const { amzDate, scope, signingKey } = this.signingMaterial();

    const conditions: unknown[] = [
      { bucket: env.S3_BUCKET },
      { key: input.key },
      { 'Content-Type': input.contentType },
    ];
    if (input.sizeRange) {
      conditions.push(['content-length-range', String(input.sizeRange.min), String(input.sizeRange.max)]);
    }
    const policy = Buffer.from(
      JSON.stringify({
        expiration: new Date(Date.now() + expiresIn * 1000).toISOString(),
        conditions,
      }),
      'utf8',
    ).toString('base64');

    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, createHash('sha256').update(policy).digest('hex')].join('\n');
    const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

    return {
      url: this.postEndpoint(),
      fields: {
        key: input.key,
        'Content-Type': input.contentType,
        policy,
        'x-amz-algorithm': 'AWS4-HMAC-SHA256',
        'x-amz-credential': `${env.S3_ACCESS_KEY_ID}/${scope}`,
        'x-amz-date': amzDate,
        'x-amz-signature': signature,
      },
      expiresIn,
    };
  }

  /**
   * Presign a download (GET) — response content-type and content-disposition
   * can be overridden per download (e.g. force `attachment` with the
   * original filename) without changing stored state.
   */
  presignDownload(input: {
    key: string;
    expiresIn?: number;
    responseContentType?: string;
    responseContentDisposition?: string;
  }): { url: string; expiresIn: number } {
    this.requireAvailable();
    const expiresIn = clamp(input.expiresIn ?? 300, 60, 3600);
    const { amzDate, scope, signingKey } = this.signingMaterial();

    const url = new URL(this.objectUrl(input.key));
    const query = new Map<string, string>([
      ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
      ['X-Amz-Credential', `${env.S3_ACCESS_KEY_ID}/${scope}`],
      ['X-Amz-Date', amzDate],
      ['X-Amz-Expires', String(expiresIn)],
      ['X-Amz-SignedHeaders', 'host'],
      ...(input.responseContentType ? [['response-content-type', input.responseContentType] as const] : []),
      ...(input.responseContentDisposition ? [['response-content-disposition', input.responseContentDisposition] as const] : []),
    ]);
    const canonicalQuery = [...query.entries()]
      .map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`)
      .sort()
      .join('&');
    const canonicalRequest = ['GET', url.pathname, canonicalQuery, `host:${url.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n');
    const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

    return { url: `${url.origin}${url.pathname}?${canonicalQuery}&${uriEncode('X-Amz-Signature')}=${signature}`, expiresIn };
  }

  /**
   * Stable public URL for objects under a public-read prefix (CDN). Used
   * for genuinely public assets — blog cover images embedded in feeds,
   * where per-request signing is impossible.
   */
  publicUrl(key: string): string {
    if (!env.S3_PUBLIC_BASE_URL) {
      throw new Error('public object URLs require S3_PUBLIC_BASE_URL (CDN or public bucket base)');
    }
    return `${env.S3_PUBLIC_BASE_URL.replace(/\/$/, '')}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** Scope + binary signing key, from ONE clock read (date consistency). */
  private signingMaterial(): { amzDate: string; scope: string; signingKey: Buffer } {
    const now = new Date();
    const date = now.toISOString().slice(0, 10).replace(/-/g, '');
    const amzDate = `${date}T${now.toISOString().slice(11, 19).replace(/:/g, '')}Z`;
    const scope = `${date}/${env.S3_REGION}/s3/aws4_request`;
    // SigV4 key derivation chains BINARY HMAC outputs — hex anywhere in the
    // chain produces a wrong key that S3 rejects as a signature mismatch.
    const kDate = createHmac('sha256', `AWS4${env.S3_SECRET_ACCESS_KEY}`).update(date, 'utf8').digest();
    const kRegion = createHmac('sha256', kDate).update(env.S3_REGION, 'utf8').digest();
    const kService = createHmac('sha256', kRegion).update('s3', 'utf8').digest();
    const signingKey = createHmac('sha256', kService).update('aws4_request', 'utf8').digest();
    return { amzDate, scope, signingKey };
  }

  /** The URL object GETs address (path-style for MinIO/R2, virtual-host on AWS). */
  private objectUrl(key: string): string {
    const encodedKey = key.split('/').map(encodeURIComponent).join('/');
    if (env.S3_ENDPOINT) {
      const base = env.S3_ENDPOINT.replace(/\/$/, '');
      return env.S3_FORCE_PATH_STYLE ? `${base}/${env.S3_BUCKET}/${encodedKey}` : `${base}/${encodedKey}`;
    }
    return `https://${env.S3_BUCKET}.s3.${env.S3_REGION}.amazonaws.com/${encodedKey}`;
  }

  /** The endpoint presigned POSTs target (same addressing rules). */
  private postEndpoint(): string {
    if (env.S3_ENDPOINT) {
      const base = env.S3_ENDPOINT.replace(/\/$/, '');
      return env.S3_FORCE_PATH_STYLE ? `${base}/${env.S3_BUCKET}` : base;
    }
    return `https://${env.S3_BUCKET}.s3.${env.S3_REGION}.amazonaws.com`;
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** AWS URI encoding: RFC 3986 strict (unreserved only) for query parts. */
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
