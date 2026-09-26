/**
 * MongoDB lane for {@link IReconciliationRepository} (P3, phases 8.7/8.8).
 * Mirrors `PgReconciliationRepository` method-for-method: the consistency
 * pass flags negative non-compensating entries and unbalanced reversals
 * (never silently fixing them), and the webhook inbox is idempotent by
 * (provider, provider_event_id) with a typed conflict on payload-hash
 * reuse.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { Binary } from 'mongodb';
import { ApiError } from '../../../common/http/api-error';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { uuidv7 } from '../../../common/ids/uuidv7';
import type { BillingWebhookInboxRow } from '../usage-ledger.schema';
import {
  binUuid,
  ensureBillingIndexes,
  isDuplicateKey,
  requireOrg,
  tenantCollection,
  toWebhookInbox,
  type BillingWebhookInboxMongoDoc,
  type ProviderReconciliationRunMongoDoc,
  type UsageLedgerEntryMongoDoc,
} from './mongo-documents';
import type { IReconciliationRepository, IngestWebhookInput } from './reconciliation.repository';

const RUNS = 'provider_reconciliation_runs';
const INBOX = 'billing_webhook_inbox';
const LEDGER = 'usage_ledger_entries';

@Injectable()
export class MongoReconciliationRepository implements IReconciliationRepository {
  private static readonly logger = new Logger(MongoReconciliationRepository.name);

  constructor(private readonly mongo: MongoDbService) {}

  async runConsistencyPass(
    orgId: string,
    provider: string,
  ): Promise<{ runId: string; checked: number; discrepancies: number; findings: string[] }> {
    const runId = uuidv7();
    const findings: string[] = [];
    let checked = 0;

    await this.mongo.withOrg(orgId, async (ctx) => {
      const org = requireOrg(ctx);
      const session = { session: ctx.session };
      const runs = tenantCollection<ProviderReconciliationRunMongoDoc>(this.mongo.root, RUNS, 'organization_id');
      const ledger = tenantCollection<UsageLedgerEntryMongoDoc>(this.mongo.root, LEDGER, 'organization_id');

      await runs.insertOne(
        org,
        {
          id: binUuid(runId, 'runId'),
          organization_id: binUuid(org),
          provider,
          state: 'running',
          entries_checked: 0,
          discrepancies: 0,
          result_ref: null,
          started_at: new Date().toISOString(),
          finished_at: null,
        },
        session,
      );

      // Negative non-compensating quantities are anomalies.
      const negatives = await ledger
        .find(org, { $expr: { $and: [{ $lt: [{ $toDouble: '$quantity' }, 0] }, { $eq: ['$reversal_of', null] }] } }, session)
        .toArray();
      for (const row of negatives) {
        findings.push(`negative quantity without compensation: ${row.usage_event_id}`);
        await ledger.updateOne(org, { id: row.id }, { $set: { reconciliation_state: 'discrepant' } }, session);
      }

      // Unbalanced reversals: original plus compensations must net >= 0.
      const unbalanced = (await ledger.aggregate(
        org,
        [
          { $match: { reversal_of: null } },
          {
            $lookup: {
              from: LEDGER,
              let: { originalId: '$id' },
              pipeline: [{ $match: { $expr: { $eq: ['$reversal_of', '$$originalId'] } } }],
              as: 'compensations',
            },
          },
          {
            $project: {
              id: 1,
              usage_event_id: 1,
              net: {
                $add: [
                  { $toDouble: '$quantity' },
                  { $sum: { $map: { input: '$compensations', as: 'c', in: { $toDouble: '$$c.quantity' } } } },
                ],
              },
            },
          },
          { $match: { net: { $lt: 0 } } },
        ],
        session,
      ).toArray()) as unknown as ({ _id: unknown; id: Binary; usage_event_id: string; net: number })[];
      for (const row of unbalanced) {
        findings.push(`reversals overdraw original: ${row.usage_event_id}`);
        await ledger.updateOne(org, { id: row.id }, { $set: { reconciliation_state: 'discrepant' } }, session);
      }

      checked = await ledger.countDocuments(org, {}, session);

      await runs.updateOne(
        org,
        { id: binUuid(runId, 'runId') },
        {
          $set: {
            state: 'completed',
            entries_checked: checked,
            discrepancies: findings.length,
            result_ref: { findings },
            finished_at: new Date().toISOString(),
          },
        },
        session,
      );
    });

    if (findings.length > 0) {
      MongoReconciliationRepository.logger.warn(
        `reconciliation run ${runId} found ${findings.length} discrepancies for org ${orgId}`,
      );
    }
    return { runId, checked, discrepancies: findings.length, findings };
  }

  async ingestWebhook(input: IngestWebhookInput): Promise<{ row: BillingWebhookInboxRow; duplicate: boolean }> {
    await ensureBillingIndexes(this.mongo.root);
    return this.mongo.withBypass(async (ctx) => {
      const db = this.mongo.root;
      const session = { session: ctx.session };
      const doc: BillingWebhookInboxMongoDoc = {
        id: binUuid(uuidv7()),
        provider: input.provider,
        provider_event_id: input.providerEventId,
        state: input.signatureResult === 'valid' ? 'signature_validated' : 'rejected',
        signature_result: input.signatureResult,
        payload_hash: input.payloadHash,
        payload_ref: input.payloadRef ?? null,
        processing_result: null,
        reconciliation_status: 'none',
        received_at: new Date().toISOString(),
        processed_at: null,
      };
      try {
        await db.collection<BillingWebhookInboxMongoDoc>(INBOX).insertOne(doc, session);
        return { row: toWebhookInbox(doc), duplicate: false };
      } catch (err) {
        if (!isDuplicateKey(err)) {
          throw err;
        }
      }
      const existing = await db.collection<BillingWebhookInboxMongoDoc>(INBOX).findOne(
        { provider: input.provider, provider_event_id: input.providerEventId },
        session,
      );
      if (!existing) {
        throw ApiError.conflict('webhook event collision');
      }
      if (existing.payload_hash !== input.payloadHash) {
        throw ApiError.conflict('provider event id reuse with different payload', {
          provider_event_id: input.providerEventId,
        });
      }
      return { row: toWebhookInbox(existing), duplicate: true };
    });
  }

  async markWebhookProcessed(id: string, processingResult: Record<string, unknown>): Promise<void> {
    await this.mongo.withBypass(async (ctx) => {
      await this.mongo.root.collection<BillingWebhookInboxMongoDoc>(INBOX).updateOne(
        { id: binUuid(id, 'id') },
        {
          $set: {
            state: 'processed',
            processing_result: processingResult,
            processed_at: new Date().toISOString(),
            reconciliation_status: 'completed',
          },
        },
        { session: ctx.session },
      );
    });
  }

  async markWebhookRequiresReconciliation(id: string, reason: string): Promise<void> {
    await this.mongo.withBypass(async (ctx) => {
      await this.mongo.root.collection<BillingWebhookInboxMongoDoc>(INBOX).updateOne(
        { id: binUuid(id, 'id') },
        {
          $set: {
            state: 'reconciliation_required',
            processing_result: { reason },
            processed_at: new Date().toISOString(),
            reconciliation_status: 'required',
          },
        },
        { session: ctx.session },
      );
    });
  }
}
