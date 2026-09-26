/**
 * MongoDB lane for `IMemoryRepository` (P3) — approved memory proposals
 * (`McpAuthorityService` §5.9).
 *
 * Behavioral truth: `src/modules/conversations/mcp-authority.service.ts`
 * (`submitMemoryProposal`). Idempotent per proposal_ref: same value replays,
 * different value is a typed 409. The pg lane's
 * `uq_memory_proposals_org_ref` unique index is the dedup authority; the
 * mongo claim below catches 11000 on that key and re-reads.
 */
import type { Db } from 'mongodb';
import { uuidToBinary } from '../../../common/infra/db/mongo/mongo-tx';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { ApiError } from '../../../common/http/api-error';
import { uuidv7 } from '../../../common/ids/uuidv7';
import type { IMemoryRepository } from './memory.repository';
import {
  isDuplicateKey,
  requireOrg,
  tenantCollection,
  type MemoryProposalMongoDoc,
} from './mongo-documents';

export class MongoMemoryRepository implements IMemoryRepository {
  constructor(private readonly mongo: MongoDbService) {}

  /**
   * Defensive index provisioning. The release migration
   * (`mongo/0001_engine_core.ts`) does NOT provision the pg-parity
   * `uq_memory_proposals_org_ref` unique index on
   * (organization_id, proposal_ref) that the replay/conflict path depends
   * on — this is the gap; until the migration owns it, `createIndex` is
   * idempotent, so calling this is safe anywhere (tests, one-off scripts)
   * without double-provisioning in production.
   */
  static async ensureIndexes(db: Db): Promise<void> {
    await db.collection('memory_proposals').createIndex(
      { organization_id: 1, proposal_ref: 1 },
      { unique: true, name: 'uq_memory_proposals_org_ref' },
    );
  }

  private indexesEnsured = false;

  /**
   * Lazy index provisioning: the release migration does not own the
   * pg-parity unique index yet, and the 11000 replay/conflict path depends
   * on it. `createIndex` is idempotent, so concurrent first calls are
   * harmless.
   */
  private async ensureIndexesOnce(): Promise<void> {
    if (this.indexesEnsured) return;
    await MongoMemoryRepository.ensureIndexes(this.mongo.root);
    this.indexesEnsured = true;
  }

  /** Idempotent per proposal_ref (same value replays, different value conflicts). */
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
    const db = this.mongo.root;
    await this.ensureIndexesOnce();
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const orgId = requireOrg(ctx);
      const sessionOpt = { session: ctx.session };
      const proposals = tenantCollection<MemoryProposalMongoDoc>(db, 'memory_proposals');

      const existing = await proposals.findOne(
        orgId,
        { proposal_ref: input.proposalRef },
        sessionOpt,
      );
      if (existing) {
        if (existing.value !== input.value) {
          throw ApiError.conflict('proposal_ref reuse with different value', {
            proposal_ref: input.proposalRef,
          });
        }
        return {
          storedId: existing.id.toUUID().toString(),
          accepted: true,
          replay: true,
        };
      }

      const storedId = uuidv7();
      const doc = {
        id: uuidToBinary(storedId),
        organization_id: uuidToBinary(orgId),
        run_id: uuidToBinary(input.runId),
        proposal_ref: input.proposalRef,
        scope: input.scope,
        value: input.value,
        provenance: input.provenance ?? null,
        confidence:
          input.confidence != null ? String(Math.min(1, Math.max(0, input.confidence))) : null,
        visibility: input.visibility ?? null,
        expires_at: input.expiresAt?.toISOString() ?? null,
        decision: 'PENDING',
        created_at: new Date().toISOString(),
      };
      try {
        await proposals.insertOne(orgId, doc, sessionOpt);
      } catch (err) {
        // Lost the insert race to a concurrent claim — re-read and apply the
        // same replay/conflict verdict the pg lane would. Anything that is
        // not a duplicate-key conflict is a real failure (never leaked).
        if (!isDuplicateKey(err)) {
          throw err;
        }
        const raced = await proposals.findOne(
          orgId,
          { proposal_ref: input.proposalRef },
          sessionOpt,
        );
        if (!raced) {
          // Unique conflict reported but the document is invisible (racing
          // writer outside this transaction's snapshot) — fail closed rather
          // than invent an outcome.
          throw ApiError.conflict('proposal_ref reuse with different value', {
            proposal_ref: input.proposalRef,
          });
        }
        if (raced.value !== input.value) {
          throw ApiError.conflict('proposal_ref reuse with different value', {
            proposal_ref: input.proposalRef,
          });
        }
        return { storedId: raced.id.toUUID().toString(), accepted: true, replay: true };
      }
      return { storedId, accepted: true, replay: false };
    });
  }
}
