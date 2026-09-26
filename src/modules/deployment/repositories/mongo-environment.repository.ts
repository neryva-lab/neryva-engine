/**
 * MongoDB lane for `IDeploymentEnvironmentRepository` (P3) — the environment
 * aggregate as driven by `EnvironmentsService`.
 *
 * Plan D4: UUIDs as BSON Binary subtype 4, pg snake_case field names,
 * ISO-8601 timestamp strings. Every method is one `withOrg` unit (plan D5);
 * the tenant predicate is enforced by `TenantScopedCollection` (plan D6).
 *
 * The `(organization_id, name)` unique claim is enforced by the P1
 * migration registry; the duplicate-key path on create maps to the same
 * `ApiError.conflict` the pg lane returns from its `onConflictDoNothing`
 * guard.
 */
import type { Db } from 'mongodb';
import { ApiError } from '../../../common/http/api-error';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { uuidv7 } from '../../../common/ids/uuidv7';
import type { EnvironmentRow } from '../schema';
import type {
  CreateEnvironmentInput,
  IDeploymentEnvironmentRepository,
  UpdateEnvironmentInput,
} from './environment.repository';
import { binUuid, deploymentCollections, isDuplicateKey, toEnvironment } from './mongo-documents';

export class MongoDeploymentEnvironmentRepository implements IDeploymentEnvironmentRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private tx(db: Db, ctx: MongoTxContext) {
    return { session: { session: ctx.session }, ...deploymentCollections(db) };
  }

  async list(orgId: string): Promise<EnvironmentRow[]> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const docs = await t.environments.find(orgId, {}, t.session).sort({ created_at: 1 }).toArray();
      return docs.map(toEnvironment);
    });
  }

  async get(orgId: string, environmentId: string): Promise<EnvironmentRow> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const doc = await t.environments.findOne(orgId, { id: binUuid(environmentId, 'environmentId') }, t.session);
      if (!doc) throw ApiError.notFound('environment');
      return toEnvironment(doc);
    });
  }

  async getInOrg(orgId: string, environmentId: string): Promise<EnvironmentRow> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const doc = await t.environments.findOne(orgId, { id: binUuid(environmentId, 'environmentId') }, t.session);
      if (!doc) throw ApiError.notFound('environment in this organization');
      return toEnvironment(doc);
    });
  }

  async create(input: CreateEnvironmentInput): Promise<EnvironmentRow> {
    const db = this.mongo.root;
    const now = new Date().toISOString();
    try {
      return await this.mongo.withOrg(input.orgId, async (ctx) => {
        const t = this.tx(db, ctx);
        const doc = {
          id: binUuid(uuidv7()),
          organization_id: binUuid(input.orgId, 'orgId'),
          project_id: input.projectId ? binUuid(input.projectId, 'projectId') : null,
          name: input.name,
          tier: input.tier,
          region: input.region ?? null,
          description: input.description ?? null,
          pinned_agent_version: null,
          guardrail_profile: input.guardrailProfile ?? null,
          quota_ref: input.quotaRef ?? null,
          approval_mode: input.approvalMode,
          auto_promote: input.autoPromote ? 1 : 0,
          status: 'active',
          concurrency: input.concurrency,
          live_deployment_id: null,
          live_version: null,
          last_deployed_at: null,
          created_by: null,
          created_at: now,
          updated_at: now,
        };
        await t.environments.insertOne(input.orgId, doc, t.session);
        return toEnvironment({ ...doc, _id: undefined as never });
      });
    } catch (err) {
      if (isDuplicateKey(err)) {
        throw ApiError.conflict(`environment "${input.name}" already exists`);
      }
      throw err;
    }
  }

  async update(input: UpdateEnvironmentInput): Promise<EnvironmentRow> {
    const db = this.mongo.root;
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const updated = await t.environments.findOneAndUpdate(
        input.orgId,
        { id: binUuid(input.environmentId, 'environmentId') },
        {
          $set: {
            ...(input.pinnedAgentVersion !== undefined ? { pinned_agent_version: input.pinnedAgentVersion } : {}),
            ...(input.guardrailProfile !== undefined ? { guardrail_profile: input.guardrailProfile } : {}),
            ...(input.region !== undefined ? { region: input.region } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.approvalMode !== undefined ? { approval_mode: input.approvalMode } : {}),
            ...(input.autoPromote !== undefined ? { auto_promote: input.autoPromote ? 1 : 0 } : {}),
            ...(input.concurrency !== undefined ? { concurrency: input.concurrency } : {}),
            ...(input.status !== undefined ? { status: input.status } : {}),
            updated_at: new Date().toISOString(),
          },
        },
        { ...t.session, returnDocument: 'after' },
      );
      if (!updated) throw ApiError.notFound('environment');
      return toEnvironment(updated);
    });
  }

  async remove(input: { orgId: string; environmentId: string }): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withOrg(input.orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      await t.environments.deleteOne(input.orgId, { id: binUuid(input.environmentId, 'environmentId') }, t.session);
    });
  }

  async markLive(input: { orgId: string; environmentId: string; deploymentId: string; version: string }): Promise<void> {
    const db = this.mongo.root;
    const now = new Date().toISOString();
    await this.mongo.withOrg(input.orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      await t.environments.updateOne(
        input.orgId,
        { id: binUuid(input.environmentId, 'environmentId') },
        {
          $set: {
            live_deployment_id: binUuid(input.deploymentId, 'deploymentId'),
            live_version: input.version,
            pinned_agent_version: input.version,
            last_deployed_at: now,
            updated_at: now,
          },
        },
        t.session,
      );
    });
  }

  async setLiveState(input: {
    orgId: string;
    environmentId: string;
    deploymentId: string | null;
    version: string | null;
  }): Promise<EnvironmentRow | null> {
    const db = this.mongo.root;
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const updated = await t.environments.findOneAndUpdate(
        input.orgId,
        { id: binUuid(input.environmentId, 'environmentId') },
        {
          $set: {
            live_deployment_id: input.deploymentId ? binUuid(input.deploymentId, 'deploymentId') : null,
            live_version: input.version,
            pinned_agent_version: input.version,
            updated_at: new Date().toISOString(),
          },
        },
        { ...t.session, returnDocument: 'after' },
      );
      return updated ? toEnvironment(updated) : null;
    });
  }

  async count(orgId: string): Promise<number> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      return t.environments.countDocuments(orgId, {}, t.session);
    });
  }

  async listMaintenanceNames(orgId: string): Promise<string[]> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const docs = await t.environments.find(orgId, { status: 'maintenance' }, t.session).toArray();
      return docs.map((d) => d.name);
    });
  }
}
