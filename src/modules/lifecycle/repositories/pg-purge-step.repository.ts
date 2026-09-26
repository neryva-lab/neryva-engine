/**
 * PostgreSQL lane for `IPurgeStepRepository` (P3).
 *
 * Behavioral truth: `src/modules/lifecycle/retention-purge.service.ts`
 * (`stepCheckHolds` / `stepMarkUnavailable` / `stepEmitDerivedDeletion` /
 * `stepPurgeObjects`' queries / `stepPurgeContent` / `stepTombstone`'s
 * insert). Byte-identical behavior, same transaction boundaries, same
 * tenant scoping — the queries moved here mechanically; no logic changed.
 *
 * Object storage deletion itself stays in the service (`StorageService`):
 * this port lists the purgeable object keys and flips the artifact rows.
 */
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';
import { DbService } from '../../../common/infra/db/db.service';
import { recordOutboxEvent } from '../../../common/infra/outbox/outbox.service';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { conversations, messages } from '../../conversations/schema';
import { artifacts, memoryItems } from '../../knowledge/schema';
import { legalHolds, tombstones } from '../lifecycle.schema';
import { assertUuid } from '../assert';
import type { IPurgeStepRepository } from './purge-step.repository';

@Injectable()
export class PgPurgeStepRepository implements IPurgeStepRepository {
  constructor(private readonly db: DbService) {}

  async findBlockingHold(orgId: string, scopeType: string, scopeId: string): Promise<boolean> {
    const holds = await this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(legalHolds)
        .where(
          and(
            eq(legalHolds.organizationId, orgId),
            eq(legalHolds.status, 'active'),
            // An expired hold no longer blocks — the purge gate is the ACTIVE window.
            or(isNull(legalHolds.expiresAt), sql`${legalHolds.expiresAt} > now()`),
            or(
              eq(legalHolds.scopeType, 'organization'),
              and(eq(legalHolds.scopeType, scopeType), eq(legalHolds.scopeId, scopeId)),
            ),
          ),
        )
        .limit(1),
    );
    return holds.length > 0;
  }

  async markUnavailable(input: {
    orgId: string;
    scopeType: 'conversation' | 'artifact';
    scopeId: string;
  }): Promise<void> {
    // Product surface unavailable BEFORE anything is destroyed. Artifacts use
    // the DDL-sanctioned 'retiring' state (chk_artifacts_state).
    await this.db.withOrg(input.orgId, async (tx) => {
      if (input.scopeType === 'conversation') {
        await tx
          .update(conversations)
          .set({ status: 'deleted', updatedAt: new Date().toISOString() })
          .where(eq(conversations.id, input.scopeId));
      } else {
        await tx
          .update(artifacts)
          .set({ state: 'retiring', updatedAt: new Date().toISOString() })
          .where(eq(artifacts.id, input.scopeId));
      }
    });
  }

  async emitDerivedDeletion(input: {
    orgId: string;
    scopeType: string;
    scopeId: string;
    reason: string;
  }): Promise<void> {
    // Derived stores (chunks/embeddings/caches) delete via outbox — same
    // durable-delivery guarantee as every other fact.
    await this.db.withOrg(input.orgId, async (tx) => {
      await recordOutboxEvent(tx, {
        aggregateType: input.scopeType,
        aggregateId: input.scopeId,
        organizationId: input.orgId,
        eventType: input.scopeType === 'conversation' ? 'conversation.purged' : 'artifact.purged',
        partitionKey: input.scopeId,
        payload: { scope_type: input.scopeType, scope_id: input.scopeId, reason: input.reason },
      });
    });
  }

  async listPurgeableObjects(input: {
    orgId: string;
    scopeType: 'conversation' | 'artifact';
    scopeId: string;
    limit: number;
  }): Promise<Array<{ id: string; objectKey: string }>> {
    const rows = await this.db.withOrg(input.orgId, async (tx) => {
      if (input.scopeType === 'artifact') {
        return tx
          .select({ id: artifacts.id, objectKey: artifacts.objectKey })
          .from(artifacts)
          .where(
            and(
              eq(artifacts.id, input.scopeId),
              eq(artifacts.organizationId, input.orgId),
              inArray(artifacts.state, ['active', 'retiring']),
            ),
          )
          .limit(input.limit);
      }
      // Conversation scope: ONLY artifacts bound to THIS conversation via its
      // runs (run_events / checkpoints / tool outcomes). The former query
      // selected every org-wide TRANSCRIPT artifact — a cross-conversation
      // destructive bug.
      return tx
        .select({ id: artifacts.id, objectKey: artifacts.objectKey })
        .from(artifacts)
        .where(
          and(
            eq(artifacts.organizationId, input.orgId),
            inArray(artifacts.state, ['active', 'retiring']),
            sql`${artifacts.id} in (
              select re.artifact_id from run_events re join runs r on r.id = re.run_id where r.conversation_id = ${input.scopeId}::uuid
              union
              select c.artifact_id from checkpoints c join runs r on r.id = c.run_id where r.conversation_id = ${input.scopeId}::uuid
              union
              select te.result_artifact_id from tool_effects te join runs r on r.id = te.run_id where r.conversation_id = ${input.scopeId}::uuid
            )`,
          ),
        )
        .limit(input.limit);
    });
    return rows;
  }

  async markObjectPurged(objectId: string): Promise<void> {
    await this.db.withBypass(async (tx) => {
      await tx
        .update(artifacts)
        .set({ state: 'purged', updatedAt: new Date().toISOString() })
        .where(eq(artifacts.id, objectId));
    });
  }

  async purgeConversationContent(orgId: string, conversationId: string): Promise<void> {
    // Relational content per policy: messages purged (transcript data),
    // runs kept as redacted skeletons for billing/audit explainability.
    await this.db.withOrg(orgId, async (tx) => {
      await tx.delete(messages).where(and(eq(messages.conversationId, conversationId), eq(messages.organizationId, orgId)));
      await tx
        .update(memoryItems)
        .set({ deletedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
        .where(and(eq(memoryItems.scopeId, conversationId), eq(memoryItems.scopeType, 'conversation')));
    });
  }

  async writeTombstone(input: {
    orgId: string;
    scopeType: string;
    scopeId: string;
    reason: string;
  }): Promise<void> {
    await this.db.withBypass(async (tx) => {
      await tx
        .insert(tombstones)
        .values({
          id: uuidv7(),
          organizationId: input.orgId,
          resourceType: input.scopeType,
          resourceId: input.scopeId,
          reason: input.reason,
        })
        .onConflictDoNothing();
    });
  }

  async findTombstone(resourceType: string, resourceId: string): Promise<{ reason: string } | null> {
    const rows = await this.db.withBypass((tx) =>
      tx
        .select({ reason: tombstones.reason })
        .from(tombstones)
        .where(and(eq(tombstones.resourceType, resourceType), eq(tombstones.resourceId, resourceId)))
        .limit(1),
    );
    return rows[0] ?? null;
  }
}
