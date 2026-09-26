/**
 * Document repository (P3) — the persistence port for the `documents`
 * aggregate's management surface (`KnowledgeService`): inventory, slug
 * addressing, retirement, and the ACL-gated preview read.
 *
 * Each method owns its transaction: the implementation opens the unit of
 * work, runs all reads/writes inside it, and commits or rolls back as one.
 * No transaction handle or callback leaks through this interface — callers
 * get plain domain results.
 *
 * Tenant discipline: every method takes the organization id explicitly
 * (first parameter or inside `input`). The PostgreSQL implementation applies
 * it via `DbService.withOrg` (RLS); the MongoDB implementation applies it as
 * an explicit `organization_id` predicate on every tenant collection access.
 *
 * Row types are imported as *types only* from the module schema — the
 * interface carries no drizzle runtime dependency.
 *
 * What stays OUT of the repository (still the service's job):
 * - slug derivation/validation (kebab rules live in `source-slug.ts`)
 * - ACL filter construction — the canonical builder `buildSourceAclFilter`
 *   stays in `retrieval.service.ts` with its unit test; the repository
 *   takes PRIMITIVE ACL inputs (`accountId`, `callerEmails`) and builds the
 *   identical SQL fragment inline. Do NOT import a service into the repo.
 */
import type {
  DocumentInventoryRow,
  DocumentPreview,
  DocumentVersionTarget,
} from './repository-types';

export interface IDocumentRepository {
  /** Re-ingest version target: document identity + lifecycle state. */
  findVersionTarget(
    orgId: string,
    documentId: string,
  ): Promise<DocumentVersionTarget | null>;

  /** True when the org already has a document pinned at `slug`. */
  isSourceSlugTaken(orgId: string, slug: string): Promise<boolean>;

  /**
   * Document inventory for the management surface. The wire shape stays
   * snake_case (`id`, `source_slug`, `title`, `state`, `updated_at`,
   * `latest_version`) — the mapping from pg columns is:
   * `documents.{id,source_slug,title,state,updated_at}` +
   * `max(document_versions.version)` as `latest_version` (0 when the
   * document has no version yet).
   */
  listInventory(orgId: string, limit: number): Promise<DocumentInventoryRow[]>;

  /**
   * Atomic check-and-set slug rename. Known race, preserved — NOT fixed by
   * this migration: the clash check has no `FOR UPDATE` today, so two
   * concurrent renames to the same slug can both pass the check and one
   * loses to the unique constraint. Documenting, not fixing — the service
   * maps the constraint violation to the `slug_taken` outcome.
   */
  renameSourceSlug(
    orgId: string,
    documentId: string,
    slug: string,
  ): Promise<'renamed' | 'unchanged' | 'not_found' | 'slug_taken'>;

  /**
   * Idempotent tombstone: `state → 'retired'` (a retired document is
   * unreachable by retrieval). `'already_retired'` when the document is
   * already retired — retry-safe, not an error.
   */
  retire(orgId: string, documentId: string): Promise<'retired' | 'already_retired' | 'not_found'>;

  /**
   * Atomic gated preview read, one TX: ACL gate → document → latest version
   * → chunk count + one page of chunks. Takes PRIMITIVE ACL inputs
   * (`accountId`, `callerEmails`); the repository builds the identical ACL
   * SQL fragment inline (the canonical `buildSourceAclFilter` stays in
   * `retrieval.service.ts` with its unit test — referenced here, never
   * imported). Null when the document is missing or the caller is not
   * admitted.
   */
  readPreview(input: {
    orgId: string;
    documentId: string;
    accountId: string | null;
    callerEmails: string[];
    chunkLimit: number;
  }): Promise<DocumentPreview | null>;
}
