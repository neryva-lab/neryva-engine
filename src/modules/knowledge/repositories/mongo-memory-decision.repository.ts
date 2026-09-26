/**
 * MongoDB implementation of the memory-decision repository port (P3) — the
 * atomic proposal approval transition.
 *
 * Cross-module write (documented in the interface): `memory_proposals` is
 * owned by the conversations module; the decision flip and the
 * `memory_items` insert co-commit in ONE transaction because splitting them
 * would let the item exist without its decision or vice versa.
 *
 * The select-then-update lost-update hazard is PRESERVED (no lock), matching
 * the current PostgreSQL behavior.
 */
import { ApiError } from '../../../common/http/api-error';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { TenantScopedCollection } from '../../../common/infra/db/mongo/concurrency/tenant-guard';
import type { MemoryItem } from '../schema';
import type {
  MemoryItemMongoDoc,
  MemoryProposalMongoDoc,
} from './mongo-documents';
import type { MemoryItemDraft, MemoryProposal } from './repository-types';
import type { IMemoryDecisionRepository } from './memory-decision.repository';

/**
 * Map a conversations-owned proposal document back to the pg row type.
 * Confidence stays string (pg numeric arrives as string on the pg lane).
 */
import {
  binUuid,
  ensureKnowledgeIndexes,
  newId,
  nowIso,
  sessionOf,
  toIso,
  uuidOrNull,
} from './mongo-knowledge-shared';

const MEMORY_PROPOSALS = 'memory_proposals';
const MEMORY_ITEMS = 'memory_items';

function toMemoryItem(doc: MemoryItemMongoDoc, orgId: string): MemoryItem {
  return {
    id: doc.id.toUUID().toString(),
    organizationId: orgId,
    scopeType: doc.scope_type,
    scopeId: uuidOrNull(doc.scope_id),
    content: doc.content,
    sourceRef: (doc.source_ref ?? null) as MemoryItem['sourceRef'],
    provenance: doc.provenance,
    confidence: doc.confidence,
    visibility: doc.visibility,
    expiresAt: doc.expires_at,
    deletedAt: doc.deleted_at,
    embedding: doc.embedding as MemoryItem['embedding'],
    embeddingModel: doc.embedding_model,
    validFrom: doc.valid_from,
    invalidAt: doc.invalid_at,
    supersedes: uuidOrNull(doc.supersedes),
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

/**
 * Map a conversations-owned proposal document to the provider-neutral
 * `MemoryProposal`. Confidence stays string (pg numeric arrives as string
 * on the pg lane). `memory_proposals` has no `decided_at` column, so
 * `decidedAt` is always null.
 */
function toMemoryProposal(doc: MemoryProposalMongoDoc): MemoryProposal {
  return {
    id: doc.id.toUUID().toString(),
    runId: doc.run_id.toUUID().toString(),
    value: doc.value,
    provenance: doc.provenance,
    confidence: doc.confidence,
    visibility: doc.visibility,
    expiresAt: doc.expires_at,
    decision: doc.decision,
    decidedAt: null,
  };
}

export class MongoMemoryDecisionRepository implements IMemoryDecisionRepository {
  constructor(private readonly mongo: MongoDbService) {}

  async getProposal(orgId: string, proposalId: string): Promise<MemoryProposal | null> {
    // The advisory pre-read: the service needs value/runId/provenance/
    // confidence/visibility/expiresAt to build the draft BEFORE deciding.
    // Null when the proposal does not exist (the service maps this to 404,
    // mirroring the old in-transaction notFound).
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const proposals = new TenantScopedCollection<MemoryProposalMongoDoc>(
        db.collection(MEMORY_PROPOSALS),
      );
      const doc = await proposals.findOne(
        orgId,
        { id: binUuid(proposalId, 'proposalId') },
        sessionOf(ctx),
      );
      return doc ? toMemoryProposal(doc) : null;
    });
  }

  async decideProposal(
    orgId: string,
    proposalId: string,
    decision: 'APPROVED' | 'REJECTED',
    itemDraft: MemoryItemDraft | null,
    embedding: { vector: number[]; model: string } | null,
  ): Promise<{ decision: string; memoryItem: MemoryItem | null }> {
    const db = this.mongo.root;
    await ensureKnowledgeIndexes(db);
    return this.mongo.withOrg(orgId, async (ctx) => {
      const proposals = new TenantScopedCollection<MemoryProposalMongoDoc>(
        db.collection(MEMORY_PROPOSALS),
      );
      const items = new TenantScopedCollection<MemoryItemMongoDoc>(db.collection(MEMORY_ITEMS));
      const s = sessionOf(ctx);

      // 1. Select the proposal (no lock — the lost-update hazard is
      // preserved, see the interface's documented exception).
      const proposal = await proposals.findOne(
        orgId,
        { id: binUuid(proposalId, 'proposalId') },
        s,
      );
      if (!proposal) throw ApiError.notFound('memory proposal');

      // 2. PENDING guard.
      if (proposal.decision !== 'PENDING') {
        throw ApiError.conflict('memory proposal already decided', {
          decision: proposal.decision,
        });
      }

      // 3. Flip the decision.
      await proposals.updateOne(
        orgId,
        { id: proposal.id },
        { $set: { decision } },
        s,
      );

      // 4. Approval inserts the memory item; rejection inserts nothing.
      if (decision === 'REJECTED') {
        return { decision: 'REJECTED', memoryItem: null };
      }
      if (!itemDraft || !embedding) {
        throw ApiError.validation({
          itemDraft: 'an approved decision requires an item draft and a pre-computed embedding',
        });
      }
      const now = nowIso();
      const doc: MemoryItemMongoDoc = {
        id: binUuid(newId()),
        organization_id: binUuid(orgId, 'orgId'),
        scope_type: itemDraft.scopeType,
        scope_id: itemDraft.scopeId == null ? null : binUuid(itemDraft.scopeId, 'scopeId'),
        content: itemDraft.content,
        source_ref: itemDraft.sourceRef ?? null,
        provenance: itemDraft.provenance ?? null,
        confidence: itemDraft.confidence ?? null,
        visibility: itemDraft.visibility ?? 'organization',
        expires_at: itemDraft.expiresAt == null ? null : toIso(itemDraft.expiresAt),
        deleted_at: null,
        embedding: embedding.vector,
        embedding_model: embedding.model,
        valid_from: itemDraft.validFrom == null ? now : toIso(itemDraft.validFrom),
        invalid_at: null,
        supersedes: itemDraft.supersedes == null ? null : binUuid(itemDraft.supersedes, 'supersedes'),
        created_at: now,
        updated_at: now,
      };
      await items.insertOne(orgId, doc, s);
      return { decision: 'APPROVED', memoryItem: toMemoryItem(doc, orgId) };
    });
  }
}
