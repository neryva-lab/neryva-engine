import { Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { OutboxEvent } from '../common/infra/outbox/schema';
import type { OutboxConsumer } from '../common/infra/outbox/consumer';
import { DbService } from '../common/infra/db/db.service';
import { uuidv7 } from '../common/ids/uuidv7';
import { ApiError } from '../common/http/api-error';
import { ConversationsService } from '../modules/conversations/conversations.service';
import { evalCases, evalCaseExecutions, evalRuns } from '../modules/knowledge/eval.schema';

/**
 * Eval executor — REL-2.1/REL-2.2 (release_ledger.md), GAP-03: the consumer
 * `eval.run_requested` never had. The interim engine-side harness executes
 * text-only cases through the SAME conversation plane a real message takes:
 * a fresh conversation per (case, attempt), acceptMessage pinned to the
 * eval'd version with run_kind='eval' (non-billable), an idempotency key per
 * execution so redelivery can never duplicate cases. Scoring happens in
 * EvalScoringConsumer on the terminal run events; this consumer only creates
 * durable work.
 *
 * LLM-judge rubrics and state assertions remain Studio eval-worker territory
 * (evalResultsSchema's worker half) — the interim harness scores lexical
 * assertions only and says so in worker_provenance.
 */
@Injectable()
export class EvalExecutorConsumer implements OutboxConsumer {
  private static readonly logger = new Logger(EvalExecutorConsumer.name);
  /** Per-event cap: one oversized dataset cannot monopolize a dispatch tick. */
  private static readonly EXECUTIONS_PER_TICK = 50;

  readonly name = 'eval-executor';
  readonly eventTypes = ['eval.run_requested'];

  constructor(
    private readonly db: DbService,
    private readonly conversations: ConversationsService,
  ) {}

  async handle(event: OutboxEvent): Promise<void> {
    const payload = (event.payload ?? {}) as {
      eval_run_id?: string;
      dataset_id?: string;
      assistant_version_id?: string;
      attempts_per_case?: number;
    };
    const evalRunId = payload.eval_run_id;
    const datasetId = payload.dataset_id;
    const versionId = payload.assistant_version_id;
    const attempts = Math.min(Math.max(1, Number(payload.attempts_per_case ?? 1)), 5);
    if (!evalRunId || !datasetId || !versionId) {
      throw new Error('eval.run_requested payload missing eval_run_id/dataset_id/assistant_version_id');
    }

    // Claim phase (single TX): mark the run running and claim missing
    // (case, attempt) executions idempotently — a re-driven event adds
    // nothing and returns only executions that still lack a conversation.
    const claimed = await this.db.withOrg(event.organizationId, async (tx) => {
      await tx
        .update(evalRuns)
        .set({ state: 'running' })
        .where(and(eq(evalRuns.id, evalRunId), inArray(evalRuns.state, ['pending', 'running'])));
      const cases = await tx
        .select({ id: evalCases.id, input: evalCases.input })
        .from(evalCases)
        .where(and(eq(evalCases.organizationId, event.organizationId), eq(evalCases.datasetId, datasetId)));
      const values: Array<typeof evalCaseExecutions.$inferInsert> = [];
      for (const c of cases) {
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
          values.push({
            id: uuidv7(),
            organizationId: event.organizationId,
            evalRunId,
            caseId: c.id,
            attempt,
            state: 'pending',
          });
        }
      }
      if (values.length > 0) {
        await tx.insert(evalCaseExecutions).values(values).onConflictDoNothing();
      }
      const pending = await tx
        .select()
        .from(evalCaseExecutions)
        .where(
          and(
            eq(evalCaseExecutions.organizationId, event.organizationId),
            eq(evalCaseExecutions.evalRunId, evalRunId),
            eq(evalCaseExecutions.state, 'pending'),
            isNull(evalCaseExecutions.conversationId),
          ),
        );
      const inputByCase = new Map(cases.map((c) => [c.id, (c.input as { text?: unknown }).text]));
      return { pending, inputByCase };
    });

    if (claimed.pending.length === 0) {
      return; // everything already dispatched (idempotent redelivery)
    }

    // The eval'd version's assistant — conversations belong to assistants.
    const versionRows = await this.db.withOrg(event.organizationId, (tx) =>
      tx.execute<{ assistant_id: string }>(sql`select assistant_id from assistant_versions where id = ${versionId}::uuid limit 1`),
    );
    const assistantId = (versionRows.rows[0] as { assistant_id: string } | undefined)?.assistant_id;
    if (!assistantId) {
      throw new Error(`eval run ${evalRunId} references missing assistant version ${versionId}`);
    }

    let dispatched = 0;
    for (const execution of claimed.pending) {
      if (dispatched >= EvalExecutorConsumer.EXECUTIONS_PER_TICK) {
        break; // the accepted-run sweep and redelivery drive the remainder
      }
      const caseText = claimed.inputByCase.get(execution.caseId);
      if (typeof caseText !== 'string' || caseText.length === 0) {
        await this.markExecutionFailed(execution.id, event.organizationId, 'case input is missing or not text-only');
        dispatched += 1;
        continue;
      }
      try {
        const conversation = await this.conversations.createConversation({
          orgId: event.organizationId,
          assistantId,
          createdBy: 'engine:eval-executor',
          participantScope: 'org',
        });
        const accepted = await this.conversations.acceptMessage({
          orgId: event.organizationId,
          principalId: 'engine:eval-executor',
          conversationId: conversation.id,
          content: { text: caseText.slice(0, 8192) },
          idempotencyKey: `eval:${evalRunId}:${execution.caseId}:${execution.attempt}`,
          pinVersionId: versionId,
          runKind: 'eval',
        });
        await this.db.withOrg(event.organizationId, (tx) =>
          tx
            .update(evalCaseExecutions)
            .set({ conversationId: conversation.id, runId: accepted.run_id, updatedAt: new Date().toISOString() })
            .where(eq(evalCaseExecutions.id, execution.id)),
        );
        dispatched += 1;
      } catch (err) {
        if (err instanceof ApiError && err.retryability === 'no-retry') {
          // The case can never run (retired pin, validation, policy — R-2
          // admits DRAFT + PUBLISHED pins, both snapshot-gated): record it as
          // failed so the eval can COMPLETE honestly instead of hanging, then
          // keep going. Transient failures rethrow → outbox retry.
          await this.markExecutionFailed(execution.id, event.organizationId, `accept failed: ${(err as Error).message}`.slice(0, 512));
          dispatched += 1;
          continue;
        }
        throw err;
      }
    }
    EvalExecutorConsumer.logger.log(`eval run ${evalRunId}: dispatched ${dispatched}/${claimed.pending.length} case executions`);
  }

  private async markExecutionFailed(executionId: string, orgId: string, reason: string): Promise<void> {
    await this.db.withOrg(orgId, (tx) =>
      tx
        .update(evalCaseExecutions)
        .set({ state: 'failed', failureReason: reason, updatedAt: new Date().toISOString() })
        .where(eq(evalCaseExecutions.id, executionId)),
    );
  }
}
