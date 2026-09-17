import { and, eq, sql } from 'drizzle-orm';
import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../common/infra/db/db.service';
import type { OutboxEvent } from '../common/infra/outbox/schema';
import type { OutboxConsumer } from '../common/infra/outbox/consumer';
import { runEvents, runs } from '../modules/conversations/schema';
import { assertRunTransition, isRunState } from '../modules/conversations/state-machine';
import { uuidv7 } from '../common/ids/uuidv7';
import { recordOutboxEvent } from '../common/infra/outbox/outbox.service';
import { issueCapability } from '../common/auth/capability-token';
import { EventType } from '@neryva/mcp-contract';
import { PermanentConsumerError } from '../common/infra/outbox/consumer';
import { isRuntimeConfigured, startRunOnStudio } from '../transport/mcp/runtime-control.client';
import { withSpan, setSpanAttributes } from '../common/observability/spans';
import { runManifests } from '../modules/assistants/schema';

/**
 * Run dispatch consumer — the first real outbox consumer (Phase 6.6 worker
 * family `agent-run-projection`). On `run.created` it delivers `StartRun` to
 * the Studio runtime via RuntimeControlService (ledger 5.7's outbox path)
 * and advances the Engine projection ACCEPTED -> DISPATCHED.
 *
 * Without a configured runtime (NERYVA_RUNTIME_BASE_URL) the event is
 * consumed with an explicit `skipped` result — the run stays ACCEPTED for a
 * later dispatch; this is a documented, observable no-op, not silent success.
 */
@Injectable()
export class RunDispatchConsumer implements OutboxConsumer {
  private static readonly logger = new Logger(RunDispatchConsumer.name);

  readonly name = 'run-dispatch';
  readonly eventTypes = ['run.created', 'run.resume_requested'];

  constructor(private readonly db: DbService) {}

  async handle(event: OutboxEvent): Promise<void> {
    if (event.eventType === 'run.resume_requested') {
      return this.handleResume(event);
    }
    return this.handleCreated(event);
  }

  /**
   * Resume path (FL-1.1 approval park/resume): an APPROVED decision flipped
   * the run WAITING_APPROVAL → RUNNING; this re-drives StartRun on Studio.
   * The fresh executor observes the durable decision via GetApprovalState and
   * continues — Engine toolEffects dedup makes the replay safe.
   */
  private async handleResume(event: OutboxEvent): Promise<void> {
    const payload = (event.payload ?? {}) as {
      run_id?: string;
      conversation_id?: string;
      message_id?: string;
      assistant_version_id?: string;
    };
    const orgId = event.organizationId;
    const runId = payload.run_id ?? event.aggregateId;
    const conversationId = payload.conversation_id;
    const messageId = payload.message_id;
    const assistantVersionId = payload.assistant_version_id;
    if (!runId || !conversationId || !messageId || !assistantVersionId) {
      throw new SkipDispatchError(
        `run.resume_requested payload incomplete for run ${runId || '(unknown)'}`,
      );
    }
    if (!isRuntimeConfigured()) {
      RunDispatchConsumer.logger.debug(
        `runtime not configured; resume for run ${runId} skipped (event ${event.eventId})`,
      );
      return;
    }
    const capability = issueCapability({
      organizationId: orgId,
      conversationId,
      runId,
      assistantVersionId,
      allowedOps: [
        'lease',
        'context',
        'search_knowledge',
        'append_events',
        'approval',
        'memory_proposal',
        'tool',
        'checkpoint',
        'commit',
        'observe',
        'escalation',
        'artifact',
      ],
      subject: 'agent-studio-runtime',
    });
    const conversationVersion = await this.currentConversationVersion(orgId, conversationId);
    const started = await this.tracedStartRun(orgId, runId, 'resume', () =>
      startRunOnStudio({
        organizationId: orgId,
        conversationId,
        runId,
        messageId,
        assistantVersionId,
        expectedConversationVersion: conversationVersion,
        capabilityToken: capability.token,
      }),
    );
    await this.recordResumeEvent(orgId, runId, started.workflowId);
    RunDispatchConsumer.logger.log(
      `run ${runId} resume dispatched to studio (workflow ${started.workflowId})`,
    );
  }

  private async recordResumeEvent(orgId: string, runId: string, workflowId: string): Promise<void> {
    await this.db.withOrg(orgId, async (tx) => {
      const rowId = uuidv7();
      await tx.insert(runEvents).values({
        id: rowId,
        eventId: rowId,
        runId,
        organizationId: orgId,
        eventType: 'run.resumed',
        payload: { reason: 'approval_granted', workflow_id: workflowId },
        producerIdentity: 'engine:run-dispatch',
      });
    });
  }

