/**
 * PostgreSQL lane for `IDataAccessRepository` (P3).
 *
 * Behavioral truth: `src/modules/lifecycle/lifecycle.service.ts`
 * (`recordAccess` / `tombstoneFor`). Byte-identical behavior, same
 * transaction boundaries, same error semantics — the queries moved here
 * mechanically; no logic changed.
 */
import { and, eq } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';
import { DbService } from '../../../common/infra/db/db.service';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { dataAccessRecords, tombstones } from '../lifecycle.schema';
import type { IDataAccessRepository } from './data-access.repository';

@Injectable()
export class PgDataAccessRepository implements IDataAccessRepository {
  constructor(private readonly db: DbService) {}

  async recordAccess(input: {
    orgId: string | null;
    actorType: string;
    actorId: string;
    accessType: string;
    resourceType: string;
    resourceId?: string;
    justification?: string;
    traceId?: string;
  }): Promise<void> {
    await this.db.withBypass(async (tx) => {
      await tx.insert(dataAccessRecords).values({
        id: uuidv7(),
        organizationId: input.orgId,
        actorType: input.actorType,
        actorId: input.actorId.slice(0, 128),
        accessType: input.accessType,
        resourceType: input.resourceType,
        resourceId: input.resourceId ?? null,
        justification: input.justification?.slice(0, 512) ?? null,
        traceId: input.traceId?.slice(0, 64) ?? null,
      });
    });
  }

  async tombstoneFor(resourceType: string, resourceId: string): Promise<{ reason: string } | null> {
    const rows = await this.db.withBypass((tx) =>
      tx
        .select()
        .from(tombstones)
        .where(and(eq(tombstones.resourceType, resourceType), eq(tombstones.resourceId, resourceId)))
        .limit(1),
    );
    return rows.length > 0 ? { reason: rows[0].reason } : null;
  }
}
