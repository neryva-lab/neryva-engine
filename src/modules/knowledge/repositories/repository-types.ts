/**
 * Shared repository-layer types for the knowledge module (P3).
 *
 * These types are provider-blind: the PostgreSQL and MongoDB repository
 * implementations behind the knowledge ports both speak them, and the
 * services consume them without knowing which provider is active.
 *
 * Row types are imported as *types only* from the module schemas (`../schema`,
 * `../connectors.schema`, `../eval.schema`) plus the two cross-module reads
 * the eval ports need (`memory_proposals` from the conversations schema, the
 * outbox draft from common infra). The interfaces carry no drizzle runtime
 * dependency.
 *
 * Domain intent over CRUD: `$inferInsert`-derived `New*` types name exactly
 * what the service must supply before the repository owns the insert; `Draft`
 * types name partial rows the service composes from API/worker inputs. All
 * timestamps surface as ISO-8601 strings (pg `timestamptz` `mode: 'string'`
 * convention); services pass `Date` where the repository must write one.
 */

/* ── re-exported row types (source: ../schema, ../connectors.schema) ────── */

import type {
  artifacts,
  chunks,
  documents,
  memoryItems,
  uploadSessions,
} from '../schema';
import type {
  connectorAccounts,
  connectorDocuments,
  connectorOAuthApps,
} from '../connectors.schema';
import type {
  evalCaseExecutions,
  evalCases,
  evalDatasets,
  evalRuns,
} from '../eval.schema';
import type { outboxEvents } from '../../../common/infra/outbox/schema';

/** Row types the knowledge services already trade in. */
export type { Artifact, UploadSession, DocumentRow, Chunk, MemoryItem } from '../schema';
export type { ConnectorAccount } from '../connectors.schema';
export type { EvalCaseExecution } from '../eval.schema';

/* ── upload / artifact lifecycle ─────────────────────────────────────────── */

/**
 * Service-supplied insert row for `artifacts`. The repository supplies
 * nothing the service has not already computed: the service mints the id,
 * the tenant-bound object key, byte length and sha256.
 */
export type NewArtifact = typeof artifacts.$inferInsert;

/**
 * Service-supplied insert row for `upload_sessions`. The service mints the
 * id and the expiry; the repository owns the state transitions afterwards.
 */
export type NewUploadSession = typeof uploadSessions.$inferInsert;

/** Connector sync staging payload: the exact two rows `stageDocument` inserts. */
export interface StagedSourceDocument {
  artifact: NewArtifact;
  session: NewUploadSession;
}

/* ── documents ───────────────────────────────────────────────────────────── */

/**
 * Inventory row — wire shape stays snake_case (matches the pg columns and
 * the controller's existing response shape). `latest_version` is the
 * `max(document_versions.version)` for the document (0 when no version
 * exists yet).
 */
export interface DocumentInventoryRow {
  id: string;
  source_slug: string;
  title: string | null;
  state: string;
  updated_at: string;
  latest_version: number;
}

/** A chunk row as the gated preview hands it out (sequence + text + source range). */
export interface DocumentPreviewChunk {
  sequence: number;
  text: string;
  /** `{ byteStart, byteEnd }` citation anchor into the parsed text. */
  sourceRange: { byteStart: number; byteEnd: number } | null;
}

/**
 * Gated document preview: doc identity, its latest published version, the
 * total chunk count and one page of chunks. Produced atomically by
 * `readPreview` after the ACL gate passes.
 */
export interface DocumentPreview {
  id: string;
  title: string | null;
  state: string;
  source_slug: string;
  version: number;
  chunkCount: number;
  chunks: DocumentPreviewChunk[];
}

/* ── memory ──────────────────────────────────────────────────────────────── */

/**
 * Insert shape for `memory_items`. `organizationId` is applied by the
 * repository from the explicit `orgId` param — never supplied by the caller.
 * Tombstone/temporal columns (`deletedAt`, `invalidAt`) are owned by the
 * lifecycle methods, not the draft.
 */
export type MemoryItemDraft = Omit<
  typeof memoryItems.$inferInsert,
  'id' | 'organizationId' | 'createdAt' | 'updatedAt' | 'deletedAt' | 'invalidAt'
>;

/**
 * A memory scoping address: `scopeType` is one of `organization |
 * conversation | assistant | user`; `scopeId` is null for organization scope.
 */
export interface MemoryScope {
  scopeType: string;
  scopeId: string | null;
}

/**
 * Provider-neutral memory proposal (read model for the approval pre-read).
 * Only the fields the decision path needs — never the full
 * conversations-owned row.
 *
 * DIVERGENCE (documented, not backfilled): `memory_proposals` carries no
 * `decided_at` column, so `decidedAt` is always null. The PENDING guard in
 * `decideProposal` is the source of truth for "already decided".
 */
