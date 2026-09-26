import { createHash } from 'node:crypto';
import { EMBEDDING_DIMENSIONS } from '../schema';
import type {
  ISearchBackend,
  SearchBackendKind,
  SearchVector,
  VectorHit,
  VectorLegQuery,
} from './search-backend';

/**
 * Qdrant search backend (P4) — vector search via a Qdrant sidecar over
 * plain HTTP (global `fetch`; no SDK dependency).
 *
 * Layout: ONE shared collection (`neryva_knowledge_chunks`) for all
 * tenants, with per-point payload `{org_id, model, chunk_id}`. Every query
 * carries an exact-match payload filter on all three — the tenant boundary
 * is enforced by the filter, never by collection naming. Point IDs are
 * deterministic UUIDs derived from `(chunkId, model)` so upserts are
 * idempotent and replays converge.
 *
 * Score contract: Qdrant returns cosine similarity as the score for
 * `Cosine` distance (higher = more similar). It is passed through
 * unchanged. Cross-backend score VALUES are not directly comparable, but
 * rank order is — and rank order is what the service's RRF fusion
 * consumes.
 *
 * `onBoot` creates the collection when missing and VERIFIES the vector
 * size of an existing collection (a dimension mismatch throws loudly
 * rather than indexing into a wrong-shaped collection).
 */
export class QdrantSearchBackend implements ISearchBackend {
  readonly backendKind: SearchBackendKind = 'qdrant';
  readonly requiresSidecarSync = true;

  static readonly COLLECTION = 'neryva_knowledge_chunks';
  static readonly VECTOR_SIZE = EMBEDDING_DIMENSIONS;
  private static readonly REQUEST_TIMEOUT_MS = 5000;

  constructor(private readonly qdrantUrl: string) {}

  private get baseUrl(): string {
    return this.qdrantUrl.replace(/\/+$/, '');
  }

  private async request(
    method: 'GET' | 'PUT' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(QdrantSearchBackend.REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(
        `qdrant request failed: ${method} ${path}: ${(err as Error).message}`,
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `qdrant request failed: ${method} ${path} → ${res.status} ${text.slice(0, 200)}`,
      );
    }
    if (res.status === 204) return null;
    return (await res.json().catch(() => null)) as unknown;
  }

  async onBoot(): Promise<void> {
    const name = QdrantSearchBackend.COLLECTION;
    const existing = (await this.request('GET', `/collections/${name}`).catch(
      (err: Error) => {
        if (err.message.includes('→ 404')) return null;
        throw err;
      },
    )) as { result?: { config?: { params?: { vectors?: { size?: number } } } } } | null;
    if (existing === null) {
      await this.request('PUT', `/collections/${name}`, {
        vectors: { size: QdrantSearchBackend.VECTOR_SIZE, distance: 'Cosine' },
        hnsw_config: { m: 16, ef_construct: 100 },
      });
      return;
    }
    const size = existing?.result?.config?.params?.vectors?.size;
    if (size !== undefined && size !== QdrantSearchBackend.VECTOR_SIZE) {
      throw new Error(
        `qdrant collection ${name} has vector size ${size} but the engine embeds ` +
          `${QdrantSearchBackend.VECTOR_SIZE} dimensions — refusing to index into a ` +
          'wrong-shaped collection',
      );
    }
  }

