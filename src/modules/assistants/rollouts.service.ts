import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import type { AssistantRollout, RolloutVariant } from './schema';
import { ROLLOUT_REPOSITORY } from './repositories/repository-tokens';
import type { IRolloutRepository } from './repositories/rollout.repository';

/**
 * FL-3.12 + TPL-6.2 — A/B / canary rollout management + release pointers.
 * The rollout lives BESIDE the atomic publish pointer:
 * `assistants.active_version_id` stays the default; an active rollout splits
 * traffic across PUBLISHED versions by weight. Selection is sticky per
 * conversation (conversations.service); this service owns the CRUD +
 * invariants:
 *   - every variant version belongs to the assistant and is PUBLISHED,
 *   - weights are positive integers summing to exactly 100,
 *   - at most ONE active rollout per (assistant, environment, channel),
 *   - versions under an active version-block cannot be assigned,
 *   - versions whose latest completed eval decision is BLOCK cannot be
 *     pointed at (TPL-8.3 — the publish-TX hash gate covers the same content
 *     smuggled through rollback, so the two gates compose).
 *
 * Persistence lives in `IRolloutRepository` (P3): `promoteRelease` owns the
 * ONE wide transaction — assistants exists-check, assistant_installs,
 * template platform blocks, per-variant assistant_versions PUBLISHED check +
 * control_blocks kill gate + eval_runs BLOCK gate, pause of the current
 * active pointer, insert of the new active row. NOTHING leaves that unit;
 * this service keeps input validation (`parseVariants`, address shape),
 * audit replay, and policy.
 */
@Injectable()
export class RolloutsService {
  constructor(
    @Inject(ROLLOUT_REPOSITORY) private readonly rollouts: IRolloutRepository,
    private readonly audit: AuditService,
  ) {}

  private static parseVariants(raw: unknown): RolloutVariant[] {
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 10) {
      throw ApiError.validation({ versions: 'must be an array of 1..10 variants' });
    }
    const out: RolloutVariant[] = [];
    for (const v of raw) {
      const rec = v as { version_id?: unknown; weight?: unknown };
      if (typeof rec?.version_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(rec.version_id)) {
        throw ApiError.validation({ versions: 'each variant needs a version_id uuid' });
      }
      if (typeof rec?.weight !== 'number' || !Number.isInteger(rec.weight) || rec.weight <= 0) {
        throw ApiError.validation({ versions: 'each variant weight must be a positive integer' });
      }
      out.push({ version_id: rec.version_id, weight: rec.weight });
    }
    const total = out.reduce((acc, v) => acc + v.weight, 0);
    if (total !== 100) {
      throw ApiError.validation({ versions: `weights must sum to 100 (got ${total})` });
    }
    return out;
  }

  /** Activate (or replace) the rollout for an assistant. */
  async set(input: { orgId: string; assistantId: string; versions: unknown; actor: string }): Promise<AssistantRollout> {
    return this.setRelease({ ...input, environment: 'production', channel: 'default' });
  }

  /**
   * TPL-6.2 — move the release pointer for one (environment, channel)
   * address. Promotion is a pointer move, never a rebuild; rollback is a
   * repoint (history preserved) or restore-as-new-version (rollback_of
   * lineage) — both append-only.
   */
  async setRelease(input: {
    orgId: string;
    assistantId: string;
    environment?: string;
    channel?: string;
    versions: unknown;
    actor: string;
  }): Promise<AssistantRollout> {
    const environment = input.environment ?? 'production';
    const channel = input.channel ?? 'default';
    assertAddress(environment, channel);
    const variants = RolloutsService.parseVariants(input.versions);
    const row = await this.rollouts.promoteRelease({
      orgId: input.orgId,
      assistantId: input.assistantId,
      environment,
      channel,
      variants,
      actor: input.actor,
    });
    await this.audit.add({
      action: 'release.promoted',
      resourceType: 'assistant_rollout',
      resourceId: row.id,
      actorType: 'account',
      actorId: input.actor,
      tenantId: input.orgId,
      details: {
        assistant_id: input.assistantId,
        environment,
        channel,
        variants: variants.map((v) => `${v.version_id}:${v.weight}`).join(','),
      },
    });
    return row;
  }

  async pause(input: { orgId: string; assistantId: string; environment?: string; channel?: string; actor: string }): Promise<{ paused: boolean }> {
    if (input.environment !== undefined) {
      assertAddress(input.environment, input.channel ?? 'default');
    }
    if (input.channel !== undefined) {
      assertAddress(input.environment ?? 'production', input.channel);
    }
    const { paused, rolloutId } = await this.rollouts.pauseRelease({
      orgId: input.orgId,
      assistantId: input.assistantId,
      environment: input.environment,
      channel: input.channel,
      reason: 'operator',
      pausedBy: input.actor,
    });
    if (paused && rolloutId) {
      await this.audit.add({
        action: 'assistant.rollout_paused',
        resourceType: 'assistant_rollout',
        resourceId: rolloutId,
        actorType: 'account',
        actorId: input.actor,
        tenantId: input.orgId,
        details: { assistant_id: input.assistantId },
      });
    }
    return { paused };
  }

  /**
   * The current release pointer. Addressless reads mean the DEFAULT address
   * (production/default) — "the" release of an assistant is its production
   * pointer, never "the newest row of any address" (a staging/canary move
   * must not leak into reads that did not ask for it).
   */
  async get(orgId: string, assistantId: string, environment?: string, channel?: string): Promise<AssistantRollout | null> {
    const address = { environment: environment ?? 'production', channel: channel ?? 'default' };
    assertAddress(address.environment, address.channel);
    return this.rollouts.getRelease(orgId, assistantId, environment, channel);
  }
}

function assertAddress(environment: string, channel: string): void {
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(environment)) {
    throw ApiError.validation({ environment: 'must be 1..32 chars of [a-z0-9_-], starting alnum' });
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(channel)) {
    throw ApiError.validation({ channel: 'must be 1..32 chars of [a-z0-9_-], starting alnum' });
  }
}
