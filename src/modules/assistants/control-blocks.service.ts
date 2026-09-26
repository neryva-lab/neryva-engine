import { and, eq, isNull, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { controlBlocks, ControlBlock, CONTROL_BLOCK_TARGETS, ControlBlockTarget } from './schema';
import { CONTROL_BLOCK_REPOSITORY } from './repositories/repository-tokens';
import type { IControlBlockRepository } from './repositories/control-block.repository';

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
 *
 * Persistence lives in `IControlBlockRepository` (P3): this service keeps
 * input validation, audit replay, and policy — every `db.*` call moved into
 * the pg/mongo repository implementations.
 */
@Injectable()
export class ControlBlocksService {
  constructor(
    @Inject(CONTROL_BLOCK_REPOSITORY) private readonly blocks: IControlBlockRepository,
    private readonly audit: AuditService,
  ) {}

  async list(orgId: string): Promise<ControlBlock[]> {
    assertOrgId(orgId);
    return this.blocks.listBlocks(orgId);
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
    const row = await this.blocks.setBlock({
      orgId: input.orgId,
      targetType: input.targetType as ControlBlockTarget,
      targetName,
      reason: input.reason.trim(),
      expiresAt,
      createdBy: input.actor.slice(0, 128),
    });
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
    // The repository port returns only `{ ok: true }`; the pre-read supplies
    // the target details the clear audit replays. When the block is missing
    // (or foreign), clearBlock throws notFound before any audit is written.
    const existing = (await this.blocks.listBlocks(input.orgId)).find((b) => b.id === input.blockId);
    await this.blocks.clearBlock({ orgId: input.orgId, blockId: input.blockId });
    await this.audit.add({
      action: 'control.block_cleared',
      resourceType: 'control_block',
      resourceId: input.blockId,
      actorType: 'account',
      actorId: input.actor,
      tenantId: input.orgId,
      details: { target_type: existing?.targetType ?? 'unknown', target_name: existing?.targetName ?? 'unknown' },
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
