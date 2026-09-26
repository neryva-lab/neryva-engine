/**
 * Search-backend port (P4) — runtime-resolved vector search for selectable
 * persistence.
 *
 * The problem: pgvector serves the `postgres` lane, but the `mongodb` lane
 * has no single vector index. Rather than hard-coding one MongoDB search
 * backend (a D8 decision frozen at build time), the backend is resolved
 * AUTOMATICALLY at startup from `(DB_PROVIDER, connection topology, env
 * config)` — see `resolveSearchBackendKind`. The priority is:
 *
 *   1. `DB_PROVIDER=postgres`            → pgvector (native, in-database)
 *   2. `DB_PROVIDER=mongodb` + Atlas     → Atlas Vector Search (`$vectorSearch`)
 *   3. `DB_PROVIDER=mongodb` + QDRANT_URL→ Qdrant sidecar
 *   4. none of the above                 → FAIL CLOSED at boot. Never a
 *      silent lexical-only downgrade.
 *
 * What this port is and is not:
 * - It owns the VECTOR leg of hybrid retrieval: index maintenance
 *   (upsert/delete) plus one authorized similarity query (`runVectorLeg`).
 * - It does NOT own the lexical leg. Lexical execution is provider-native
 *   (pg `tsvector` / mongo `$text` / Atlas text search) and Qdrant is
 *   vector-only, so the lexical legs stay in the retrieval repositories.
 *   Hybrid COMPOSITION (Reciprocal Rank Fusion over vector + lexical legs)
 *   stays in `RetrievalService`, exactly as today — every backend plugs
 *   into the same fusion.
 * - Vectors arrive pre-computed (the service/workers embed); the backends
 *   never embed, never do network I/O except Qdrant's own HTTP calls.
 * - Score semantics are uniform: cosine similarity, higher = more similar,
 *   matching pgvector `1 - (embedding <=> query)`. Backends whose native
 *   score differs MUST map to this contract (documented per backend).
 *
 * Why no `runHybridQuery` on this port (deliberate): a hybrid method here
 * would have to own lexical execution too, but lexical is store-native
 * (pg tsvector / mongo $text) while Qdrant is vector-only — the Qdrant
 * backend would need to reach back into Mongo, inverting the layering,
 * and fusion (RRF) is domain logic that belongs in `RetrievalService`,
 * not in infrastructure. The existing seams already give the required
 * dependency rule: `RetrievalService` → `IRetrievalRepository` (port) →
 * `ISearchBackend` (port). No service or repository touches a concrete
 * driver or backend; only the DI factory resolves one.
 *
 * Tenant discipline: `orgId` is explicit on every method. Authorization-
 * before-scoring is load-bearing for the pgvector backend (the ACL
 * predicates join the scoring statement, byte-identical to the current leg
 * SQL). The Atlas/Qdrant backends cannot express cross-collection ACL
 * joins inside their index query, so they REQUIRE `candidateChunkIds` —
 * the caller (repository) pre-computes the admitted set and the backend
 * restricts the ANN query to it. Refusing to run without the admitted set
 * is deliberate: an unfiltered vector query would leak cross-tenant or
 * restricted chunks.
 */

export const SEARCH_BACKEND = Symbol('SEARCH_BACKEND');

/** The automatically resolved backend — also used for logs/health. */
export type SearchBackendKind = 'pgvector' | 'atlas-vector-search' | 'qdrant';

/** One chunk vector to index. */
export interface SearchVector {
  chunkId: string;
  vector: number[];
}

/**
 * One vector-leg hit. Cosine similarity (`1 - cosine distance`), higher =
 * more similar — the pgvector `1 - (embedding <=> query)` contract. The
 * port returns identity + score only; hydration (text, document, version)
 * is the calling repository's job from its admitted set.
 */
export interface VectorHit {
  chunkId: string;
  score: number;
}

/**
 * One vector leg query. `vector` is the pre-computed query embedding;
 * `model` is the embedding model (vector-space correctness — P0 BUG-1:
 * only rows embedded with this model may score).
 *
 * Authorization inputs (`versionIds`, `accountId`, `callerAccountId`,
 * `callerEmails`) are consumed by backends that can express them in-index
 * (pgvector: the full ACL predicate joins the scoring statement). Backends
 * backed by an external index (Atlas, Qdrant) REQUIRE `candidateChunkIds`
 * — the caller-precomputed admitted chunk set — and throw when it is
 * absent. The asymmetry is inherent (in-database join vs external index)
 * and explicit, not silent.
 */
export interface VectorLegQuery {
  orgId: string;
  vector: number[];
  model: string;
  topK: number;
  versionIds: string[] | null;
  accountId: string | null;
  callerAccountId: string | null;
  callerEmails: string[];
  candidateChunkIds?: string[];
}

export interface ISearchBackend {
  /** Stable discriminator for logs and health checks. */
  readonly backendKind: SearchBackendKind;

