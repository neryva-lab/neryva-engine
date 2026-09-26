import { and, eq, isNull, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DbService } from '../../../common/infra/db/db.service';
import { ApiError } from '../../../common/http/api-error';
import { controlBlocks } from '../schema';
import type { ControlBlock, ControlBlockTarget } from '../schema';
import type { IControlBlockRepository } from './control-block.repository';

/**
 * PostgreSQL implementation of `IControlBlockRepository` (P3).
 *
 * Mechanical move of the `ControlBlocksService` persistence units (CRUD and
 * the owning-read versions of the kill checks): every method owns its
 * transaction via `DbService.withOrg`, runs all reads/writes inside it, and
 * commits or rolls back as one. No transaction handle leaks through this
 * interface.
 *
 * The static enforcement reads on `ControlBlocksService`
 * (`findActiveBlock`/`findActiveTemplateBlock`, used by other modules'
 * repositories inside their own transactions) are untouched — this class
 * implements the interface's owning-read versions separately.
 *
 * What stays OUT (still the caller's job): input validation (`assertUuid`,
 * target/reason shape checks — the caller pre-normalizes), tracing spans,
 * audit writes (replayed by the service from inputs + results), kill-level
 * ordering and enforcement decisions (service policy).
 */
export class PgControlBlockRepository implements IControlBlockRepository {
  private static readonly LIST_CAP = 200;

  constructor(private readonly db: DbService) {}

  async listBlocks(orgId: string): Promise<ControlBlock[]> {
    return this.db.withOrg(orgId, (tx) =>
      tx.select().from(controlBlocks).where(eq(controlBlocks.organizationId, orgId)).orderBy(controlBlocks.createdAt).limit(PgControlBlockRepository.LIST_CAP),
    );
  }

  async setBlock(input: {
    orgId: string;
    targetType: ControlBlockTarget;
    targetName: string;
    reason: string;
    expiresAt: string | null;
    createdBy: string;
  }): Promise<ControlBlock> {
    const rows = await this.db.withOrg(input.orgId, async (tx) => {
      // Dedupe: an identical ACTIVE block makes a second row a silent twin —
      // clearing one leaves the other enforcing, so the UI would lie about
      // the clear. Expired rows are history and may repeat.
      const twin = await PgControlBlockRepository.findActiveIn(tx, input.orgId, input.targetType, input.targetName);
      if (twin) {
        throw ApiError.conflict('an active block already exists for this target — clear it before setting a new one');
      }
      return tx
        .insert(controlBlocks)
        .values({
          organizationId: input.orgId,
          targetType: input.targetType,
          targetName: input.targetName,
          reason: input.reason,
          expiresAt: input.expiresAt,
          createdBy: input.createdBy,
        })
        .returning();
    });
    return rows[0];
  }

  async clearBlock(input: { orgId: string; blockId: string }): Promise<{ ok: true }> {
    const rows = await this.db.withOrg(input.orgId, (tx) =>
      tx.delete(controlBlocks).where(and(eq(controlBlocks.id, input.blockId), eq(controlBlocks.organizationId, input.orgId))).returning(),
    );
    if (rows.length === 0) {
      throw ApiError.notFound('control block');
    }
    return { ok: true };
  }

  async findActiveBlock(
    orgId: string,
    targetType: ControlBlockTarget,
    targetName: string,
  ): Promise<ControlBlock | null> {
    return this.db.withOrg(orgId, (tx) => PgControlBlockRepository.findActiveIn(tx, orgId, targetType, targetName));
  }

  async findActiveTemplateBlock(orgId: string, slug: string, version?: string): Promise<ControlBlock | null> {
    if (version !== undefined) {
      const exact = await this.findActiveBlock(orgId, 'template', `${slug}@${version}`);
      if (exact) return exact;
    }
    return this.findActiveBlock(orgId, 'template', slug);
  }

  /**
   * The owning-read shared by `setBlock`'s twin check and the interface's
   * `findActiveBlock` — the same active predicate as the
   * `ControlBlocksService.findActiveBlock` static (`expires_at IS NULL OR
   * expires_at > now()`, evaluated at check time).
   */
  private static async findActiveIn(
    tx: NodePgDatabase,
    orgId: string,
    targetType: ControlBlockTarget,
    targetName: string,
  ): Promise<ControlBlock | null> {
    const rows = await tx
      .select()
      .from(controlBlocks)
      .where(
        and(
          eq(controlBlocks.organizationId, orgId),
          eq(controlBlocks.targetType, targetType),
          eq(controlBlocks.targetName, targetName),
          or(isNull(controlBlocks.expiresAt), sql`${controlBlocks.expiresAt} > now()`),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }
}
