import { Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { OutboxEvent } from '../common/infra/outbox/schema';
import type { OutboxConsumer } from '../common/infra/outbox/consumer';
import { DbService } from '../common/infra/db/db.service';
import { EvalService } from '../modules/knowledge/eval.service';
import { evalCases, evalCaseExecutions } from '../modules/knowledge/eval.schema';
import { messages } from '../modules/conversations/schema';

/**
 * Eval scoring — REL-2.2 (release_ledger.md). Consumes terminal run events
 * for runs that carry an eval_case_executions row: scores the assistant
 * response against the case's LEXICAL assertions (the interim engine-side
 * harness — no model call), folds the verdict into the execution row, and
 * when the last execution of an eval run settles, assembles the
 * evalResultsSchema payload and hands it to EvalService.completeRun, where
 * the decision engine (provenance, thresholds, regression bound) runs.
 *
 * run.failed settles its execution as failed — a harness run that dies must
 * complete its eval honestly, never hang it.
 */

/** Pure lexical scorer (exported for unit tests). Case-insensitive; `score` is the contains-hit fraction. */
export function scoreLexical(
  expected: { contains?: string[]; not_contains?: string[] },
  response: string,
): { passed: boolean; score: number; failure_reason?: string } {
  const haystack = response.toLowerCase();
  const needles = expected.contains ?? [];
  const forbidden = expected.not_contains ?? [];
  const hit = forbidden.find((s) => haystack.includes(s.toLowerCase()));
  if (hit !== undefined) {
    return { passed: false, score: 0, failure_reason: `response contains forbidden text: ${hit.slice(0, 128)}` };
  }
  if (needles.length === 0) {
    // Nothing lexically verifiable in `contains` — the case asserts nothing
    // the interim harness can check, so it passes vacuously and says so.
    return { passed: true, score: 1, failure_reason: 'no lexical assertions — vacuous pass (interim engine-side harness)' };
  }
  const missing = needles.filter((s) => !haystack.includes(s.toLowerCase()));
  const score = Number(((needles.length - missing.length) / needles.length).toFixed(4));
  if (missing.length > 0) {
    return { passed: false, score, failure_reason: `missing expected text: ${missing.slice(0, 5).join(' | ').slice(0, 256)}` };
  }
  return { passed: true, score };
}

@Injectable()
export class EvalScoringConsumer implements OutboxConsumer {
  private static readonly logger = new Logger(EvalScoringConsumer.name);

  readonly name = 'eval-scoring';
  readonly eventTypes = ['run.completed', 'run.failed'];

  constructor(
    private readonly db: DbService,
    private readonly evalService: EvalService,
  ) {}

  async handle(event: OutboxEvent): Promise<void> {
    const payload = (event.payload ?? {}) as { run_id?: string; message_id?: string; error_code?: string };
    const runId = payload.run_id ?? event.aggregateId;

    const open = await this.db.withOrg(event.organizationId, (tx) =>
      tx
        .select()
        .from(evalCaseExecutions)
        .where(and(eq(evalCaseExecutions.organizationId, event.organizationId), eq(evalCaseExecutions.runId, runId), eq(evalCaseExecutions.state, 'pending')))
        .limit(1),
    );
    const execution = open[0];
    if (!execution) {
      return; // not an eval run (or already scored) — the common case, cheap
    }

    if (event.eventType === 'run.failed') {
      await this.settle(execution.id, event.organizationId, {
        state: 'failed',
        score: 0,
        failureReason: `harness run failed: ${String(payload.error_code ?? 'unknown').slice(0, 128)}`,
      });
    } else {
      const verdict = await this.scoreResponse(event.organizationId, execution.caseId, payload.message_id);
      await this.settle(execution.id, event.organizationId, verdict);
    }
    await this.maybeCompleteEvalRun(event.organizationId, execution.evalRunId);
  }

  private async scoreResponse(
    orgId: string,
    caseId: string,
    messageId: string | undefined,
  ): Promise<{ state: 'passed' | 'failed'; score: number; failureReason?: string; responseExcerpt?: string }> {
    return this.db.withOrg(orgId, async (tx) => {
      const caseRows = await tx.select({ expected: evalCases.expected }).from(evalCases).where(eq(evalCases.id, caseId)).limit(1);
      const expected = (caseRows[0]?.expected ?? {}) as { contains?: string[]; not_contains?: string[] };
      if (!messageId) {
        return { state: 'failed' as const, score: 0, failureReason: 'run completed without a result message' };
      }
      // Typed select (not raw SQL): drizzle's jsonb mapping parses the stored
      // value back to an object. A raw `select content ...` would return the
      // driver's string form here because pg-types.ts overrides the jsonb
      // (OID 3802) type parser — reading `.text` off that string silently
      // scores every case 0.
      const msgRows = await tx
        .select({ content: messages.content })
        .from(messages)
        .where(eq(messages.id, messageId as string))
        .limit(1);
      const content = msgRows[0]?.content as unknown;
      const text = typeof (content as { text?: unknown } | null)?.text === 'string' ? String((content as { text?: unknown }).text) : '';
      const verdict = scoreLexical(expected, text);
      return {
        state: verdict.passed ? ('passed' as const) : ('failed' as const),
        score: verdict.score,
        failureReason: verdict.failure_reason,
        responseExcerpt: text.slice(0, 512),
      };
    });
  }

  private async settle(
    executionId: string,
    orgId: string,
    verdict: { state: 'passed' | 'failed'; score: number; failureReason?: string; responseExcerpt?: string },
  ): Promise<void> {
    await this.db.withOrg(orgId, (tx) =>
      tx
        .update(evalCaseExecutions)
        .set({
          state: verdict.state,
          score: String(verdict.score),
          failureReason: verdict.failureReason ?? null,
          responseExcerpt: verdict.responseExcerpt ?? null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(evalCaseExecutions.id, executionId)),
    );
  }

  /** When the last execution of the eval run settles, hand results to the decision engine. */
  private async maybeCompleteEvalRun(orgId: string, evalRunId: string): Promise<void> {
    const remaining = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({ id: evalCaseExecutions.id, caseId: evalCaseExecutions.caseId, attempt: evalCaseExecutions.attempt, state: evalCaseExecutions.state, score: evalCaseExecutions.score, failureReason: evalCaseExecutions.failureReason, responseExcerpt: evalCaseExecutions.responseExcerpt })
        .from(evalCaseExecutions)
        .where(and(eq(evalCaseExecutions.organizationId, orgId), eq(evalCaseExecutions.evalRunId, evalRunId))),
    );
    if (remaining.some((e) => e.state === 'pending')) {
      return; // cases still in flight — completeRun waits
    }
    if (remaining.length === 0) {
      return;
    }
    const results = {
      cases: remaining.map((e) => ({
        case_id: e.caseId,
        attempt: e.attempt,
        passed: e.state === 'passed',
        score: Number(e.score ?? (e.state === 'passed' ? 1 : 0)),
        ...(e.failureReason ? { failure_reason: e.failureReason.slice(0, 512) } : {}),
        ...(e.responseExcerpt ? { response_excerpt: e.responseExcerpt.slice(0, 512) } : {}),
      })),
      worker_provenance: { executor: 'engine:eval-executor', scoring: 'lexical-interim', note: 'state_assertions/document_ids/rubrics are Studio eval-worker territory' },
    };
    await this.evalService.completeRun({ orgId, evalRunId, results, actor: 'engine:eval-executor' });
    EvalScoringConsumer.logger.log(`eval run ${evalRunId} completed via the engine-side harness (${results.cases.length} cases)`);
  }
}
