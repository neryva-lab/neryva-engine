/**
 * PostgreSQL memory repository (P3) — approved memory proposals
 * (`McpAuthorityService`, §5.9). Mechanical move.
 *
 * Proposals are NOT truth: they are stored per proposal_ref and promoted by
 * a separate approval path. Idempotent per proposal_ref — same value replays,
 * different value conflicts.
 */
import { and, eq } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { ApiError } from '../../../common/http/api-error';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { memoryProposals } from '../mcp.schema';
import type { IMemoryRepository } from './memory.repository';

export class PgMemoryRepository implements IMemoryRepository {
  constructor(private readonly db: DbService) {}

  async submitMemoryProposal(input: {
    orgId: string;
    runId: string;
    proposalRef: string;
    scope: string;
    value: string;
    provenance?: string;
    confidence?: number;
    visibility?: string;
    expiresAt?: Date;
  }): Promise<{ storedId: string; accepted: boolean; replay: boolean }> {
    return this.db.withOrg(input.orgId, async (tx) => {
      const existing = await tx
        .select()
        .from(memoryProposals)
        .where(
          and(
            eq(memoryProposals.organizationId, input.orgId),
            eq(memoryProposals.proposalRef, input.proposalRef),
          ),
        )
        .limit(1);
      if (existing.length > 0) {
        if (existing[0].value !== input.value) {
          throw ApiError.conflict('proposal_ref reuse with different value', {
            proposal_ref: input.proposalRef,
          });
        }
        return { storedId: existing[0].id, accepted: true, replay: true };
      }
      const storedId = uuidv7();
      await tx.insert(memoryProposals).values({
        id: storedId,
        organizationId: input.orgId,
        runId: input.runId,
        proposalRef: input.proposalRef,
        scope: input.scope,
        value: input.value,
        provenance: input.provenance ?? null,
        confidence:
          input.confidence != null ? String(Math.min(1, Math.max(0, input.confidence))) : null,
        visibility: input.visibility ?? null,
        expiresAt: input.expiresAt?.toISOString() ?? null,
      });
      return { storedId, accepted: true, replay: false };
    });
  }
}
