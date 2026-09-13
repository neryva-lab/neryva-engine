import { Injectable, Logger } from '@nestjs/common';
import { env } from '../../common/config/env';

/**
 * FL-3.7 — query rewriting port (multi-query expansion / HyDE-class).
 *
 * `expand(query)` returns up to MAX_VARIANTS alternative phrasings of the
 * user's query; hybrid retrieval runs an extra FTS (and bounded vector) leg
 * per variant and fuses everything with RRF. The default (URL unset) is the
 * identity — one variant, zero extra cost. Any port failure DEGRADES to the
 * original query: rewriting is a quality lever, never an availability
 * dependency (same contract as the reranker port).
 *
 * Budget interplay (FL-1.2): the expansion call happens OUTSIDE the run's
 * token budget on the Engine side — the endpoint is an org-configured
 * internal service. Per-variant embeddings are billed by the embedding
 * provider; MAX_VARIANTS bounds the amplification to 4x worst case.
 */
export const MAX_VARIANTS = 4;

@Injectable()
export class QueryRewriteService {
  private static readonly logger = new Logger(QueryRewriteService.name);

  async expand(query: string): Promise<string[]> {
    const url = env.HARNESS__QUERY_REWRITE_URL;
    if (!url) {
      return [query];
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), env.HARNESS__QUERY_REWRITE_TIMEOUT_MS);
    timer.unref();
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, max_variants: MAX_VARIANTS - 1 }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`query rewrite endpoint returned ${res.status}`);
      }
      const body = (await res.json()) as { queries?: unknown };
      if (!Array.isArray(body.queries)) {
        throw new Error('query rewrite payload malformed');
      }
      const variants = body.queries
        .filter((q): q is string => typeof q === 'string')
        .map((q) => q.trim())
        .filter((q) => q.length > 0 && q.length <= 512)
        .slice(0, MAX_VARIANTS - 1);
      return [query, ...variants];
    } catch (err) {
      // Degrade loudly-but-gracefully: log the failure (never the query), serve the original.
      QueryRewriteService.logger.warn(`query rewrite degraded to identity: ${(err as Error).message}`);
      return [query];
    } finally {
      clearTimeout(timer);
    }
  }
}
