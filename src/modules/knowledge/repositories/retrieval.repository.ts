/**
 * Retrieval repository (P3) — the persistence port for the retrieval READ
 * path (`RetrievalService`).
 *
 * This port is DELIBERATELY THIN: it is a transaction shell around the
 * vector/FTS leg queries. The SQL text stays service-owned (plan P4/D8 owns
 * the real leg SQL) — the repository executes what it is handed on ONE
 * connection inside ONE tenant-scoped transaction, and hands the raw rows
 * back. RRF fusion, reranking and answer assembly stay in the service.
 *
 * Each method owns its transaction: all legs run on one connection in one
 * unit of work (RLS consistency across legs — a document admitted by the
 * vector leg's ACL filter cannot vanish from the FTS leg's). No transaction
 * handle or callback leaks through this interface — callers get plain domain
 * results.
 *
 * Tenant discipline: the organization id is explicit (inside `input`). The
 * PostgreSQL implementation applies it via `DbService.withOrg` (RLS); the
 * MongoDB implementation applies it as an explicit `organization_id`
 * predicate on every tenant collection access.
 *
 * What stays OUT of the repository (still the service's job):
 * - building the leg SQL (vector/FTS text is service-owned until P4/D8)
 * - ACL filter construction (the canonical builder lives in the service
 *   with its unit test)
 * - embedding the query (vectors arrive pre-computed as SQL literals)
 * - RRF fusion, reranking, snippet assembly
 */
export interface IRetrievalRepository {
  /**
   * Execute all retrieval legs in ONE tenant-scoped TX on one connection.
   *
   * - `vectorLegs`: one entry per (query variant × embedding model); each
   *   carries a pre-computed vector as a SQL literal (`vectorLiteral`), the
   *   per-leg pool size, and the `queryModel` the leg is scoped to. Vector
   *   computation is the service's job — the repository never embeds.
   * - `ftsLegs`: one entry per query variant; `variant` is the tsvector
   *   configuration name, `pool` the per-leg pool size.
   * - `versionIds`: when set, restricts legs to these document versions;
   *   null = latest version per document.
   * - `accountId` / `callerAccountId` / `callerEmails`: the primitive ACL
   *   inputs the leg SQL closes over (the service builds the filter; the
   *   repository only binds the values).
   *
   * Returns raw rows per leg, in the same order as the input legs. The
   * service fuses (RRF) and reranks.
   */
  runRetrievalLegs(input: {
    orgId: string;
    vectorLegs: Array<{ vectorLiteral: string; pool: number; queryModel: string }>;
    ftsLegs: Array<{ variant: string; pool: number }>;
    versionIds: string[] | null;
    accountId: string | null;
    callerAccountId: string | null;
    callerEmails: string[];
  }): Promise<{
    vectorLegs: Array<Array<Record<string, unknown>>>;
    ftsLegs: Array<Array<Record<string, unknown>>>;
  }>;
}