  /**
   * Deterministic point UUID for (chunkId, model) — upserts converge.
   *
   * `orgId` is deliberately NOT part of the point identity: chunk IDs are
   * uuidv7 (globally unique across orgs), so (chunkId, model) is already a
   * global key, and every read path filters on the `org_id` payload field
   * anyway. Adding orgId would only create unmigratable aliases if a chunk
   * were ever re-owned.
   */
  static pointId(chunkId: string, model: string): string {
    const hash = createHash('sha256').update(`${chunkId}:${model}`, 'utf8').digest();
    hash[6] = (hash[6] & 0x0f) | 0x40;
    hash[8] = (hash[8] & 0x3f) | 0x80;
    const hex = hash.toString('hex');
    return (
      `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
      `${hex.slice(16, 20)}-${hex.slice(20, 32)}`
    );
  }

  private filter(
    orgId: string,
    model: string | undefined,
    chunkIds: string[] | undefined,
  ): Record<string, unknown> {
    const must: Array<Record<string, unknown>> = [
      { key: 'org_id', match: { value: orgId } },
    ];
    if (model !== undefined) {
      must.push({ key: 'model', match: { value: model } });
    }
    if (chunkIds !== undefined) {
      must.push({ key: 'chunk_id', match: { any: chunkIds } });
    }
    return { must };
  }

  async upsertVectors(input: {
    orgId: string;
    model: string;
    vectors: SearchVector[];
  }): Promise<void> {
    if (input.vectors.length === 0) return;
    for (const v of input.vectors) {
      if (v.vector.length !== QdrantSearchBackend.VECTOR_SIZE) {
        throw new Error(
          `qdrant upsert: vector for chunk ${v.chunkId} has ${v.vector.length} dimensions, ` +
            `expected ${QdrantSearchBackend.VECTOR_SIZE}`,
        );
      }
    }
    // wait=true: the drain reports success only once the points are
    // searchable — without it a retrieval in the next millisecond could
    // miss just-indexed chunks (Qdrant's default is async application).
    await this.request(
      'PUT',
      `/collections/${QdrantSearchBackend.COLLECTION}/points?wait=true`,
      {
        points: input.vectors.map((v) => ({
          id: QdrantSearchBackend.pointId(v.chunkId, input.model),
          vector: v.vector,
          payload: { org_id: input.orgId, model: input.model, chunk_id: v.chunkId },
        })),
      },
    );
  }

  async deleteVectorsForChunks(input: {
    orgId: string;
    chunkIds: string[];
    model?: string;
  }): Promise<void> {
    if (input.chunkIds.length === 0) return;
    // wait=true: same read-after-write visibility guarantee as upsert.
    await this.request(
      'POST',
      `/collections/${QdrantSearchBackend.COLLECTION}/points/delete?wait=true`,
      { filter: this.filter(input.orgId, input.model, input.chunkIds) },
    );
  }

  async runVectorLeg(query: VectorLegQuery): Promise<VectorHit[]> {
    if (query.vector.length === 0) {
      throw new Error('runVectorLeg: vector must be non-empty');
    }
    if (query.vector.length !== QdrantSearchBackend.VECTOR_SIZE) {
      throw new Error(
        `runVectorLeg: query vector has ${query.vector.length} dimensions, ` +
          `expected ${QdrantSearchBackend.VECTOR_SIZE}`,
      );
    }
    if (query.topK <= 0) {
      return [];
    }
    const candidateChunkIds = query.candidateChunkIds;
    if (!candidateChunkIds) {
      throw new Error(
        'runVectorLeg: candidateChunkIds is required for the qdrant backend — ' +
          'the admitted chunk set must be pre-computed by the caller',
      );
    }
    if (candidateChunkIds.length === 0) {
      return [];
    }
    const res = (await this.request(
      'POST',
      `/collections/${QdrantSearchBackend.COLLECTION}/points/search`,
      {
        vector: query.vector,
        limit: query.topK,
        with_payload: ['chunk_id'],
        with_vector: false,
        filter: this.filter(query.orgId, query.model, candidateChunkIds),
      },
    )) as { result?: Array<{ score: number; payload?: { chunk_id?: unknown } }> };
    const hits: VectorHit[] = [];
    for (const r of res.result ?? []) {
      const chunkId = r.payload?.chunk_id;
      if (typeof chunkId !== 'string') continue;
      hits.push({ chunkId, score: Number(r.score) });
    }
    return hits;
  }
}

/**
 * Boot-time reachability probe for QDRANT_URL. Never throws — returns the
 * outcome for the resolver, which fails closed with the detail.
 */
export async function probeQdrant(
  qdrantUrl: string,
  timeoutMs = 3000,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${qdrantUrl.replace(/\/+$/, '')}/`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      return { ok: false, error: `GET / → ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
