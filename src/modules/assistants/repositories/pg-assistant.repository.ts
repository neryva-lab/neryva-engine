/**
 * PostgreSQL `IAssistantRepository` — the assistant aggregate root.
 *
 * Transaction ownership: every mutating method owns its `withOrg` /
 * `withBypass` boundary (the caller never passes a tx). Reads use the
 * matching boundary so RLS (`app.current_tenant`) always applies.
 * Row-lock semantics of the degraded sweeps (`FOR UPDATE SKIP LOCKED`)
 * are preserved verbatim from the pre-extraction service.
 */
import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { pgViolation } from '../../../common/infra/db/pg-types';
import { ApiError } from '../../../common/http/api-error';
import { conversations } from '../../conversations/schema';
import type { Assistant } from '../schema';
import { assistants, assistantVersions } from '../schema';
import type { IAssistantRepository, VersionPayloadValues } from './assistant.repository';

const LIST_CAP = 200;
const SWEEP_CAP = 100;

/**
 * Unique-violation → typed conflict mapping, byte-identical to the
 * pre-extraction service's `mapAssistantUniqueViolation`.
 */
export function mapAssistantUniqueViolation(err: unknown, name: string): unknown {
  // drizzle wraps driver errors (DrizzleQueryError.cause) — read code via pgViolation or raw 23505s escape.
  const pg = pgViolation(err);
  if (pg.code !== '23505') {
    return err;
  }
  if (pg.constraint === 'uq_assistants_org_name') {
    return ApiError.conflict(
      'assistant name already taken in this organization — supply a distinct name',
      { name },
    );
  }
  if (pg.constraint === 'uq_assistant_versions_assistant_version') {
    return ApiError.conflict(
      'a draft version already exists for this assistant — publish or delete it before drafting another',
      { reason: 'draft_exists' },
    );
  }
  return err;
}

@Injectable()
export class PgAssistantRepository implements IAssistantRepository {
  constructor(private readonly db: DbService) {}

  async createAssistant(input: {
    orgId: string;
    name: string;
    description?: string | null;
  }): Promise<Assistant> {
    try {
      const rows = await this.db.withOrg(input.orgId, (tx) =>
        tx
          .insert(assistants)
          .values({
            organizationId: input.orgId,
            name: input.name.trim(),
            description: input.description?.trim() ?? null,
          })
          .returning(),
      );
      return rows[0];
    } catch (err) {
      throw mapAssistantUniqueViolation(err, input.name);
    }
  }

  async createAssistantWithDraftVersion(input: {
    orgId: string;
    name: string;
    description?: string | null;
    versionValues: VersionPayloadValues;
  }): Promise<{ assistant: Assistant; versionId: string }> {
    // One transaction: assistant identity + DRAFT version commit together —
    // a failed version insert must never leave a versionless assistant.
    try {
      const created = await this.db.withOrg(input.orgId, async (tx) => {
        const assistantRows = await tx
          .insert(assistants)
          .values({
            organizationId: input.orgId,
            name: input.name.trim(),
            description: input.description?.trim() ?? null,
          })
          .returning();
        const versionRows = await tx
          .insert(assistantVersions)
          .values({
            assistantId: assistantRows[0].id,
            organizationId: input.orgId,
            version: 0, // sentinel for DRAFT — publish assigns monotonic version
            status: 'DRAFT',
            modelPolicy: input.versionValues.modelPolicy,
            contextPolicy: input.versionValues.contextPolicy,
            toolPolicy: input.versionValues.toolPolicy,
            knowledgePolicy: input.versionValues.knowledgePolicy ?? null,
            guardrailPolicy: input.versionValues.guardrailPolicy,
            instructions: input.versionValues.instructions ?? null,
            modelParams: input.versionValues.modelParams ?? null,
            budgetPolicy: input.versionValues.budgetPolicy ?? null,
            brand: input.versionValues.brand ?? null,
            hash: input.versionValues.hash,
            parentVersionId: input.versionValues.parentVersionId ?? null,
          })
          .returning({ id: assistantVersions.id });
        return { assistant: assistantRows[0], versionId: versionRows[0].id };
      });
      return created;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw mapAssistantUniqueViolation(err, input.name);
    }
  }

