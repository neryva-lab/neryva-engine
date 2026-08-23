import { Injectable, Logger } from '@nestjs/common';
import { inArray } from 'drizzle-orm';
import { z } from 'zod';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { env } from '../../common/config/env';
import { legacyTenants } from '../../common/infra/db/legacy-schema';
import { ManifestRegistryService } from '../console/manifest-registry.service';
import { projects } from '../organizations/schema';
import { NewSpendEvent, spendEvents } from './schema';
import { PriceCatalogService } from './price-catalog.service';
import { meteringIngestRows } from '../../common/observability/metrics';

/**
 * The engine metering ingest plane (B-1): satellites push spend events in
 * batches over L3. Contract rules enforced HERE, not by trust:
 *
 *  - product must be a REGISTERED product key (the manifest registry is the
 *    authority — untagged or misspelled spend is rejected, which is what
 *    makes per-product billing trustworthy)
 *  - org must exist (a typo'd org id can never create ghost ledgers)
 *  - project, when present, must belong to the org (RLS would allow the
 *    insert because we set the tenant context; the pre-check keeps the
 *    ledger clean instead)
 *  - idempotency by (source, event_id): retries never double-bill
 *  - batches are capped; per-row failures are reported without failing the
 *    whole batch (one poison row must not block a satellite's stream)
 */
export const MAX_INGEST_BATCH = 500;

const isoTimestamp = z
  .string()
  .refine((v) => Number.isFinite(Date.parse(v)), 'occurred_at must be an ISO-8601 timestamp');

export const spendEventInputSchema = z.object({
  event_id: z.string().min(1).max(160),
  org_id: z.string().regex(/^[0-9a-fA-F-]{36}$/, 'org_id must be a 36-char tenant id'),
  product: z.string().min(1).max(64),
  project_id: z.string().uuid().optional().nullable(),
  surface: z.string().min(1).max(128).optional().nullable(),
  end_user_id: z.string().min(1).max(64).optional().nullable(),
  kind: z.string().min(1).max(32).default('inference'),
  model: z.string().min(1).max(128).optional().nullable(),
  tokens_in: z.number().int().min(0).max(2_000_000_000).optional().nullable(),
  tokens_out: z.number().int().min(0).max(2_000_000_000).optional().nullable(),
  cost_usd: z.number().min(0).max(1_000_000),
  occurred_at: isoTimestamp,
  meta: z.record(z.unknown()).optional().nullable(),
});

export type SpendEventInput = z.infer<typeof spendEventInputSchema>;

export interface IngestResult {
  accepted: number;
  duplicates: number;
  rejected: Array<{ index: number; reason: string }>;
}

@Injectable()
export class SpendIngestService {
  private static readonly logger = new Logger(SpendIngestService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly manifests: ManifestRegistryService,
    private readonly prices: PriceCatalogService,
  ) {}

