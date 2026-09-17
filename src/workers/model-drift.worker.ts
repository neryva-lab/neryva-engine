import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DbService } from '../common/infra/db/db.service';
import { EvalService } from '../modules/knowledge/eval.service';
import { NotificationsService } from '../modules/notifications/notifications.service';
import { env } from '../common/config/env';

/**
 * Model-drift watcher — P5 (ai-native-review.md drift shadow evals).
 *
 * Providers silently revise models; a PASS on eval today can be a FAIL
 * tomorrow with no Neryva-side change. Every hour this worker compares each
 * live assistant's PINNED model refs against the LIVE org catalog:
 * - drift + seeded dataset + no shadow eval in 24h → start a SHADOW eval
 *   (observation only — never gates, never satisfies required-checks) and
 *   alert owner/admin (warn, email);
 * - drift + NO seeded dataset → alert only ("attach a dataset to enable
 *   drift re-evaluation" — drift with nothing to measure against is still
 *   worth knowing).
 * Alert-first by design: no auto-rollback, no auto-pause on drift (P5 scope;
 * the burn-rate plane already pauses on realized cost anomalies).
 * Per-candidate isolation throughout; orgId test seam for hermeticity.
 */
@Injectable()
export class ModelDriftWorker implements OnModuleInit, OnModuleDestroy {
  private static readonly logger = new Logger(ModelDriftWorker.name);
  private static readonly BATCH = 20;
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(
    private readonly db: DbService,
    private readonly evals: EvalService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    if (!env.WORKERS__OUTBOX_ENABLED) {
      return;
    }
    this.timer = setInterval(() => void this.tick(), 3_600_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(orgId?: string): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const assistants = await this.db.withBypass(async (tx) => {
        const rows = await tx.execute(sql`
          select a.id as assistant_id, a.organization_id as org_id, a.name as name
          from assistants a
          where a.active_version_id is not null
            and a.disabled_at is null
            ${orgId === undefined ? sql`` : sql`and a.organization_id = ${orgId}::uuid`}
          order by a.updated_at desc
          limit ${ModelDriftWorker.BATCH}
        `);
        return rows.rows as Array<{ assistant_id: string; org_id: string; name: string }>;
      });
      for (const assistant of assistants) {
        try {
          await this.checkAssistant(assistant.org_id, assistant.assistant_id, assistant.name);
        } catch (err) {
          ModelDriftWorker.logger.warn(
            `drift check deferred for assistant ${assistant.assistant_id}: ${(err as Error).message}`,
          );
        }
      }
    } catch (err) {
      ModelDriftWorker.logger.warn(`model drift tick failed: ${(err as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  private async checkAssistant(orgId: string, assistantId: string, name: string): Promise<void> {
    const { versionId, drifted } = await this.evals.detectModelDrift(orgId, assistantId);
    if (!versionId || drifted.length === 0) {
      return;
    }
    const aliases = drifted.map((d) => `${d.alias} (${d.reason})`).join(', ');
    const outcome = await this.evals.startShadowEval({ orgId, assistantId, versionId, drifted });
    const body =
      outcome.status === 'started'
        ? `Catalog drift detected (${aliases}) — a shadow re-evaluation started to measure it. Formal gates are unaffected.`
        : outcome.status === 'deduped'
          ? `Catalog drift detected (${aliases}) — a shadow eval already covers the last 24h.`
          : `Catalog drift detected (${aliases}) — no template-seeded dataset exists, so no shadow eval could start. Attach a dataset to enable drift re-evaluation.`;
    await this.notifications.notifyOrgRoles(orgId, ['owner', 'admin'], {
      kind: 'assistant.model_drift',
      severity: 'warn',
      title: `Model drift on ${name}`,
      body,
      data: { assistant_id: assistantId, drifted, shadow_eval: outcome.status === 'started' },
      email: true,
    });
    ModelDriftWorker.logger.log(
      `model drift on assistant ${assistantId} (${aliases}), shadow eval ${outcome.status}`,
    );
  }
}