export interface MemoryProposal {
  id: string;
  runId: string;
  value: string;
  provenance: string | null;
  /** pg numeric arrives as string — kept as string on both lanes. */
  confidence: string | null;
  visibility: string | null;
  expiresAt: string | null;
  /** PENDING | APPROVED | REJECTED */
  decision: string;
  /** No decided_at column exists — always null. */
  decidedAt: string | null;
}

/** Org memory policy (scrub posture + default TTL), from org_settings. */
export interface MemoryPolicySettings {
  scrub: 'off' | 'redact' | 'block';
  ttlSeconds: number | null;
}

/** Minimal legal-hold identity for the purge gate. */
export interface LegalHoldSummary {
  id: string;
}

/* ── connector apps ──────────────────────────────────────────────────────── */

/** Row type for `connector_oauth_apps` (BYO OAuth apps, one per provider). */
export type ConnectorOAuthApp = typeof connectorOAuthApps.$inferSelect;

/** Re-exported so services need only import from this file. */
export type { connectorDocuments };

/* ── eval datasets / cases ───────────────────────────────────────────────── */

/** Row type for `eval_datasets`. */
export type EvalDatasetRow = typeof evalDatasets.$inferSelect;

/**
 * Service-supplied insert row for `eval_datasets`. The repository returns
 * `null` on `uq_eval_datasets_org_name` conflict.
 */
export type NewEvalDataset = typeof evalDatasets.$inferInsert;

/** Row type for `eval_cases`. */
export type EvalCaseRow = typeof evalCases.$inferSelect;

/**
 * Service-supplied insert row for `eval_cases`. `sequence` is allocated by
 * the repository inside `appendCases`.
 */
export type NewEvalCase = typeof evalCases.$inferInsert;

/**
 * Updatable case body. The repository writes exactly these columns; id /
 * datasetId / sequence are address, not content.
 */
export interface EvalCaseBody {
  input: unknown;
  expected: unknown;
  rubric?: unknown;
}

/**
 * Case content as hashed for run/execution matching: the material columns
 * only, in a stable key order for the digest the service computes.
 */
export interface EvalCaseContent {
  id: string;
  input: unknown;
  expected: unknown;
  rubric: unknown | null;
}

/* ── eval runs ───────────────────────────────────────────────────────────── */

/** Row type for `eval_runs`. */
export type EvalRunRow = typeof evalRuns.$inferSelect;

/**
 * Service-supplied insert row for `eval_runs`. `policySnapshotId` must
 * already be pinned by the service (W2.4: witnessed at start time, never
 * invented) — the repository refuses nothing but stamps nothing either.
 */
export type NewEvalRun = typeof evalRuns.$inferInsert;

/**
 * Terminal completion for a run. Pre-computed by the service (scoring
 * happens outside the repository); `completeIfOpen` applies it under the
 * `state IN ('pending','running')` fence only.
 */
export interface EvalRunCompletion {
  state: 'completed' | 'failed';
  results: unknown;
  score: string | null;
  /** TPL-7.4 provenance blob — the publish gate reads it. */
  provenance?: Record<string, unknown> | null;
  decision: 'PASS' | 'WARN' | 'BLOCK' | 'FAIL' | null;
  releasePolicyVersion: number | null;
  finishedAt: Date;
}

/**
 * Transactional-outbox event draft for `eval_runs.createWithOutboxEvent`.
 * `organizationId` is applied by the repository from the explicit `orgId`
 * param; `eventId`/`status`/`attemptCount`/`createdAt`/`publishedAt`/
 * `claimedAt` are infra-owned and omitted.
 */
export type OutboxEventDraft = Omit<
  typeof outboxEvents.$inferInsert,
  | 'eventId'
  | 'organizationId'
  | 'status'
  | 'attemptCount'
  | 'createdAt'
  | 'publishedAt'
  | 'claimedAt'
>;

/* ── analytics ───────────────────────────────────────────────────────────── */

/**
 * Analytics rollup row (columns mirror `analytics_rollups`; `period_start`
 * is the yyyy-mm-dd bucket as an ISO date string, `scope`/`metrics` are the
 * raw jsonb payloads — the service interprets them).
 */
export interface RollupRow {
  id: string;
  kind: string;
  period_start: string;
  scope: unknown;
  metrics: unknown;
  computed_at: string;
}

/* ── rows referenced but owned by other tables (type plumbing only) ──────── */

/** Chunk rows as read for the re-embed swap (id + text only). */
export type ReEmbedChunk = Pick<typeof chunks.$inferSelect, 'id' | 'text'>;

/** Document identity + lifecycle state for version-target checks. */
export type DocumentVersionTarget = Pick<typeof documents.$inferSelect, 'id'> & {
  state: string;
};
