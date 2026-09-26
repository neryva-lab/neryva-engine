/**
 * Run-context repository (P3) — the persistence port for authorized run
 * context assembly (`McpAuthorityService`, §5.5).
 *
 * `assembleRunContext` owns its transaction: run + pinned snapshot reads,
 * history window, newest covering compaction summary, scoped approved
 * memories and knowledge retrieval via the injected hooks (the durable
 * retrieval event is written in the SAME unit — FL-2.9), catalog-resolved
 * tool descriptors with blocked/disabled tools withheld, budgets, guardrail
 * policy, brand voice.
 *
 * The model-catalog read is a root/platform-plane read on both lanes
 * (documented posture) and degrades to empty on failure — advisory data
 * never fails context assembly.
 *
 * Retrieval itself is NOT a repository concern: the service injects the two
 * retrieval legs as `ContextRetrievalHooks` (backed by `RetrievalService`,
 * knowledge module), so this port has no cross-module service dependency.
 */
import type { RunContextManifest } from './run-context-types';

/** Scoped memory row as the context assembly consumes it. */
export interface ApprovedMemoryRow {
  id: string;
  scopeType: string;
  scopeId: string | null;
  provenance: string | null;
  content: string;
}

/** Knowledge hit as the context assembly consumes it. */
export interface KnowledgeHitRow {
  documentId: string;
  chunkId: string;
  text: string;
  title: string | null;
  score: number;
  sourceRange: { byteStart: number; byteEnd: number };
}

/**
 * Retrieval legs injected by the service (backed by `RetrievalService`,
 * knowledge module). Kept out of the repository so the persistence port has
 * no cross-module service dependency; the durable retrieval *event* write
 * stays inside the repository transaction (FL-2.9).
 */
export interface ContextRetrievalHooks {
  searchApprovedMemories(input: {
    orgId: string;
    query: string;
    scopes: Array<{
      scopeType: 'organization' | 'conversation' | 'user' | 'assistant';
      scopeId?: string;
    }>;
    limit: number;
  }): Promise<ApprovedMemoryRow[]>;
  searchKnowledge(input: {
    orgId: string;
    query: string;
    limit: number;
    allowedDocumentVersionIds?: string[];
    callerAccountId?: string;
  }): Promise<KnowledgeHitRow[]>;
}

export interface IRunContextRepository {
  assembleRunContext(
    input: { orgId: string; runId: string },
    hooks: ContextRetrievalHooks,
  ): Promise<RunContextManifest>;

  /** E-1 — run-scoped pin allow-list for the agentic SearchKnowledge path. */
  pinnedVersionIdsForRun(orgId: string, runId: string): Promise<string[] | undefined>;

  /** P0-1 — run actor account for source-ACL matching (trigger author iff an account id). */
  runActorAccountId(orgId: string, runId: string): Promise<string | null>;
}

/**
 * E-1 — snapshot pin allow-list for retrieval. Undefined when the snapshot
 * declares no pins (legacy org-wide posture preserved); otherwise the
 * resolved document_version ids ([] constrains to nothing — fail-closed).
 * Pure — unit-tested.
 */
export function resolvedPinVersionIds(
  snapshot: { knowledgePins?: unknown } | null,
): string[] | undefined {
  const pins = snapshot?.knowledgePins;
  if (!Array.isArray(pins)) {
    return undefined;
  }
  return (pins as Array<{ resolved?: unknown; document_version_id?: unknown }>)
    .filter(
      (p) =>
        p?.resolved === true &&
        typeof p?.document_version_id === 'string' &&
        (p.document_version_id as string).length > 0,
    )
    .map((p) => p.document_version_id as string);
}

/**
 * G4 — brand voice composition. The pinned brand block is appended to the
 * pinned instructions under a STABLE delimiter both makers and auditors can
 * recognize. Blank/absent brand returns instructions untouched. Pure —
 * unit-tested.
 */
export function composeSystemPrompt(
  instructions: string | null,
  brand: string | null,
): string | undefined {
  const prompt =
    typeof instructions === 'string' && instructions.trim() !== '' ? instructions : null;
  const voice = typeof brand === 'string' && brand.trim() !== '' ? brand.trim() : null;
  if (!prompt && !voice) {
    return undefined;
  }
  if (!voice) {
    return prompt as string;
  }
  if (!prompt) {
    return `Brand voice: ${voice}`;
  }
  return `${prompt}\n\nBrand voice: ${voice}`;
}
