/**
 * MongoDB lane for `IControlBlockRepository` (P3) — the `control_blocks`
 * aggregate as driven by `ControlBlocksService`.
 *
 * Plan D4: UUIDs are stored as BSON Binary subtype 4 (STANDARD), field names
 * are the pg snake_case column names, timestamps are ISO-8601 strings. Every
 * method is one `withOrg` unit (plan D5); the tenant predicate is enforced by
 * `TenantScopedCollection` (plan D6) — there is no RLS on this lane.
 *
 * Active predicate (mirrors the pg lane exactly): `expires_at IS NULL OR
 * expires_at > now()`, evaluated at check time via a `$gt` against the
 * current ISO instant — no sweeper, no worker.
 *
 * The `setBlock` twin check + insert run inside one transaction, as on the
 * pg lane (which likewise has no unique constraint on `control_blocks` —
 * only `ix_control_blocks_org_target`). A concurrent twin insert is a race
 * on both lanes; the interface's conflict guarantee holds to the same
 * degree.
 */
import type { Binary, Db, Document, WithId } from 'mongodb';
import { ApiError } from '../../../common/http/api-error';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { nowIso, uuidToBinary } from '../../../common/infra/db/mongo/mongo-tx';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { TenantScopedCollection } from '../../../common/infra/db/mongo/concurrency/tenant-guard';
import type { ControlBlock, ControlBlockTarget } from '../schema';
import type { IControlBlockRepository } from './control-block.repository';

// ── document shape (plan D4: snake_case, UUIDs as Binary subtype 4) ───────

interface ControlBlockMongoDoc extends Document {
  id: Binary;
  organization_id: Binary;
  target_type: string;
  target_name: string;
  reason: string;
  expires_at: string | null;
  created_by: string | null;
  created_at: string;
}

// ── row mapper ──────────────────────────────────────────────────────────────

function uuidOf(value: Binary): string {
  return value.toUUID().toString();
}

function toControlBlock(doc: ControlBlockMongoDoc): ControlBlock {
  return {
    id: uuidOf(doc.id),
    organizationId: uuidOf(doc.organization_id),
    targetType: doc.target_type as ControlBlockTarget,
    targetName: doc.target_name,
    reason: doc.reason,
    expiresAt: doc.expires_at,
    createdBy: doc.created_by,
    createdAt: doc.created_at,
  };
}

/** Parse a UUID into BSON Binary subtype 4; fail closed with a validation error. */
function binUuid(id: string, field = 'id'): Binary {
  try {
    return uuidToBinary(id);
  } catch {
    throw ApiError.validation({ [field]: 'must be a uuid' });
  }
}

// ── repository ──────────────────────────────────────────────────────────────

export class MongoControlBlockRepository implements IControlBlockRepository {
  private static readonly LIST_CAP = 200;

  constructor(private readonly mongo: MongoDbService) {}

  private blocks(db: Db): TenantScopedCollection<ControlBlockMongoDoc> {
    return new TenantScopedCollection<ControlBlockMongoDoc>(db.collection<ControlBlockMongoDoc>('control_blocks'));
  }

  /** The owning-read shared by `setBlock`'s twin check and `findActiveBlock`. */
  private async findActiveIn(
    db: Db,
    ctx: MongoTxContext,
    orgId: string,
    targetType: string,
    targetName: string,
  ): Promise<WithId<ControlBlockMongoDoc> | null> {
    return this.blocks(db).findOne(
      orgId,
      {
        target_type: targetType,
        target_name: targetName,
        // `expires_at = null` matches both null and missing (pg `isNull`).
        $or: [{ expires_at: null }, { expires_at: { $gt: nowIso() } }],
      },
      { session: ctx.session },
    );
  }

  async listBlocks(orgId: string): Promise<ControlBlock[]> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const rows = await this.blocks(db)
        .find(orgId, {}, { session: ctx.session })
        .sort({ created_at: 1 })
        .limit(MongoControlBlockRepository.LIST_CAP)
        .toArray();
      return rows.map(toControlBlock);
    });
  }

  async setBlock(input: {
    orgId: string;
    targetType: ControlBlockTarget;
    targetName: string;
    reason: string;
    expiresAt: string | null;
    createdBy: string;
  }): Promise<ControlBlock> {
    const db = this.mongo.root;
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      // Dedupe: an identical ACTIVE block makes a second row a silent twin.
      const twin = await this.findActiveIn(db, ctx, input.orgId, input.targetType, input.targetName);
      if (twin) {
        throw ApiError.conflict('an active block already exists for this target — clear it before setting a new one');
      }
      const now = nowIso();
      const doc: ControlBlockMongoDoc = {
        id: binUuid(uuidv7()),
        organization_id: binUuid(input.orgId, 'orgId'),
        target_type: input.targetType,
        target_name: input.targetName,
        reason: input.reason,
        expires_at: input.expiresAt,
        created_by: input.createdBy,
        created_at: now,
      };
      await this.blocks(db).insertOne(input.orgId, doc, { session: ctx.session });
      return toControlBlock(doc);
    });
  }

  async clearBlock(input: { orgId: string; blockId: string }): Promise<{ ok: true }> {
    const db = this.mongo.root;
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const res = await this.blocks(db).deleteOne(
        input.orgId,
        { id: binUuid(input.blockId, 'blockId') },
        { session: ctx.session },
      );
      if (res.deletedCount === 0) {
        throw ApiError.notFound('control block');
      }
      return { ok: true };
    });
  }

  async findActiveBlock(
    orgId: string,
    targetType: ControlBlockTarget,
    targetName: string,
  ): Promise<ControlBlock | null> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const row = await this.findActiveIn(db, ctx, orgId, targetType, targetName);
      return row ? toControlBlock(row) : null;
    });
  }

  async findActiveTemplateBlock(orgId: string, slug: string, version?: string): Promise<ControlBlock | null> {
    if (version !== undefined) {
      const exact = await this.findActiveBlock(orgId, 'template', `${slug}@${version}`);
      if (exact) return exact;
    }
    return this.findActiveBlock(orgId, 'template', slug);
  }
}
