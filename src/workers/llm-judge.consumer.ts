import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { DbService } from '../common/infra/db/db.service';
import { env } from '../common/config/env';
import { PermanentConsumerError, type OutboxConsumer } from '../common/infra/outbox/consumer';
import type { OutboxEvent } from '../common/infra/outbox/schema';
import { messages, runs } from '../modules/conversations/schema';
import { runJudgments } from '../modules/knowledge/eval.schema';
import { uuidv7 } from '../common/ids/uuidv7';

/**
 * FL-3.13 — online LLM-as-judge on sampled production runs. Consumes
 * `run.completed`, deterministically samples a configured percentage
 * (sha256 of the run id — no per-event randomness, so redelivery resamples
 * identically), and asks the configured judge endpoint to score the exchange
 * against the case rubric. Verdicts land in `run_judgments` (unique per run:
 * a redelivery hits the unique anchor and is a no-op).
 *
 * The judge endpoint receives the bounded input/output texts over its HTTPS
 * port — that is the documented seam (server-side egress to the org's judge
 * service). NOTHING is logged: no transcript content, no verdict free-text.
 */
@Injectable()
export class LlmJudgeConsumer implements OutboxConsumer {
  private static readonly logger = new Logger(LlmJudgeConsumer.name);

  readonly name = 'llm-judge';
  readonly eventTypes = ['run.completed'];

  /** Transcript bound per side sent to the judge — the claim-check path exists for more. */
  private static readonly MAX_EXCERPT_CHARS = 4000;

  constructor(private readonly db: DbService) {}

  async handle(event: OutboxEvent): Promise<void> {
    if (!env.WORKERS__LLM_JUDGE_ENABLED) {
      return;
    }
    const judgeUrl = env.HARNESS__LLM_JUDGE_URL;
    if (!judgeUrl) {
      throw new PermanentConsumerError('WORKERS__LLM_JUDGE_ENABLED but HARNESS__LLM_JUDGE_URL is not configured');
    }
    const payload = (event.payload ?? {}) as { run_id?: string };
    const runId = payload.run_id;
    if (typeof runId !== 'string' || !runId) {
      throw new PermanentConsumerError('run.completed payload missing run_id for judge');
    }
    if (!this.sampled(runId)) {
      return;
    }
    const orgId = event.organizationId;

    // Bounded transcript read (input user text + final assistant text only).
    const excerpt = await this.db.withOrg(orgId, async (tx) => {
      const runRows = await tx.select().from(runs).where(eq(runs.id, runId)).limit(1);
      const run = runRows[0];
      if (!run || run.state !== 'COMPLETED' || !run.resultMessageId) {
        return null;
      }
      const inputRows = await tx
        .select({ content: messages.content })
        .from(messages)
        .where(and(eq(messages.id, run.inputMessageId), eq(messages.organizationId, orgId)))
        .limit(1);
      const resultRows = await tx
        .select({ content: messages.content })
        .from(messages)
        .where(and(eq(messages.id, run.resultMessageId), eq(messages.organizationId, orgId)))
        .limit(1);
      const textOf = (c: unknown): string => {
        const t = (c as { text?: unknown } | null)?.text;
        return typeof t === 'string' ? t.slice(0, LlmJudgeConsumer.MAX_EXCERPT_CHARS) : '';
      };
      return {
        input: textOf(inputRows[0]?.content),
        output: textOf(resultRows[0]?.content),
        assistant_version_id: run.assistantVersionId,
        conversation_id: run.conversationId,
      };
    });
    if (!excerpt || !excerpt.input.trim() || !excerpt.output.trim()) {
      return; // nothing judgeable (empty sides / purged rows) — not an error
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), env.HARNESS__LLM_JUDGE_TIMEOUT_MS);
    timer.unref();
    let score: number;
    let verdict: Record<string, unknown> | null = null;
    let judgeModel = '';
    try {
      const res = await fetch(judgeUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: excerpt.input, output: excerpt.output, rubric: env.HARNESS__LLM_JUDGE_RUBRIC }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`judge endpoint returned ${res.status}`);
      }
      const body = (await res.json()) as { score?: unknown; verdict?: unknown; model?: unknown };
      const parsed = typeof body.score === 'number' ? body.score : Number(body.score);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
        throw new Error('judge score out of range');
      }
      score = parsed;
      if (body.verdict && typeof body.verdict === 'object' && !Array.isArray(body.verdict)) {
        verdict = body.verdict as Record<string, unknown>;
      }
      if (typeof body.model === 'string') {
        judgeModel = body.model.slice(0, 128);
      }
    } catch (err) {
      // Transient judge outage → retryable (the outbox machine reschedules);
      // the deterministic sampler means the retry re-enters this same path.
      LlmJudgeConsumer.logger.warn(`llm-judge attempt failed for run ${runId}: ${(err as Error).message}`);
      throw err;
    } finally {
      clearTimeout(timer);
    }

    await this.db.withOrg(orgId, async (tx) => {
      await tx
        .insert(runJudgments)
        .values({
          id: uuidv7(),
          organizationId: orgId,
          runId,
          conversationId: excerpt.conversation_id,
          assistantVersionId: excerpt.assistant_version_id,
          judgeModel,
          rubric: env.HARNESS__LLM_JUDGE_RUBRIC.slice(0, 2048),
          score: score.toFixed(4),
          verdict,
          state: 'completed',
        })
        .onConflictDoNothing(); // unique(run_id) — redelivery is a no-op
    });
  }

  /** Deterministic sampling — sha256(run_id) mod 100 < pct. */
  private sampled(runId: string): boolean {
    const pct = Math.min(Math.max(0, env.HARNESS__LLM_JUDGE_SAMPLE_PCT), 100);
    if (pct >= 100) {
      return true;
    }
    if (pct <= 0) {
      return false;
    }
    const h = createHash('sha256').update(`judge:${runId}`).digest();
    return ((h[0] << 8) | h[1]) % 100 < pct;
  }
}