  async ingest(source: string, rawEvents: unknown[]): Promise<IngestResult> {
    if (!Array.isArray(rawEvents) || rawEvents.length === 0) {
      throw ApiError.validation({ events: 'a non-empty events array is required' });
    }
    if (rawEvents.length > MAX_INGEST_BATCH) {
      throw ApiError.validation({ events: `batch exceeds the ${MAX_INGEST_BATCH}-event cap — split the push` });
    }

    const rejected: Array<{ index: number; reason: string }> = [];
    const valid: Array<{ index: number; event: SpendEventInput }> = [];

    rawEvents.forEach((raw, index) => {
      const parsed = spendEventInputSchema.safeParse(raw);
      if (!parsed.success) {
        rejected.push({ index, reason: parsed.error.issues.map((i) => `${i.path.join('.') || 'event'}: ${i.message}`).join('; ') });
        return;
      }
      const event = parsed.data;
      // Registered-product rule: the metering tag must be a real product.
      const manifest = this.manifests.get(event.product);
      if (!manifest) {
        rejected.push({ index, reason: `product "${event.product}" is not a registered product key` });
        return;
      }
      valid.push({ index, event });
    });

    if (valid.length === 0) {
      throw ApiError.validation({ events: rejected.length > 0 ? rejected : 'no valid events' });
    }

    // Org existence + project ownership pre-checks (one query per distinct id).
    const orgIds = [...new Set(valid.map((v) => v.event.org_id))];
    const projectIds = [...new Set(valid.map((v) => v.event.project_id).filter((p): p is string => Boolean(p)))];
    const { existingOrgs, projectsByOrg } = await this.precheck(orgIds, projectIds);

    const perOrg = new Map<string, Array<{ index: number; event: SpendEventInput }>>();
    for (const { index, event } of valid) {
      if (!existingOrgs.has(event.org_id)) {
        rejected.push({ index, reason: `org_id "${event.org_id}" does not exist` });
        continue;
      }
      if (event.project_id && !projectsByOrg.get(event.org_id)?.has(event.project_id)) {
        rejected.push({ index, reason: `project_id "${event.project_id}" does not belong to org "${event.org_id}"` });
        continue;
      }
      const list = perOrg.get(event.org_id) ?? [];
      list.push({ index, event });
      perOrg.set(event.org_id, list);
    }

    let accepted = 0;
    let duplicates = 0;
    let unpriced = 0;
    let overridden = 0;
    for (const [orgId, events] of perOrg) {
      // Deduplicate within the batch itself (same event_id twice in one push).
      const seen = new Set<string>();
      const rows: NewSpendEvent[] = [];
      for (const { index, event } of events) {
        if (seen.has(event.event_id)) {
          rejected.push({ index, reason: `duplicate event_id "${event.event_id}" within the batch` });
          continue;
        }
        seen.add(event.event_id);

        // ── Platform-authoritative cost (the B-1 trust fix) ─────────────────
        // derive: catalog price wins when derivable; reported cost is
        //         advisory fallback (counted as unpriced).
        // enforce: unpriced or deviating >10% (min $0.01) from derived → row rejected.
        // trust:   reported cost passes through (documented compat mode).
        let costUsd = event.cost_usd;
        if (env.BILLING_COST_VALIDATION !== 'trust') {
          const occurredAt = new Date(event.occurred_at).toISOString();
          const derived = await this.prices.deriveCost({
            product: event.product,
            kind: event.kind,
            model: event.model ?? null,
            tokensIn: event.tokens_in ?? null,
            tokensOut: event.tokens_out ?? null,
            occurredAt,
          });
          if (derived === null) {
            if (env.BILLING_COST_VALIDATION === 'enforce') {
              rejected.push({ index, reason: `unpriced slot ${event.product}/${event.kind}${event.model ? `/${event.model}` : ''} — add a price catalog row` });
              continue;
            }
            unpriced += 1; // derive mode: fall back to reported cost
          } else {
            if (env.BILLING_COST_VALIDATION === 'enforce') {
              const tolerance = Math.max(0.1 * derived, 0.01);
              if (Math.abs(event.cost_usd - derived) > tolerance) {
                rejected.push({
                  index,
                  reason: `cost_usd ${event.cost_usd.toFixed(6)} deviates from derived ${derived.toFixed(6)} beyond tolerance`,
                });
                continue;
              }
            }
            if (Math.abs(derived - event.cost_usd) > 1e-9) {
              overridden += 1;
            }
            costUsd = derived;
          }
        }

        rows.push({
          eventId: event.event_id,
          source,
          orgId: event.org_id,
          product: event.product,
          projectId: event.project_id ?? null,
          surface: event.surface ?? null,
          endUserId: event.end_user_id ?? null,
          kind: event.kind,
          model: event.model ?? null,
          tokensIn: event.tokens_in ?? null,
          tokensOut: event.tokens_out ?? null,
          costUsd: costUsd.toFixed(6),
          meta: (event.meta ?? {}) as Record<string, unknown>,
          occurredAt: new Date(event.occurred_at).toISOString(),
        });
      }
      if (rows.length === 0) {
        continue;
      }
      const inserted = await this.db.withOrg(orgId, (tx) =>
        tx
          .insert(spendEvents)
          .values(rows)
          .onConflictDoNothing({ target: [spendEvents.source, spendEvents.eventId] })
          .returning({ id: spendEvents.id }),
      );
      accepted += inserted.length;
      duplicates += rows.length - inserted.length;
      meteringIngestRows.inc({ outcome: 'accepted' }, inserted.length);
      meteringIngestRows.inc({ outcome: 'duplicate' }, rows.length - inserted.length);
    }
    meteringIngestRows.inc({ outcome: 'rejected' }, rejected.length);

    await this.audit.add({
      action: 'billing.spend_ingested',
      resourceType: 'spend_batch',
      actorType: 'service',
      actorId: source,
      tenantId: perOrg.size === 1 ? [...perOrg.keys()][0] : null,
      details: {
        accepted,
        duplicates,
        rejected: rejected.length,
        ...(unpriced > 0 ? { unpriced_fallback: unpriced } : {}),
        ...(overridden > 0 ? { cost_overridden: overridden } : {}),
      },
    });
    if (rejected.length > 0) {
      SpendIngestService.logger.warn(`ingest from ${source}: ${rejected.length} row(s) rejected`);
    }
    return { accepted, duplicates, rejected };
  }

  private async precheck(
    orgIds: string[],
    projectIds: string[],
  ): Promise<{ existingOrgs: Set<string>; projectsByOrg: Map<string, Set<string>> }> {
    // tenants/projects are Python-owned/engine-shared tables without RLS —
    // explicit id filters, parameterized via inArray (never interpolation).
    const orgRows = await this.db.root
      .select({ id: legacyTenants.id })
      .from(legacyTenants)
      .where(inArray(legacyTenants.id, orgIds));
    const existingOrgs = new Set(orgRows.map((r) => r.id));

    const projectsByOrg = new Map<string, Set<string>>();
    if (projectIds.length > 0) {
      const projectRows = await this.db.root
        .select({ orgId: projects.orgId, id: projects.id })
        .from(projects)
        .where(inArray(projects.id, projectIds));
      for (const row of projectRows) {
        const set = projectsByOrg.get(row.orgId) ?? new Set<string>();
        set.add(row.id);
        projectsByOrg.set(row.orgId, set);
      }
    }
    return { existingOrgs, projectsByOrg };
  }
}