  private async handleCreated(event: OutboxEvent): Promise<void> {
    const payload = (event.payload ?? {}) as {
      run_id?: string;
      conversation_id?: string;
      message_id?: string;
      assistant_version_id?: string;
    };
    const orgId = event.organizationId;
    const runId = payload.run_id ?? event.aggregateId;
    const conversationId = payload.conversation_id;
    const messageId = payload.message_id;
    const assistantVersionId = payload.assistant_version_id;
    if (!runId || !conversationId || !messageId || !assistantVersionId) {
      // Malformed payload — not retryable.
      throw new SkipDispatchError(`run.created payload incomplete for run ${runId || '(unknown)'}`);
    }

    if (!isRuntimeConfigured()) {
      RunDispatchConsumer.logger.debug(
        `runtime not configured; run ${runId} stays ACCEPTED (event ${event.eventId} consumed as skipped)`,
      );
      return;
    }

    const capability = issueCapability({
      organizationId: orgId,
      conversationId,
      runId,
      assistantVersionId,
      // Full run-authority op set — a dispatch token missing an op (e.g.
      // 'context' or 'checkpoint') fails the RPC mid-run with no way for
      // Studio to re-mint (no L1 credentials on the runtime).
      allowedOps: [
        'lease',
        'context',
        'search_knowledge',
        'append_events',
        'approval',
        'memory_proposal',
        'tool',
        'checkpoint',
        'commit',
        'observe',
        'escalation',
        'artifact',
      ],
      subject: 'agent-studio-runtime',
    });

    const conversationVersion = await this.currentConversationVersion(orgId, conversationId);
    const started = await this.tracedStartRun(orgId, runId, 'created', () =>
      startRunOnStudio({
        organizationId: orgId,
        conversationId,
        runId,
        messageId,
        assistantVersionId,
        expectedConversationVersion: conversationVersion,
        capabilityToken: capability.token,
      }),
    );

    await this.markDispatched(orgId, runId, started.workflowId);
    RunDispatchConsumer.logger.log(
      `run ${runId} dispatched to studio (workflow ${started.workflowId}, already_started=${started.alreadyStarted})`,
    );
  }

  /**
   * P1 (§6a) — run.dispatch span. The dispatcher runs detached from the
   * accept trace (outbox boundary), so correlation is by ATTRIBUTE
   * (`run_trace_id` read from the run manifest), not parentage. When the
   * Studio contract carries a traceparent, this becomes a true child span —
   * until then the attribute join is the honest correlation.
   */
  private async tracedStartRun(
    orgId: string,
    runId: string,
    kind: 'created' | 'resume',
    start: () => Promise<{ workflowId: string; alreadyStarted: boolean }>,
  ): Promise<{ workflowId: string; alreadyStarted: boolean }> {
    let runTraceId: string | null = null;
    try {
      const rows = await this.db.withOrg(orgId, (tx) =>
        tx
          .select({ manifest: runManifests.manifest })
          .from(runManifests)
          .where(eq(runManifests.runId, runId))
          .limit(1),
      );
      const manifest = rows[0]?.manifest as { trace_id?: unknown } | null;
      runTraceId = typeof manifest?.trace_id === 'string' ? manifest.trace_id : null;
    } catch {
      runTraceId = null;
    }
    return withSpan(
      'run.dispatch',
      { org_id: orgId, run_id: runId, run_trace_id: runTraceId, dispatch_kind: kind },
      async (span) => {
        const started = await start();
        setSpanAttributes(span, {
          workflow_id: started.workflowId,
          already_started: started.alreadyStarted,
        });
        return started;
      },
    );
  }

  private async currentConversationVersion(orgId: string, conversationId: string): Promise<number> {
    return this.db.withOrg(orgId, async (tx) => {
      const rows = await tx.execute(
        sql`select version from conversations where id = ${conversationId}::uuid and organization_id = ${orgId}::uuid limit 1`,
      );
      const row = rows.rows[0] as { version: number | string } | undefined;
      if (!row) {
        throw new SkipDispatchError(`conversation ${conversationId} vanished before dispatch`);
      }
      return Number(row.version);
    });
  }

  private async markDispatched(orgId: string, runId: string, workflowId: string): Promise<void> {
    await this.db.withOrg(orgId, async (tx) => {
      const found = await tx.select().from(runs).where(eq(runs.id, runId)).for('update').limit(1);
      if (found.length === 0) {
        throw new SkipDispatchError(`run ${runId} vanished before dispatch`);
      }
      const run = found[0];
      if (!isRunState(run.state)) {
        throw new SkipDispatchError(`run ${runId} has unknown state ${run.state}`);
      }
      if (run.state !== 'ACCEPTED') {
        return; // already advanced (redelivery) — idempotent
      }
      assertRunTransition(run.state, 'DISPATCHED');
      const insertedEvent = await tx
        .insert(runEvents)
        .values(
          (() => {
            const rowId = uuidv7();
            return {
              id: rowId,
              eventId: rowId,
              runId: run.id,
              organizationId: orgId,
              eventType: String(EventType.RUN_LIFECYCLE),
              payload: {
                case: 'lifecycle',
                value: { fromState: 'ACCEPTED', toState: 'DISPATCHED', workflowId },
              },
              producerIdentity: 'engine:run-dispatch',
            };
          })(),
        )
        .returning({ engineSequence: runEvents.engineSequence });
      await tx
        .update(runs)
        .set({
          state: 'DISPATCHED',
          startedAt: new Date().toISOString(),
          lastEventSequence: Math.max(run.lastEventSequence, insertedEvent[0].engineSequence),
          version: run.version + 1,
          updatedAt: new Date().toISOString(),
        })
        .where(and(eq(runs.id, run.id)));
      await recordOutboxEvent(tx, {
        aggregateType: 'run',
        aggregateId: run.id,
        organizationId: orgId,
        eventType: 'run.dispatched',
        partitionKey: run.conversationId,
        payload: { run_id: run.id, conversation_id: run.conversationId, workflow_id: workflowId },
      });
    });
  }
}

/** Non-retryable dispatch failures — event is dead-lettered, no run-state change. */
export class SkipDispatchError extends PermanentConsumerError {}