  async getAssistant(orgId: string, assistantId: string): Promise<Assistant | null> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx.select().from(assistants).where(eq(assistants.id, assistantId)).limit(1),
    );
    return rows[0] ?? null;
  }

  async listAssistants(orgId: string): Promise<Assistant[]> {
    return this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(assistants)
        .where(eq(assistants.organizationId, orgId))
        .orderBy(desc(assistants.updatedAt))
        .limit(LIST_CAP),
    );
  }

  async deleteAssistantWithRetiredConversations(
    orgId: string,
    assistantId: string,
  ): Promise<{ name: string; conversationsRemoved: number }> {
    let retiredCount = 0;
    let deletedName = '';
    try {
      await this.db.withOrg(orgId, async (tx) => {
        // Active conversations block deletion; archived/deleted ones are
        // removed below.
        const active = await tx
          .select({ id: conversations.id })
          .from(conversations)
          .where(
            and(
              eq(conversations.assistantId, assistantId),
              eq(conversations.status, 'active'),
            ),
          )
          .limit(1);
        if (active.length > 0) {
          throw ApiError.conflict(
            'assistant has active conversations — archive them before deleting',
          );
        }
        const retired = await tx
          .delete(conversations)
          .where(
            and(
              eq(conversations.assistantId, assistantId),
              inArray(conversations.status, ['archived', 'deleted']),
            ),
          )
          .returning({ id: conversations.id });
        retiredCount = retired.length;
        const rows = await tx.delete(assistants).where(eq(assistants.id, assistantId)).returning();
        if (rows.length === 0) {
          throw ApiError.notFound('assistant');
        }
        deletedName = rows[0].name;
      });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      // FK violation — an active conversation landed between the check and
      // the delete (race); the caller should archive and retry.
      throw ApiError.conflict('assistant has active conversations — archive them before deleting');
    }
    return { name: deletedName, conversationsRemoved: retiredCount };
  }

  async setDisabled(
    orgId: string,
    assistantId: string,
    disabled: boolean,
    opts: { reason?: string; actorId: string },
  ): Promise<Assistant> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .update(assistants)
        .set(
          disabled
            ? {
                disabledAt: new Date().toISOString(),
                disabledBy: opts.actorId.slice(0, 128),
                disabledReason: (opts.reason ?? 'operator kill switch').slice(0, 512),
                updatedAt: new Date().toISOString(),
              }
            : {
                disabledAt: null,
                disabledBy: null,
                disabledReason: null,
                updatedAt: new Date().toISOString(),
              },
        )
        .where(eq(assistants.id, assistantId))
        .returning(),
    );
    if (rows.length === 0) {
      throw ApiError.notFound('assistant');
    }
    return rows[0];
  }

  async claimOverdueDegradedAssistants(input: {
    orgId?: string;
  }): Promise<Array<{ orgId: string; assistantId: string; name: string }>> {
    const orgFilter =
      input.orgId === undefined ? sql`` : sql`and assistants.organization_id = ${input.orgId}::uuid`;
    const overdue = await this.db.withBypass(async (tx) => {
      const rows = await tx.execute(sql`
        select id, organization_id, name from assistants
        where degraded_until is not null
          and degraded_until < now()
          and disabled_at is null
          ${orgFilter}
        limit ${SWEEP_CAP}
        for update skip locked
      `);
      return rows.rows as Array<{ id: string; organization_id: string; name: string }>;
    });
    return overdue.map((row) => ({
      orgId: row.organization_id,
      assistantId: row.id,
      name: row.name,
    }));
  }

  async claimDueSoonDegradedAssistants(input: {
    orgId?: string;
  }): Promise<Array<{ orgId: string; assistantId: string; name: string }>> {
    const orgFilter =
      input.orgId === undefined ? sql`` : sql`and assistants.organization_id = ${input.orgId}::uuid`;
    const soon = await this.db.withBypass(async (tx) => {
      const rows = await tx.execute(sql`
        select id, organization_id, name from assistants
        where degraded_until is not null
          and degraded_until >= now()
          and degraded_until < now() + interval '24 hours'
          and degraded_alerted_at is null
          and disabled_at is null
          ${orgFilter}
        limit ${SWEEP_CAP}
        for update skip locked
      `);
      return rows.rows as Array<{ id: string; organization_id: string; name: string }>;
    });
    return soon.map((row) => ({
      orgId: row.organization_id,
      assistantId: row.id,
      name: row.name,
    }));
  }

  async markDegradedAlerted(assistantId: string): Promise<void> {
    await this.db.withBypass(async (tx) => {
      await tx.execute(sql`
        update assistants set degraded_alerted_at = now()
        where id = ${assistantId}::uuid and degraded_alerted_at is null
      `);
    });
  }
}
