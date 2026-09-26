/**
 * MongoDB lane for `IRolloutRepository` (P3) — the `assistant_rollouts`
 * aggregate as driven by `RolloutsService`.
 *
 * Plan D4: UUIDs are stored as BSON Binary subtype 4 (STANDARD), field names
 * are the pg snake_case column names, timestamps are ISO-8601 strings. Every
 * method is one `withOrg` unit (plan D5); the tenant predicate is enforced by
 * `TenantScopedCollection` (plan D6) — there is no RLS on this lane.
 *
 * Foreign-table reads consumed here (read-only, never mutated):
 * - `assistants` — existence (tenant-scoped)
 * - `assistant_installs` — slug provenance (tenant-scoped)
 * - `template_platform_blocks` — GLOBAL, staff-written (no RLS on the pg
 *   lane either): read unscoped from the raw collection, never with a
 *   tenant predicate
 * - `assistant_versions` — per-variant PUBLISHED check (tenant-scoped)
 * - `control_blocks` — version kill gate (tenant-scoped; same active
 *   predicate as `MongoControlBlockRepository`)
 * - `eval_runs` (knowledge) — BLOCK/FAIL gate on the latest completed run
 *   (tenant-scoped)
 *
 * `promoteRelease` owns the ONE wide transaction: nothing leaves it. The
 * concurrent-address conflict is enforced by the partial unique index
 * `uq_rollouts_active_per_assistant_env_channel` ((assistant_id,
 * environment, channel) WHERE state = 'active'), which mirrors the pg lane
 * and is ensured defensively here (plan D7): a duplicate-key (11000) on the
 * insert maps to the same `conflict` the pg lane raises for 23505.
 */
import type { Binary, Db, Document } from 'mongodb';
import { MongoServerError } from 'mongodb';
import { ApiError } from '../../../common/http/api-error';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { nowIso, uuidToBinary } from '../../../common/infra/db/mongo/mongo-tx';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { TenantScopedCollection } from '../../../common/infra/db/mongo/concurrency/tenant-guard';
import type { AssistantRollout, RolloutVariant } from '../schema';
import type { IRolloutRepository } from './rollout.repository';

// ── document shapes (plan D4: snake_case, UUIDs as Binary subtype 4) ───────

