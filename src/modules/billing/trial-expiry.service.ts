import { and, isNotNull, lt, eq } from 'drizzle-orm';
import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { EventBus, EngineEvents } from '../../common/events/event-bus';
import { productEntitlements } from '../organizations/schema';
import { EntitlementsService } from '../organizations/entitlements.service';

/**
 * The trial-expiry sweep (H-3): trials carry a `period_end` (set by the
 * console/studio start paths) but nothing moved them past it — the sweep
 * closes that loop. Every expired trial transitions through the platform
 * state machine (trial → expired; renewal re-enters at active) via
 * EntitlementsService.transition, so each expiry is validated and audited
 * exactly like every other entitlement move. An `entitlement.expired`
 * event lands on the bus per expiry for notification/webhook sinks.
 *
 * Runs as a repeatable BullMQ job on the billing: namespace (see
 * billing.worker.ts). The sweep is idempotent — a re-run finds nothing,
 * because the transition moves the row out of `trial`.
 */
@Injectable()
export class TrialExpiryService {
  private static readonly logger = new Logger(TrialExpiryService.name);

  constructor(
    private readonly db: DbService,
    private readonly entitlements: EntitlementsService,
    private readonly events: EventBus,
  ) {}

  async sweep(now = new Date()): Promise<{ scanned: number; expired: number }> {
    const rows = await this.db.withBypass((tx) =>
      tx
        .select({ id: productEntitlements.id, orgId: productEntitlements.orgId, product: productEntitlements.product })
        .from(productEntitlements)
        .where(and(eq(productEntitlements.status, 'trial'), isNotNull(productEntitlements.periodEnd), lt(productEntitlements.periodEnd, now.toISOString()))),
    );

    let expired = 0;
    for (const row of rows) {
      try {
        await this.entitlements.transition({
          orgId: row.orgId,
          product: row.product,
          target: 'expired',
          source: 'billing.dunning',
          actorId: 'system',
        });
      } catch (err) {
        // A concurrent move (renewal, suspension) lost the race — never fatal
        // to the sweep; the next pass simply won't see the row.
        TrialExpiryService.logger.warn(`trial expiry skipped ${row.orgId}/${row.product}: ${(err as Error).message}`);
        continue;
      }
      await this.events.emit(EngineEvents.EntitlementExpired, { orgId: row.orgId, product: row.product });
      expired += 1;
    }
    return { scanned: rows.length, expired };
  }
}