  /**
   * True when the backend maintains a vector index OUTSIDE the canonical
   * store (Qdrant). The repository layer then records durable
   * `search_index_outbox` intents in the SAME transaction as the canonical
   * embedding writes, and a sweeper replays them — crash-safe, replay-safe
   * sidecar indexing. False for backends whose index lives on the canonical
   * store (pgvector, Atlas): the store write IS the index write and no
   * outbox traffic is ever produced.
   */
  readonly requiresSidecarSync: boolean;

  /**
   * Optional idempotent boot-time preparation (e.g. create the Qdrant
   * collection). Called once by the DI factory after resolution. Default
   * implementations omit it.
   */
  onBoot?(): Promise<void>;

  /**
   * Index (upsert) chunk vectors for a model. Idempotent per
   * (chunkId, model) — safe to replay after a crash between the canonical
   * store write and the index sync.
   *
   * Backends whose index lives on the canonical store (pgvector: the
   * `embeddings` table; Atlas: the `embeddings` collection) implement this
   * as a documented no-op — the store write IS the index write.
   */
  upsertVectors(input: {
    orgId: string;
    model: string;
    vectors: SearchVector[];
  }): Promise<void>;

  /**
   * Delete indexed vectors for chunks. `model` narrows to one embedding
   * space (re-embed stale-model sweep); absent = all models for the chunks
   * (document delete / re-chunk). Same no-op rule as `upsertVectors`.
   */
  deleteVectorsForChunks(input: {
    orgId: string;
    chunkIds: string[];
    model?: string;
  }): Promise<void>;

  /**
   * Run ONE vector leg with authorization-before-scoring and return the
   * topK hits ordered by descending score. Never throws "no results" —
   * an empty admitted set yields an empty array.
   */
  runVectorLeg(query: VectorLegQuery): Promise<VectorHit[]>;
}

/**
 * Parse a pg `vector` SQL literal (`'[1,2,3]'`) into a number array.
 * Shared by repository lanes that receive pre-computed vectors as
 * literals and must hand domain `number[]` to the port.
 */
export function parseVectorLiteral(literal: string): number[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(literal);
  } catch {
    throw new Error('vectorLiteral must be a JSON array of numbers');
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every((n) => typeof n === 'number' && Number.isFinite(n))
  ) {
    throw new Error('vectorLiteral must be a non-empty array of finite numbers');
  }
  return parsed as number[];
}

/**
 * Atlas topology heuristic: the connection targets MongoDB Atlas.
 * Reliable signal is the host suffix — Atlas hosts always end with
 * `.mongodb.net`. A bare `mongodb+srv://` scheme alone is NOT enough
 * (self-hosted clusters can publish SRV records), so the host is checked
 * in both schemes.
 */
export function isAtlasTopology(mongoUri: string): boolean {
  const uri = mongoUri.trim().toLowerCase();
  const m = /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/:?]+)/.exec(uri);
  if (!m) return false;
  return m[1].endsWith('.mongodb.net');
}

export interface SearchBackendResolution {
  dbProvider: 'postgres' | 'mongodb';
  mongoUri?: string;
  qdrantUrl?: string;
  /** Result of probing QDRANT_URL at boot (ignored when qdrantUrl is unset). */
  qdrantReachable?: boolean;
  /** Probe failure detail, for the fail-closed message. */
  qdrantProbeError?: string;
}

/**
 * Pure startup resolver — the SINGLE place the search backend is chosen.
 * Priority:
 *   1. `DB_PROVIDER=postgres` → `pgvector`
 *   2. `DB_PROVIDER=mongodb` + Atlas topology → `atlas-vector-search`
 *   3. `DB_PROVIDER=mongodb` + reachable `QDRANT_URL` → `qdrant`
 *   4. otherwise → throw (fail closed). The error names exactly what is
 *      missing so the operator can fix the deployment; it never suggests
 *      lexical-only as an acceptable fallback.
 *
 * Pure and unit-tested: all I/O (the Qdrant probe) happens in the caller.
 */
export function resolveSearchBackendKind(input: SearchBackendResolution): SearchBackendKind {
  if (input.dbProvider === 'postgres') {
    return 'pgvector';
  }
  if (isAtlasTopology(input.mongoUri ?? '')) {
    return 'atlas-vector-search';
  }
  if (input.qdrantUrl) {
    if (input.qdrantReachable) {
      return 'qdrant';
    }
    throw new Error(
      `search backend unavailable: DB_PROVIDER=mongodb with QDRANT_URL=${input.qdrantUrl} ` +
        `but the Qdrant instance is unreachable` +
        (input.qdrantProbeError ? ` (${input.qdrantProbeError})` : '') +
        ' — fix QDRANT_URL or use MongoDB Atlas for native $vectorSearch. ' +
        'Refusing to boot rather than silently degrading to lexical-only search.',
    );
  }
  throw new Error(
    'search backend unavailable: DB_PROVIDER=mongodb and no vector backend detected ' +
      '(not an Atlas topology, QDRANT_URL is not set) — either use MongoDB Atlas ' +
      '(native $vectorSearch) or set QDRANT_URL to a reachable Qdrant instance. ' +
      'Refusing to boot rather than silently degrading to lexical-only search.',
  );
}
