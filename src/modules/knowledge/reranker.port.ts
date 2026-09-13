import { Injectable, Logger } from '@nestjs/common';
import { env } from '../../common/config/env';
import { KnowledgeHit } from './retrieval.service';

/**
 * Reranker port (FL-2.1) — a cross-encoder stage over the fused candidate
 * list. DEFAULT OFF: the noop adapter passes candidates through unchanged, so
 * hybrid retrieval works with zero external dependencies. Production wires a
 * cross-encoder endpoint (e.g. bge-reranker / Cohere-style /v1/rerank shape)
 * behind HARNESS__RERANKER_PROVIDER=http; an unavailable reranker DEGRADES to
 * the fused RRF order (it may never drop or corrupt results).
 */
export interface RerankerPort {
  readonly provider: string;
  /** Returns the reranked, bounded list. Never returns fewer than 1 item for non-empty input. */
  rerank(query: string, hits: KnowledgeHit[], limit: number): Promise<KnowledgeHit[]>;
}

@Injectable()
export class NoopReranker implements RerankerPort {
  readonly provider = 'noop';

  async rerank(query: string, hits: KnowledgeHit[], limit: number): Promise<KnowledgeHit[]> {
    void query;
    return hits.slice(0, limit);
  }
}

export interface HttpRerankerOptions {
  url: string;
  apiKey?: string;
  timeoutMs: number;
}

/**
 * HTTP cross-encoder adapter. Contract (de-facto /v1/rerank shape):
 *   POST {query, documents: string[], top_n} → {results: [{index, score}]}
 * Per-document failure semantics: a malformed/failed response degrades to the
 * fused order (logged) — a reranker is a quality lever, never an availability
 * dependency.
 */
export class HttpReranker implements RerankerPort {
  private static readonly logger = new Logger(HttpReranker.name);
  readonly provider = 'http';

  constructor(private readonly opts: HttpRerankerOptions) {}

  async rerank(query: string, hits: KnowledgeHit[], limit: number): Promise<KnowledgeHit[]> {
    if (hits.length <= 1) {
      return hits.slice(0, limit);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    timer.unref();
    try {
      const res = await fetch(this.opts.url.replace(/\/$/, '') + '/v1/rerank', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
        },
        body: JSON.stringify({
          query,
          documents: hits.map((h) => h.text),
          top_n: limit,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`reranker HTTP ${res.status}`);
      }
      const body = (await res.json()) as { results?: Array<{ index?: number; score?: number }> };
      const results = body.results ?? [];
      const ranked: KnowledgeHit[] = [];
      const seen = new Set<number>();
      for (const r of results) {
        const idx = Number(r.index);
        if (!Number.isInteger(idx) || idx < 0 || idx >= hits.length || seen.has(idx)) {
          continue;
        }
        seen.add(idx);
        const hit = hits[idx]!;
        ranked.push({ ...hit, score: typeof r.score === 'number' ? r.score : hit.score });
      }
      // Any candidate the reranker dropped re-enters in fused order — never lost.
      for (let i = 0; i < hits.length && ranked.length < limit; i++) {
        if (!seen.has(i)) {
          ranked.push(hits[i]!);
        }
      }
      return ranked.slice(0, limit);
    } catch (err) {
      HttpReranker.logger.warn(`reranker degraded to fused order: ${(err as Error).message}`);
      return hits.slice(0, limit);
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface RerankerConfig {
  provider: 'noop' | 'http';
  url?: string;
  apiKey?: string;
  timeoutMs: number;
}

export function resolveReranker(cfg: RerankerConfig): RerankerPort {
  if (cfg.provider === 'http') {
    if (!cfg.url) {
      throw new Error('HARNESS__RERANKER_URL is required when HARNESS__RERANKER_PROVIDER=http');
    }
    return new HttpReranker({ url: cfg.url, apiKey: cfg.apiKey, timeoutMs: cfg.timeoutMs });
  }
  return new NoopReranker();
}

/**
 * DI-facing reranker service — resolves the provider from typed env once at
 * boot. Misconfiguration (provider=http without a URL) is a loud boot
 * failure, never a runtime surprise.
 */
@Injectable()
export class RerankerService implements RerankerPort {
  private readonly inner: RerankerPort;
  readonly provider: string;

  constructor() {
    const inner = resolveReranker({
      provider: env.HARNESS__RERANKER_PROVIDER,
      url: env.HARNESS__RERANKER_URL || undefined,
      apiKey: env.HARNESS__RERANKER_API_KEY || undefined,
      timeoutMs: env.HARNESS__RERANKER_TIMEOUT_MS,
    });
    this.inner = inner;
    this.provider = inner.provider;
  }

  rerank(query: string, hits: KnowledgeHit[], limit: number): Promise<KnowledgeHit[]> {
    return this.inner.rerank(query, hits, limit);
  }
}
