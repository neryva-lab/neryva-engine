/**
 * Memory repository (P3) — the persistence port for approved memory
 * proposals (`McpAuthorityService`, §5.9).
 */
export interface IMemoryRepository {
  /** Idempotent per proposal_ref (same value replays, different value conflicts). */
  submitMemoryProposal(input: {
    orgId: string;
    runId: string;
    proposalRef: string;
    scope: string;
    value: string;
    provenance?: string;
    confidence?: number;
    visibility?: string;
    expiresAt?: Date;
  }): Promise<{ storedId: string; accepted: boolean; replay: boolean }>;
}
