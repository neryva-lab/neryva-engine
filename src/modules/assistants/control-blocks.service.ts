import { and, eq, isNull, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { controlBlocks, ControlBlock, CONTROL_BLOCK_TARGETS, ControlBlockTarget } from './schema';

/**
 * Operator control blocks — TPL-6.4 (CRUD) + the shared check helper every
 * enforcement point calls (TPL-6.3).
 *
 * A block is ACTIVE when `expires_at IS NULL OR expires_at > now()` —
 * evaluated at check time, so expiry needs no sweeper and no worker. Either
 * state blocks: kill switches have no "warn" mode.
 *
 * Matching: exact `target_name` match, plus `slug@version` prefix match for
 * template targets (a bare `slug` blocks every version of that template).
 */
@Injectable()
export class ControlBlocksService {
  private static readonly LIST_CAP = 200;

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  async list(orgId: string): Promise<ControlBlock[]> {
    assertOrgId(orgId);
    return this.db.withOrg(orgId, (tx) =>
      tx.select().from(controlBlocks).where(eq(controlBlocks.organizationId, orgId)).orderBy(controlBlocks.createdAt).limit(ControlBlocksService.LIST_CAP),
    );
  }

  async set(input: {
    orgId: string;
    targetType: string;
    targetName: string;
    reason: string;
    expiresAt?: string | null;
    actor: string;
  }): Promise<ControlBlock> {
    assertOrgId(input.orgId);
    if (!(CONTROL_BLOCK_TARGETS as readonly string[]).includes(input.targetType)) {
      throw ApiError.validation({ target_type: `must be one of ${(CONTROL_BLOCK_TARGETS as readonly string[]).join('|')}` });
    }
    const targetName = input.targetName.trim();
    if (targetName.length === 0 || targetName.length > 128) {
      throw ApiError.validation({ target_name: 'must be 1..128 chars' });
    }
    if (input.targetType === 'capability' && targetName !== 'tool' && !/^model:.+/.test(targetName)) {
      // Enforcement only ever looks up capability 'tool' and 'model:<provider>'
      // (mcp-authority) — any other capability name is a silent no-op.
      throw ApiError.validation({ target_name: "capability blocks must be 'tool' or 'model:<provider>' — other names never match an enforcement check" });
    }
    if (typeof input.reason !== 'string' || input.reason.trim().length === 0 || input.reason.length > 512) {
      throw ApiError.validation({ reason: 'must be 1..512 chars (operator justification is mandatory)' });
    }
    let expiresAt: string | null = null;
    if (input.expiresAt !== undefined && input.expiresAt !== null) {
      const parsed = new Date(input.expiresAt);
      if (Number.isNaN(parsed.getTime())) {
        throw ApiError.validation({ expires_at: 'must be an ISO timestamp or null' });
      }
      if (parsed.getTime() <= Date.now()) {
        throw ApiError.validation({ expires_at: 'must be in the future — a block born expired refuses nothing' });
      }
      expiresAt = parsed.toISOString();
    }
    const rows = await this.db.withOrg(input.orgId, async (tx) => {
      // Dedupe: an identical ACTIVE block makes a second row a silent twin —
      // clearing one leaves the other enforcing, so the UI would lie about
      // the clear. Expired rows are history and may repeat.
      const twin = await ControlBlocksService.findActiveBlock(tx, input.orgId, input.targetType as ControlBlockTarget, targetName);
      if (twin) {
        throw ApiError.conflict('an active block already exists for this target — clear it before setting a new one');
      }
      return tx
        .insert(controlBlocks)
        .values({
          organizationId: input.orgId,
          targetType: input.targetType,
          targetName,
          reason: input.reason.trim(),
          expiresAt,
          createdBy: input.actor.slice(0, 128),
        })
        .returning();
    });
    const row = rows[0];
    await this.audit.add({
      action: 'control.block_set',
      resourceType: 'control_block',
      resourceId: row.id,
      actorType: 'account',
      actorId: input.actor,
      tenantId: input.orgId,
      details: { target_type: row.targetType, target_name: row.targetName, reason: row.reason },
    });
    return row;
  }

  async clear(input: { orgId: string; blockId: string; actor: string }): Promise<{ ok: true }> {
    assertOrgId(input.orgId);
    assertUuid(input.blockId);
    const rows = await this.db.withOrg(input.orgId, (tx) =>
      tx.delete(controlBlocks).where(and(eq(controlBlocks.id, input.blockId), eq(controlBlocks.organizationId, input.orgId))).returning(),
    );
    if (rows.length === 0) {
      throw ApiError.notFound('control block');
    }
    await this.audit.add({
      action: 'control.block_cleared',
      resourceType: 'control_block',
      resourceId: rows[0].id,
      actorType: 'account',
      actorId: input.actor,
      tenantId: input.orgId,
      details: { target_type: rows[0].targetType, target_name: rows[0].targetName },
    });
    return { ok: true };
  }

  /**
   * The shared enforcement read. Takes any drizzle executor (a withOrg tx or
   * db.root for global reads) so checks compose inside the caller's
   * transaction — the block verdict and the gated write share one TX.
   */
  static async findActiveBlock(
    db: NodePgDatabase,
    orgId: string,
    targetType: ControlBlockTarget,
    targetName: string,
  ): Promise<ControlBlock | null> {
    const rows = await db
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

  /** Template targets match `slug` exactly or `slug@version` exactly. */
  static async findActiveTemplateBlock(db: NodePgDatabase, orgId: string, slug: string, version?: string): Promise<ControlBlock | null> {
    const exact = version !== undefined ? await ControlBlocksService.findActiveBlock(db, orgId, 'template', `${slug}@${version}`) : null;
    if (exact) return exact;
    return ControlBlocksService.findActiveBlock(db, orgId, 'template', slug);
  }
}

function assertOrgId(orgId: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orgId)) {
    throw ApiError.validation({ orgId: 'must be a uuid' });
  }
}

function assertUuid(id: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw ApiError.validation({ id: 'must be a uuid' });
  }
}
