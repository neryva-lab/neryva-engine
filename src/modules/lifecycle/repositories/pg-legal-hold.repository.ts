/**
 * PostgreSQL lane for `ILegalHoldRepository` (P3).
 *
 * Behavioral truth: `src/modules/lifecycle/lifecycle.service.ts`
 * (`placeHold` / `releaseHold` / `listHolds`). Byte-identical behavior,
 * same transaction boundaries, same error semantics — the queries moved
 * here mechanically; no logic changed.
 */
import { and, desc, eq } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';
import { DbService } from '../../../common/infra/db/db.service';
import { ApiError } from '../../../common/http/api-error';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { legalHolds, purgeTasks } from '../lifecycle.schema';
import { assertUuid } from '../assert';
import type { ILegalHoldRepository } from './legal-hold.repository';

@Injectable()
export class PgLegalHoldRepository implements ILegalHoldRepository {
  constructor(private readonly db: DbService) {}

  async placeHold(input: {
    orgId: string;
    scopeType: string;
    scopeId: string | null;
    reason: string;
    actor: string;
    expiresAt?: Date;
  }): Promise<typeof legalHolds.$inferSelect> {
    assertUuid(input.orgId, 'orgId');
    if (input.scopeId) assertUuid(input.scopeId, 'scopeId');
    const rows = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .insert(legalHolds)
        .values({
          id: uuidv7(),
          organizationId: input.orgId,
          scopeType: input.scopeType,
          scopeId: input.scopeId,
          holdReason: input.reason.slice(0, 512),
          placedBy: input.actor,
          expiresAt: input.expiresAt?.toISOString() ?? null,
        })
        .returning(),
    );
    return rows[0];
  }

  async releaseHold(input: {
    orgId: string;
    holdId: string;
    actor: string;
  }): Promise<typeof legalHolds.$inferSelect> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.holdId, 'holdId');
    const rows = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .update(legalHolds)
        .set({ status: 'released', releasedAt: new Date().toISOString() })
        .where(
          and(
            eq(legalHolds.id, input.holdId),
            eq(legalHolds.organizationId, input.orgId),
            eq(legalHolds.status, 'active'),
          ),
        )
        .returning(),
    );
    if (rows.length === 0) {
      throw ApiError.notFound('active legal hold');
    }
    const hold = rows[0];
    // Re-arm purges this hold was blocking: tasks parked in `blocked` for the
    // released scope return to `check_holds` so the next worker tick resumes
    // them. Without this, `blocked` is a dead end — claimOne only picks up
    // pending/in_progress — and release would never unblock anything.
    // Scope predicate mirrors stepCheckHolds: org-wide holds cover every task
    // in the org, scoped holds cover their exact (scopeType, scopeId).
    const scopeMatch =
      hold.scopeType === 'organization' || hold.scopeId === null
        ? undefined
        : and(eq(purgeTasks.scopeType, hold.scopeType), eq(purgeTasks.scopeId, hold.scopeId));
    await this.db.withBypass(async (tx) => {
      await tx
        .update(purgeTasks)
        .set({ state: 'in_progress', step: 'check_holds', lastError: null, lockedAt: null })
        .where(
          scopeMatch === undefined
            ? and(eq(purgeTasks.organizationId, input.orgId), eq(purgeTasks.state, 'blocked'))
            : and(eq(purgeTasks.organizationId, input.orgId), eq(purgeTasks.state, 'blocked'), scopeMatch),
        );
    });
    return hold;
  }

  async listHolds(orgId: string): Promise<Array<typeof legalHolds.$inferSelect>> {
    assertUuid(orgId, 'orgId');
    return this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(legalHolds)
        .where(eq(legalHolds.organizationId, orgId))
        .orderBy(desc(legalHolds.placedAt))
        .limit(100),
    );
  }
}