interface RolloutMongoDoc extends Document {
  id: Binary;
  organization_id: Binary;
  assistant_id: Binary;
  state: string;
  paused_reason: string | null;
  paused_by: string | null;
  paused_at: string | null;
  environment: string;
  channel: string;
  versions: unknown;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** Minimal assistants shape needed by `promoteRelease`'s existence check. */
interface AssistantMongoDoc extends Document {
  id: Binary;
  organization_id: Binary;
}

/** Minimal assistant_installs shape (slug provenance for the platform-block check). */
interface AssistantInstallMongoDoc extends Document {
  id: Binary;
  organization_id: Binary;
  assistant_id: Binary;
  slug: string;
}

/** Minimal template_platform_blocks shape — GLOBAL, no organization_id. */
interface TemplatePlatformBlockMongoDoc extends Document {
  id: Binary;
  slug: string;
  reason: string;
  lifted_at: string | null;
}

/** Minimal assistant_versions shape needed by the per-variant PUBLISHED check. */
interface AssistantVersionMongoDoc extends Document {
  id: Binary;
  organization_id: Binary;
  assistant_id: Binary;
  status: string;
}

/** Minimal eval_runs shape needed by the eval BLOCK/FAIL gate. */
interface EvalRunMongoDoc extends Document {
  id: Binary;
  organization_id: Binary;
  assistant_version_id: Binary;
  state: string;
  decision: string | null;
  finished_at: string | null;
}

// ── row mapper ──────────────────────────────────────────────────────────────

function uuidOf(value: Binary): string {
  return value.toUUID().toString();
}

function toRollout(doc: RolloutMongoDoc): AssistantRollout {
  return {
    id: uuidOf(doc.id),
    organizationId: uuidOf(doc.organization_id),
    assistantId: uuidOf(doc.assistant_id),
    state: doc.state,
    pausedReason: doc.paused_reason,
    pausedBy: doc.paused_by,
    pausedAt: doc.paused_at,
    environment: doc.environment,
    channel: doc.channel,
    versions: doc.versions as RolloutVariant[],
    createdBy: doc.created_by,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

/** Parse a UUID into BSON Binary subtype 4; fail closed with a validation error. */
function binUuid(id: string, field = 'id'): Binary {
  try {
    return uuidToBinary(id);
  } catch {
    throw ApiError.validation({ [field]: 'must be a uuid' });
  }
}

/** True for MongoDB duplicate-key errors (plan D7: the concurrent-promotion signal). */
function isDuplicateKey(err: unknown): boolean {
  return err instanceof MongoServerError && err.code === 11000;
}

// ── unique-index ensurement (plan D7) ───────────────────────────────────────

/**
 * The partial unique index the promotion's concurrent-address conflict
 * relies on — mirrors the pg lane's
 * `uq_rollouts_active_per_assistant_env_channel` ((assistant_id,
 * environment, channel) WHERE state = 'active'), which the mongo migration
 * registry also carries. Ensured defensively here, once per `Db` handle.
 */
const ensuredDatabases = new WeakSet<Db>();

async function ensureRolloutIndexes(db: Db): Promise<void> {
  if (ensuredDatabases.has(db)) return;
  await db.collection('assistant_rollouts').createIndex(
    { assistant_id: 1, environment: 1, channel: 1 },
    {
      unique: true,
      name: 'uq_rollouts_active_per_assistant_env_channel',
      partialFilterExpression: { state: 'active' },
    },
  );
  ensuredDatabases.add(db);
}

// ── repository ──────────────────────────────────────────────────────────────

export class MongoRolloutRepository implements IRolloutRepository {
  /** The primary release address: omitted environment/channel default here. */
  private static readonly PRIMARY_ENVIRONMENT = 'production';
  private static readonly PRIMARY_CHANNEL = 'default';

  constructor(private readonly mongo: MongoDbService) {}

  private tx(db: Db): {
    rollouts: TenantScopedCollection<RolloutMongoDoc>;
    assistants: TenantScopedCollection<AssistantMongoDoc>;
    installs: TenantScopedCollection<AssistantInstallMongoDoc>;
    versions: TenantScopedCollection<AssistantVersionMongoDoc>;
    evalRuns: TenantScopedCollection<EvalRunMongoDoc>;
  } {
    return {
      rollouts: new TenantScopedCollection<RolloutMongoDoc>(db.collection<RolloutMongoDoc>('assistant_rollouts')),
      assistants: new TenantScopedCollection<AssistantMongoDoc>(db.collection<AssistantMongoDoc>('assistants')),
      installs: new TenantScopedCollection<AssistantInstallMongoDoc>(db.collection<AssistantInstallMongoDoc>('assistant_installs')),
      versions: new TenantScopedCollection<AssistantVersionMongoDoc>(db.collection<AssistantVersionMongoDoc>('assistant_versions')),
      evalRuns: new TenantScopedCollection<EvalRunMongoDoc>(db.collection<EvalRunMongoDoc>('eval_runs')),
    };
  }

  /**
   * `MongoControlBlockRepository`'s active-block port (private here so the
   * wide transaction stays inside this repository): a block is ACTIVE when
   * `expires_at IS NULL OR expires_at > now()`.
   */
  private async findActiveBlock(
    db: Db,
    ctx: MongoTxContext,
    orgId: string,
    targetType: string,
    targetName: string,
  ): Promise<{ reason: string } | null> {
    const blocks = new TenantScopedCollection<{ reason: string } & Document>(db.collection('control_blocks'));
    const row = await blocks.findOne(
      orgId,
      {
        target_type: targetType,
        target_name: targetName,
        $or: [{ expires_at: null }, { expires_at: { $gt: nowIso() } }],
      },
      { session: ctx.session },
    );
    return row ? { reason: row.reason } : null;
  }

  async promoteRelease(input: {
    orgId: string;
    assistantId: string;
    environment: string;
    channel: string;
    variants: RolloutVariant[];
    actor: string;
  }): Promise<AssistantRollout> {
    const { orgId, assistantId, environment, channel, variants, actor } = input;
    const db = this.mongo.root;
    await ensureRolloutIndexes(db);
    try {
      return await this.mongo.withOrg(orgId, async (ctx) => {
        const t = this.tx(db);
        const session = { session: ctx.session };
        const exists = await t.assistants.findOne(orgId, { id: binUuid(assistantId, 'assistantId') }, session);
        if (!exists) {
          throw ApiError.notFound('assistant');
        }
        // REL-6.1 — platform kill, second effect point: a release pointer may
        // not be (re)assigned for an assistant installed from a platform-
        // blocked slug. The install record carries the slug provenance.
        // `template_platform_blocks` is GLOBAL (staff-written, no RLS on the
        // pg lane either) — read unscoped from the raw collection.
        const install = await t.installs.findOne(orgId, { assistant_id: binUuid(assistantId, 'assistantId') }, session);
        if (install) {
          const block = await db
            .collection<TemplatePlatformBlockMongoDoc>('template_platform_blocks')
            .findOne({ slug: install.slug, lifted_at: null }, session);
          if (block) {
            throw ApiError.forbidden(`template ${install.slug} is platform-blocked (${block.reason}) — new release pointers refuse`, { slug: install.slug });
          }
        }
        for (const v of variants) {
          const version = await t.versions.findOne(
            orgId,
            { id: binUuid(v.version_id, 'versions'), assistant_id: binUuid(assistantId, 'assistantId') },
            session,
          );
          if (!version || version.status !== 'PUBLISHED') {
            throw ApiError.validation({ versions: `version ${v.version_id} must be a PUBLISHED version of this assistant` });
          }
          // Version-level kill (TPL-6.3): a blocked version cannot be assigned
          // to any pointer. In-flight runs stay pinned (never touched here).
          const blocked = await this.findActiveBlock(db, ctx, orgId, 'version', v.version_id);
          if (blocked) {
            throw ApiError.conflict(`version ${v.version_id} is blocked (${blocked.reason}) — clear the block to assign it`, {
              version_id: v.version_id,
            });
          }
          // Eval gate (TPL-8.3 + A2-80): a version whose latest completed
          // evaluation decided BLOCK or FAIL cannot be promoted to any pointer.
          const latest = await t.evalRuns
            .find(
              orgId,
              { assistant_version_id: binUuid(v.version_id, 'versions'), state: 'completed' },
              session,
            )
            .sort({ finished_at: -1 })
            .limit(1)
            .toArray();
          const decision = latest[0]?.decision;
          if (decision === 'BLOCK' || decision === 'FAIL') {
            throw ApiError.conflict(`version ${v.version_id} decided ${decision} in its latest evaluation — resolve and re-evaluate before promoting`, {
              version_id: v.version_id,
            });
          }
        }
        // Pause the current active pointer AT THIS ADDRESS ONLY (a staging
        // move must never pause production).
        const now = nowIso();
        await t.rollouts.updateMany(
          orgId,
          {
            assistant_id: binUuid(assistantId, 'assistantId'),
            environment,
            channel,
            state: 'active',
          },
          { $set: { state: 'paused', updated_at: now } },
          session,
        );
        const doc: RolloutMongoDoc = {
          id: binUuid(uuidv7()),
          organization_id: binUuid(orgId, 'orgId'),
          assistant_id: binUuid(assistantId, 'assistantId'),
          state: 'active',
          paused_reason: null,
          paused_by: null,
          paused_at: null,
          environment,
          channel,
          // Opaque payload blob (pg jsonb): UUID strings stay strings.
          versions: input.variants,
          created_by: actor.slice(0, 128),
          created_at: now,
          updated_at: now,
        };
        await t.rollouts.insertOne(orgId, doc, session);
        return toRollout(doc);
      });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      // Concurrent promotion at the same address: the partial unique index
      // admits one active row — the loser retries against fresh state.
      if (isDuplicateKey(err)) {
        throw ApiError.conflict('concurrent release update at this address — reload and retry', { environment, channel });
      }
      throw err;
    }
  }

  async pauseRelease(input: {
    orgId: string;
    assistantId: string;
    environment?: string;
    channel?: string;
    reason: string;
    pausedBy: string;
  }): Promise<{ paused: boolean; rolloutId?: string }> {
    const environment = input.environment ?? MongoRolloutRepository.PRIMARY_ENVIRONMENT;
    const channel = input.channel ?? MongoRolloutRepository.PRIMARY_CHANNEL;
    const db = this.mongo.root;
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const t = this.tx(db);
      const now = nowIso();
      const updated = await t.rollouts.findOneAndUpdate(
        input.orgId,
        {
          assistant_id: binUuid(input.assistantId, 'assistantId'),
          environment,
          channel,
          state: 'active',
        },
        {
          $set: {
            state: 'paused',
            paused_reason: input.reason,
            paused_by: input.pausedBy.slice(0, 128),
            paused_at: now,
            updated_at: now,
          },
        },
        { session: ctx.session, returnDocument: 'after' },
      );
      if (!updated) {
        return { paused: false };
      }
      return { paused: true, rolloutId: uuidOf(updated.id) };
    });
  }

  async getRelease(
    orgId: string,
    assistantId: string,
    environment?: string,
    channel?: string,
  ): Promise<AssistantRollout | null> {
    const address = {
      environment: environment ?? MongoRolloutRepository.PRIMARY_ENVIRONMENT,
      channel: channel ?? MongoRolloutRepository.PRIMARY_CHANNEL,
    };
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db);
      const rows = await t.rollouts
        .find(
          orgId,
          {
            assistant_id: binUuid(assistantId, 'assistantId'),
            environment: address.environment,
            channel: address.channel,
          },
          { session: ctx.session },
        )
        .sort({ created_at: -1 })
        .limit(1)
        .toArray();
      return rows[0] ? toRollout(rows[0]) : null;
    });
  }
}
