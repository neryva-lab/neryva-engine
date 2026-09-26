/**
 * MongoDB lane for {@link IUsageLedgerRepository} (P3). Mirrors
 * `PgUsageLedgerRepository` method-for-method: 6dp quantity normalization,
 * insert-on-conflict (the defensive unique indexes) then reread,
 * idempotency-key payload comparison, compensating corrections with the
 * `correction:<event>:<rand8>` scheme, and the pending→discrepant flag.
 */
import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ApiError } from '../../../common/http/api-error';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { uuidv7 } from '../../../common/ids/uuidv7';
import type { UsageLedgerEntry } from '../usage-ledger.schema';
import {
  binUuid,
  ensureBillingIndexes,
  isDuplicateKey,
  requireOrg,
  tenantCollection,
  toUsageLedgerEntry,
  type UsageLedgerEntryMongoDoc,
} from './mongo-documents';
import type {
  AppendLedgerInput,
  CorrectLedgerInput,
  IUsageLedgerRepository,
} from './usage-ledger.repository';

const COLLECTION = 'usage_ledger_entries';

function normalizeQuantity(quantity: number): number {
  return Math.round(quantity * 1e6) / 1e6;
}

@Injectable()
export class MongoUsageLedgerRepository implements IUsageLedgerRepository {
  constructor(private readonly mongo: MongoDbService) {}

  async append(input: AppendLedgerInput): Promise<{ entry: UsageLedgerEntry; duplicate: boolean }> {
    await ensureBillingIndexes(this.mongo.root);
    const normalizedQuantity = normalizeQuantity(input.quantity);
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const org = requireOrg(ctx);
      const col = tenantCollection<UsageLedgerEntryMongoDoc>(this.mongo.root, COLLECTION, 'organization_id');
      const session = { session: ctx.session };
      const doc: UsageLedgerEntryMongoDoc = {
        id: binUuid(uuidv7()),
        organization_id: binUuid(org),
        usage_event_id: input.usageEventId,
        source_type: input.sourceType,
        source_id: input.sourceId ?? null,
        run_id: input.runId ? binUuid(input.runId, 'runId') : null,
        message_id: input.messageId ? binUuid(input.messageId, 'messageId') : null,
        usage_kind: input.usageKind,
        unit: input.unit,
        quantity: String(normalizedQuantity),
        provider: input.provider ?? null,
        model: input.model ?? null,
        estimated_cost: input.estimatedCost != null ? String(input.estimatedCost) : null,
        settled_cost: null,
        currency: 'USD',
        idempotency_key: input.idempotencyKey ?? null,
        reversal_of: null,
        reconciliation_state: 'pending',
        metadata: input.metadata ?? null,
        created_at: new Date().toISOString(),
      };
      try {
        await col.insertOne(org, doc, session);
        return { entry: toUsageLedgerEntry(doc), duplicate: false };
      } catch (err) {
        if (!isDuplicateKey(err)) {
          throw err;
        }
      }
      const existing = await col.findOne(org, { usage_event_id: input.usageEventId }, session);
      if (!existing) {
        // Idempotency-key conflict reported but the row is invisible — fail closed.
        throw ApiError.conflict('usage event collision');
      }
      if (input.idempotencyKey && existing.idempotency_key === input.idempotencyKey) {
        const payloadDelta = Math.abs(Number(existing.quantity) - normalizedQuantity);
        const payloadMatches =
          payloadDelta <= 1e-9 &&
          existing.usage_kind === input.usageKind &&
          existing.unit === input.unit &&
          (existing.run_id?.toUUID().toString() ?? null) === (input.runId ?? null) &&
          (existing.message_id?.toUUID().toString() ?? null) === (input.messageId ?? null);
        if (!payloadMatches) {
          throw ApiError.conflict('idempotency key reuse with different usage payload', {
            usage_event_id: input.usageEventId,
          });
        }
      }
      return { entry: toUsageLedgerEntry(existing), duplicate: true };
    });
  }

  async correct(input: CorrectLedgerInput): Promise<UsageLedgerEntry> {
    await ensureBillingIndexes(this.mongo.root);
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const org = requireOrg(ctx);
      const col = tenantCollection<UsageLedgerEntryMongoDoc>(this.mongo.root, COLLECTION, 'organization_id');
      const session = { session: ctx.session };
      const original = await col.findOne(org, { id: binUuid(input.originalEntryId, 'originalEntryId') }, session);
      if (!original) {
        throw ApiError.notFound('usage ledger entry');
      }
      if (original.reversal_of) {
        throw ApiError.validation({ entry: 'cannot reverse a compensating entry' });
      }
      const delta = input.quantityDelta ?? -Number(original.quantity);
      if (delta === 0) {
        throw ApiError.validation({ quantity: 'correction must be non-zero' });
      }
      if (input.costDelta !== undefined && input.costDelta !== null && !Number.isFinite(input.costDelta)) {
        throw ApiError.validation({ cost: 'cost correction must be a finite number' });
      }
      const correction: UsageLedgerEntryMongoDoc = {
        id: binUuid(uuidv7()),
        organization_id: binUuid(org),
        usage_event_id: `correction:${original.usage_event_id}:${randomUUID().slice(0, 8)}`,
        source_type: original.source_type,
        source_id: original.source_id,
        run_id: original.run_id,
        message_id: original.message_id,
        usage_kind: original.usage_kind,
        unit: original.unit,
        quantity: String(delta),
        provider: original.provider,
        model: original.model,
        estimated_cost: input.costDelta == null ? null : String(input.costDelta),
        settled_cost: null,
        currency: original.currency,
        idempotency_key: null,
        reversal_of: original.id,
        reconciliation_state: 'corrected',
        metadata: { reason: input.reason, actor: input.actor, original_quantity: original.quantity },
        created_at: new Date().toISOString(),
      };
      await col.insertOne(org, correction, session);
      // Mark the original discrepant only from pending — a concurrent
      // reconciliation pass wins the flag, not us.
      await col.updateOne(
        org,
        { id: original.id, reconciliation_state: 'pending' },
        { $set: { reconciliation_state: 'discrepant' } },
        session,
      );
      return toUsageLedgerEntry(correction);
    });
  }

  async listForRun(orgId: string, runId: string): Promise<UsageLedgerEntry[]> {
    return this.mongo.withOrg(orgId, async (ctx) => {
      const org = requireOrg(ctx);
      const col = tenantCollection<UsageLedgerEntryMongoDoc>(this.mongo.root, COLLECTION, 'organization_id');
      const docs = await col
        .find(org, { run_id: binUuid(runId, 'runId') }, { session: ctx.session, sort: { created_at: 1 } })
        .toArray();
      return docs.map(toUsageLedgerEntry);
    });
  }

  async netQuantity(orgId: string, usageKind: string, sinceIso?: string): Promise<number> {
    return this.mongo.withOrg(orgId, async (ctx) => {
      const org = requireOrg(ctx);
      const col = tenantCollection<UsageLedgerEntryMongoDoc>(this.mongo.root, COLLECTION, 'organization_id');
      const cursor = col.aggregate(
        org,
        [
          {
            $match: {
              usage_kind: usageKind,
              ...(sinceIso ? { created_at: { $gte: sinceIso } } : {}),
            },
          },
          { $group: { _id: null, net: { $sum: { $toDouble: '$quantity' } } } },
        ],
        { session: ctx.session },
      );
      const rows = (await cursor.toArray()) as unknown as ({ _id: null; net: number })[];
      return rows.length === 0 ? 0 : rows[0].net;
    });
  }
}
