/**
 * MongoDB tool-authority repository (P3) — the persistence port for tool-call
 * authorization, outcome recording, and the audited credential-disclosure
 * rail (`McpAuthorityService`, §5.10 + GetToolCredential).
 *
 * Mechanical port of the `DbService.withOrg` units in
 * `mcp-authority.service.ts`:
 * - one `MongoDbService.withOrg` transaction per unit;
 * - UUIDs as BSON Binary subtype 4, timestamps as canonical ISO-8601
 *   strings, BYTEA digests as Binary subtype 0;
 * - `authorizeToolCall` and `getToolCredential` collect the in-TX audit
 *   events into `auditTrail` in call order and never call the audit service;
 * - policy denials are returned, never thrown; only genuine preconditions
 *   throw typed `ApiError`s with the service's codes.
 *
 * This file must not import `tool-catalog.service.ts` (it would drag in the
 * Drizzle/`DbService` dependency graph). The built-in tool descriptors are a
 * local typed map — the exact catalog rows for the current built-ins; the
 * run-context port imports the same map from here.
 */
import { Binary, MongoServerError } from 'mongodb';
import type { ClientSession, Db, Document, WithId } from 'mongodb';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { nowIso, uuidToBinary } from '../../../common/infra/db/mongo/mongo-tx';
import { TenantScopedCollection } from '../../../common/infra/db/mongo/concurrency/tenant-guard';
import { ApiError } from '../../../common/http/api-error';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { issueCapability } from '../../../common/auth/capability-token';
import type { RepositoryAuditEvent } from './repository-types';
import type {
  AuthorizeToolOutcome,
  IToolAuthorityRepository,
  ToolCredentialOutcome,
} from './tool-authority.repository';

/**
 * Local replica of the pg-lane `BUILT_IN_TOOLS` (tool-catalog.service.ts) —
 * importing that module would transitively load Drizzle/`DbService`.
 */
export const BUILT_IN_TOOL_DESCRIPTORS: ReadonlyMap<
  string,
  {
    effectClass: 'READ_ONLY' | 'MUTATING' | 'DESTRUCTIVE';
    approvalRequirement: 'NONE' | 'REQUIRED';
    description: string;
    inputSchema: Record<string, unknown>;
  }
> = new Map([
  [
    'web_search',
    {
      effectClass: 'READ_ONLY' as const,
      approvalRequirement: 'NONE' as const,
      description:
        'Search the public web for current information. Returns ranked results with titles, URLs and snippets.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Search query', maxLength: 512 } },
        required: ['query'],
        additionalProperties: false,
      },
    },
  ],
  [
    'request_human_handoff',
    {
      effectClass: 'MUTATING',
      approvalRequirement: 'NONE',
      description:
        'Escalate this conversation to a human agent. The assistant pauses until a human teammate claims the conversation and replies.',
      inputSchema: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'Short reason for the escalation',
            maxLength: 128,
          },
        },
        additionalProperties: false,
      },
    },
  ],
  [
    'generate_image',
    {
      effectClass: 'READ_ONLY' as const,
      approvalRequirement: 'NONE' as const,
      description:
        'Generate an image from a text prompt. Returns a downloadable image attachment for the user.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'Image description (what to render)',
            maxLength: 1000,
          },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
    },
  ],
  [
    'search_knowledge',
    {
      effectClass: 'READ_ONLY' as const,
      approvalRequirement: 'NONE' as const,
      description:
        'Search the organization knowledge corpus (ACL-filtered before scoring). Returns cited chunks.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Retrieval query', maxLength: 2000 },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  ],
  [
    'search_memory',
    {
      effectClass: 'READ_ONLY' as const,
      approvalRequirement: 'NONE' as const,
      description:
        'Search approved long-term memory items in scope. Returns provenance-tagged memories.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Memory query', maxLength: 2000 },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  ],
]);

/** Closed provider vocabulary for `model:<provider>` credentials (pg lane). */
const MODEL_PROVIDERS: ReadonlySet<string> = new Set([
  'openai',
  'anthropic',
  'google',
  'azure-openai',
  'amazon-bedrock',
  'mistral',
  'xai',
  'deepseek',
  'openrouter',
  'ollama',
]);

/** `runs` document — only the fields this repository reads. */
interface RunDoc extends Document {
  id: Binary;
  organization_id: Binary;
  conversation_id: Binary;
  assistant_version_id: Binary;
  policy_snapshot_id: Binary;
  state: string;
}

/** `policy_snapshots` document — only the fields this repository reads. */
interface PolicySnapshotDoc extends Document {
  id: Binary;
  organization_id: Binary;
  tool_policy: {
    tools?: Array<{ name: string; approval?: string }>;
  } | null;
  /** P4 perimeter pins + shadow bindings, keyed by tool name. */
  tool_bindings: Array<{
    name: string;
    execution_environment?: unknown;
    allowed_egress_domains?: unknown;
    execution_mode?: unknown;
  }> | null;
  model_ref: {
    models?: Array<{ provider?: string }>;
  } | null;
}

/** `tool_effects` document — pg `tool_effects` row shape (plan D4). */
interface ToolEffectDoc extends Document {
  id: Binary;
  organization_id: Binary;
  run_id: Binary;
  step_id: string | null;
  tool_call_id: string;
  tool_name: string;
  tool_version: string | null;
  argument_digest: Binary;
  result_digest: Binary | null;
  status: string | null;
  result_artifact_id: Binary | null;
  authorized_at: string;
  recorded_at: string | null;
}

/** `control_blocks` document — only the fields this repository reads. */
interface ControlBlockDoc extends Document {
  organization_id: Binary;
  target_type: string;
  target_name: string;
  reason: string;
  expires_at: string | null;
}

/** `tool_catalog` document — only the fields this repository reads. */
interface ToolCatalogDoc extends Document {
  id: Binary;
  organization_id: Binary;
  name: string;
  enabled: boolean;
  effect_class: string;
  approval_requirement: string;
  description: string | null;
  input_schema: Record<string, unknown>;
  annotations: Record<string, unknown>;
  http_binding: { header_name?: string } | null;
  execution_environment: string;
  allowed_egress_domains: string[] | null;
  credential_sealed: string | null;
}

/** `assistant_versions` document — only the assistant-id lookup. */
interface AssistantVersionDoc extends Document {
  id: Binary;
  organization_id: Binary;
  assistant_id: string;
}

/** `assistants` document — only the disabled-at lookup. */
interface AssistantDoc extends Document {
  id: Binary;
  organization_id: Binary;
  disabled_at: string | null;
}

/** `provider_credentials` document — only the fields this repository reads. */
interface ProviderCredentialDoc extends Document {
  id: Binary;
  organization_id: Binary;
  provider: string;
  status: string;
  secret_sealed: string;
  created_at: string;
}

/** `provider_enablements` document — only the fields this repository reads. */
interface ProviderEnablementDoc extends Document {
  organization_id: Binary;
  provider: string;
  enabled: boolean;
}

type TxSession = { session: ClientSession };

export class MongoToolAuthorityRepository implements IToolAuthorityRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private sessionOpt(ctx: MongoTxContext): TxSession {
    return { session: ctx.session };
  }

  private tenantOrgId(ctx: MongoTxContext): string {
    const orgId = ctx.orgId;
    if (!orgId) {
      throw new Error(
        'MongoToolAuthorityRepository: tenant context required (unreachable under withOrg)',
      );
    }
    return orgId;
  }

  private auditInto(
    auditTrail: RepositoryAuditEvent[],
    event: Omit<RepositoryAuditEvent, 'actorType' | 'actorId'>,
  ): void {
    // The service's auditSafe stamps these two fields; the repository
    // collects them explicitly so the replayed record is byte-identical.
    auditTrail.push({ ...event, actorType: 'service', actorId: 'agent-studio-runtime' });
  }

  /**
   * `ControlBlocksService.findActiveBlock` port: a block is ACTIVE when
   * `expires_at IS NULL OR expires_at > now()` — evaluated at check time.
   */
  private async findActiveBlock(
    orgId: string,
    s: TxSession,
    db: Db,
    targetType: string,
    targetName: string,
  ): Promise<WithId<ControlBlockDoc> | null> {
    const blocks = new TenantScopedCollection<ControlBlockDoc>(db.collection('control_blocks'));
    return blocks.findOne(
      orgId,
      {
        target_type: targetType,
        target_name: targetName,
        $or: [{ expires_at: null }, { expires_at: { $gt: nowIso() } }],
      },
      s,
    );
  }

  async authorizeToolCall(input: {
    orgId: string;
    runId: string;
    stepId?: string;
    toolCallId: string;
    toolName: string;
    toolVersion?: string;
    argumentDigest: Buffer;
  }): Promise<AuthorizeToolOutcome> {
    const auditTrail: RepositoryAuditEvent[] = [];
    const outcome = await this.mongo.withOrg(input.orgId, async (ctx) => {
      const db = this.mongo.root;
      const s = this.sessionOpt(ctx);
      const orgId = this.tenantOrgId(ctx);
      const runs = new TenantScopedCollection<RunDoc>(db.collection('runs'));
      const effects = new TenantScopedCollection<ToolEffectDoc>(db.collection('tool_effects'));

      const run = await runs.findOne(orgId, { id: uuidToBinary(input.runId) }, s);
      if (!run) {
        throw ApiError.notFound('run');
      }
      if (['COMPLETED', 'FAILED', 'CANCELED'].includes(run.state)) {
        throw ApiError.conflict('run is terminal; tool calls rejected', { state: run.state });
      }

      // Snapshot + pinned binding resolve BEFORE the dedup return: a
      // replayed ack still reports its binding's shadow mode truthfully.
      const snapshots = new TenantScopedCollection<PolicySnapshotDoc>(
        db.collection('policy_snapshots'),
      );
      const snapshot = await snapshots.findOne(orgId, { id: run.policy_snapshot_id }, s);
      if (!snapshot) {
        throw ApiError.internal();
      }
      const bindingsList = Array.isArray(snapshot.tool_bindings) ? snapshot.tool_bindings : [];
      const pin = bindingsList.find((b) => b.name === input.toolName);
      // Legacy snapshots predate the perimeter pin (P4): no fields = no
      // drift verdict possible — the check below skips, exactly as before.
      // Only pins that CARRY the perimeter can fail on drift.
      const shadow = pin?.execution_mode === 'shadow';

      const duplicate = await effects.findOne(orgId, { tool_call_id: input.toolCallId }, s);
      if (duplicate) {
        const same =
          duplicate.argument_digest &&
          Buffer.from(duplicate.argument_digest.buffer).equals(input.argumentDigest);
        if (!same) {
          throw ApiError.conflict('tool_call_id reuse with different arguments', {
            tool_call_id: input.toolCallId,
          });
        }
        return {
          allowed: true,
          toolCapability: undefined,
          approvalRequired: false,
          duplicate: true,
          shadow,
        };
      }

      // Policy check against the pinned snapshot's tool_policy.
      const toolPolicy = snapshot.tool_policy as {
        tools?: Array<{ name: string; approval?: string }>;
      } | null;
      const descriptor = (toolPolicy?.tools ?? []).find((t) => t.name === input.toolName);
      if (!descriptor) {
        return {
          allowed: false,
          reason: `tool ${input.toolName} is not in the pinned tool policy`,
          approvalRequired: false,
          duplicate: false,
          shadow: false,
        };
      }

      // TPL-6.3 kill levels 2-4 — evaluated on EVERY new authorization (no
      // cache, so kill-to-deny latency is one RPC). Order: explicit operator
      // blocks first (cheapest, most specific), then the catalog enabled
      // flag. NOTE: the dedup early-return above intentionally precedes all
      // of this — replaying an already-authorized call's ack is idempotency,
      // not a new authorization.
      const deny = (
        reason: string,
      ): {
        allowed: false;
        reason: string;
        approvalRequired: false;
        duplicate: false;
        shadow: boolean;
      } => {
        this.auditInto(auditTrail, {
          action: 'mcp.tool_denied',
          resourceType: 'tool_effect',
          resourceId: run.id.toUUID().toString(),
          tenantId: input.orgId,
          details: { run_id: input.runId, tool: input.toolName, reason },
        });
        return { allowed: false, reason, approvalRequired: false, duplicate: false, shadow };
      };
      const capabilityBlock = await this.findActiveBlock(orgId, s, db, 'capability', 'tool');
      if (capabilityBlock) {
        return deny(`tool capability frozen (${capabilityBlock.reason})`);
      }
      const toolBlock = await this.findActiveBlock(orgId, s, db, 'tool', input.toolName);
      if (toolBlock) {
        return deny(`tool ${input.toolName} is blocked (${toolBlock.reason})`);
      }
      if (!BUILT_IN_TOOL_DESCRIPTORS.has(input.toolName)) {
        const catalog = new TenantScopedCollection<ToolCatalogDoc>(
          db.collection('tool_catalog'),
        );
        const row = await catalog.findOne(orgId, { name: input.toolName }, s);
        if (!row) {
          // Pinned at publish but the row is gone (deleted post-publish) —
          // fail closed rather than executing against an ungoverned tool.
          return deny(`tool ${input.toolName} has no catalog row at this org`);
        }
        if (!row.enabled) {
          return deny(`tool ${input.toolName} is disabled at this org`);
        }
        // P4 — perimeter drift-deny: the publish-time pin (environment +
        // egress) must still match the live row. A widened environment or
        // egress list after publish refuses until re-published (re-pin =
        // explicit operator acknowledgment). Legacy pins without the
        // fields skip (history stays authorizable exactly as before).
        if (pin !== undefined && typeof pin.execution_environment === 'string') {
          const liveEgress = Array.isArray(row.allowed_egress_domains)
            ? row.allowed_egress_domains
                .filter((d): d is string => typeof d === 'string')
                .slice()
                .sort()
            : [];
          const pinnedEgress = Array.isArray(pin.allowed_egress_domains)
            ? (pin.allowed_egress_domains as unknown[])
                .filter((d): d is string => typeof d === 'string')
                .slice()
                .sort()
            : [];
          const envDrifted = row.execution_environment !== pin.execution_environment;
          const egressDrifted =
            liveEgress.length !== pinnedEgress.length ||
            liveEgress.some((d, i) => d !== pinnedEgress[i]);
          if (envDrifted || egressDrifted) {
            return deny(
              `tool ${input.toolName} perimeter drifted since publish (environment ` +
                `${String(pin.execution_environment)}→${row.execution_environment}, ` +
                `egress [${pinnedEgress.join(',')}]→[${liveEgress.join(',')}]) — ` +
                `re-publish to re-pin the perimeter`,
            );
          }
        }
      }
      // Assistant-level kill for in-flight runs: acceptance already refuses
      // new runs, but a run accepted BEFORE the kill must not authorize new
      // tool calls after it. Either the disabled flag or an active block
      // freezes the assistant. (Version blocks intentionally do NOT gate
      // here — in-flight runs stay pinned to their manifest by invariant.)
      const versions = new TenantScopedCollection<AssistantVersionDoc>(
        db.collection('assistant_versions'),
      );
      const versionRow = await versions.findOne(
        orgId,
        { id: run.assistant_version_id },
        { ...s, projection: { assistant_id: 1 } },
      );
      const assistantId = versionRow?.assistant_id;
      if (assistantId) {
        const assistants = new TenantScopedCollection<AssistantDoc>(
          db.collection('assistants'),
        );
        const assistantRow = await assistants.findOne(
          orgId,
          { id: uuidToBinary(assistantId) },
          { ...s, projection: { disabled_at: 1 } },
        );
        if (assistantRow?.disabled_at) {
          return deny('assistant is disabled');
        }
        const assistantBlock = await this.findActiveBlock(orgId, s, db, 'assistant', assistantId);
        if (assistantBlock) {
          return deny(`assistant is blocked (${assistantBlock.reason})`);
        }
      }

      const effectId = uuidv7();
      // organization_id is injected by TenantScopedCollection.insertOne —
      // the cast reflects the runtime injection.
      const doc = {
        id: uuidToBinary(effectId),
        run_id: uuidToBinary(input.runId),
        step_id: input.stepId ?? null,
        tool_call_id: input.toolCallId,
        tool_name: input.toolName,
        tool_version: input.toolVersion ?? null,
        argument_digest: new Binary(input.argumentDigest),
        result_digest: null,
        status: null,
        result_artifact_id: null,
        authorized_at: nowIso(),
        recorded_at: null,
      } as ToolEffectDoc;
      try {
        await effects.insertOne(orgId, doc, s);
      } catch (err) {
        // uq_tool_effects_call (org, tool_call_id): a lost dedup race
        // replays/conflicts through the same classifier as the read path.
        if (!(err instanceof MongoServerError) || err.code !== 11000) throw err;
        const raced = await effects.findOne(orgId, { tool_call_id: input.toolCallId }, s);
        const same =
          raced?.argument_digest &&
          Buffer.from(raced.argument_digest.buffer).equals(input.argumentDigest);
        if (!same) {
          throw ApiError.conflict('tool_call_id reuse with different arguments', {
            tool_call_id: input.toolCallId,
          });
        }
        return {
          allowed: true,
          toolCapability: undefined,
          approvalRequired: false,
          duplicate: true,
          shadow,
        };
      }

      const approvalRequired = descriptor.approval === 'required';
      const toolCapability = issueCapability({
        organizationId: input.orgId,
        conversationId: run.conversation_id.toUUID().toString(),
        runId: input.runId,
        assistantVersionId: run.assistant_version_id.toUUID().toString(),
        policyVersion: run.policy_snapshot_id.toUUID().toString(),
        allowedOps: ['tool'],
        subject: 'agent-studio-tool',
      }).token;

      this.auditInto(auditTrail, {
        action: 'mcp.tool_authorized',
        resourceType: 'tool_effect',
        resourceId: effectId,
        tenantId: input.orgId,
        details: {
          run_id: input.runId,
          tool: input.toolName,
          approval_required: approvalRequired,
          shadow,
        },
      });
      return {
        allowed: true,
        toolCapability,
        approvalRequired,
        duplicate: false,
        shadow,
      };
    });
    return { ...outcome, auditTrail };
  }

  async recordToolOutcome(input: {
    orgId: string;
    toolCallId: string;
    resultDigest?: Buffer;
    status: string;
    resultArtifactId?: string;
  }): Promise<{ accepted: boolean; wasDuplicate: boolean }> {
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const orgId = this.tenantOrgId(ctx);
      const effects = new TenantScopedCollection<ToolEffectDoc>(
        this.mongo.root.collection('tool_effects'),
      );
      const s = this.sessionOpt(ctx);

      const existing = await effects.findOne(orgId, { tool_call_id: input.toolCallId }, s);
      if (!existing) {
        throw ApiError.notFound('tool call authorization');
      }
      if (existing.recorded_at) {
        const same =
          input.resultDigest &&
          existing.result_digest &&
          Buffer.from(existing.result_digest.buffer).equals(input.resultDigest);
        if (!same) {
          throw ApiError.conflict('tool outcome replay with different digest', {
            tool_call_id: input.toolCallId,
          });
        }
        return { accepted: true, wasDuplicate: true };
      }
      await effects.updateOne(
        orgId,
        { id: existing.id },
        {
          $set: {
            result_digest: input.resultDigest ? new Binary(input.resultDigest) : null,
            status: input.status,
            result_artifact_id: input.resultArtifactId
              ? uuidToBinary(input.resultArtifactId)
              : null,
            recorded_at: nowIso(),
          },
        },
        s,
      );
      return { accepted: true, wasDuplicate: false };
    });
  }

  async getToolCredential(input: {
    orgId: string;
    runId: string;
    toolName: string;
  }): Promise<ToolCredentialOutcome> {
    const auditTrail: RepositoryAuditEvent[] = [];
    // REL-1.4: model-provider keys ride the SAME audited disclosure rail as
    // tool credentials — the gateway asks for the pseudo-tool
    // `model:<provider>`.
    if (input.toolName.startsWith('model:')) {
      const provider = input.toolName.slice('model:'.length);
      if (!MODEL_PROVIDERS.has(provider)) {
        throw ApiError.validation({ tool_name: `unknown model provider: ${provider}` });
      }
      const outcome = await this.getModelCredential(input.orgId, input.runId, provider, auditTrail);
      return { ...outcome, auditTrail };
    }
    const outcome = await this.mongo.withOrg(input.orgId, async (ctx) => {
      const db = this.mongo.root;
      const s = this.sessionOpt(ctx);
      const orgId = this.tenantOrgId(ctx);
      const runs = new TenantScopedCollection<RunDoc>(db.collection('runs'));
      const run = await runs.findOne(orgId, { id: uuidToBinary(input.runId) }, s);
      if (!run) {
        throw ApiError.notFound('run');
      }
      const snapshots = new TenantScopedCollection<PolicySnapshotDoc>(
        db.collection('policy_snapshots'),
      );
      const snapshotRow = await snapshots.findOne(orgId, { id: run.policy_snapshot_id }, s);
      const toolPolicy = (snapshotRow?.tool_policy as {
        tools?: Array<{ name: string }>;
      } | null) ?? { tools: [] };
      const pinned = (toolPolicy.tools ?? []).some((t) => t.name === input.toolName);
      if (!pinned) {
        throw ApiError.validation({ tool_name: 'tool is not pinned on this run' });
      }
      const catalog = new TenantScopedCollection<ToolCatalogDoc>(
        db.collection('tool_catalog'),
      );
      const row = await catalog.findOne(orgId, { name: input.toolName }, s);
      // TPL-6.3 — same gates as authorize, adapted to the disclosure shape:
      // an operator block or a disabled flag denies loudly (audited), while
      // a missing row keeps the legacy empty-credential behavior (platform
      // built-ins carry no row and need no credential).
      if (row) {
        const toolBlock = await this.findActiveBlock(orgId, s, db, 'tool', input.toolName);
        if (toolBlock || !row.enabled) {
          const reason = toolBlock
            ? `tool ${input.toolName} is blocked (${toolBlock.reason})`
            : `tool ${input.toolName} is disabled at this org`;
          this.auditInto(auditTrail, {
            action: 'mcp.tool_credential_denied',
            resourceType: 'tool_catalog',
            resourceId: row.id.toUUID().toString(),
            tenantId: input.orgId,
            details: { run_id: input.runId, tool: input.toolName, reason },
          });
          // Policy denial, not a malformed request — the service maps the
          // returned denial to forbidden (403), the same semantics an
          // authorize denial would produce.
          return { outcome: 'denied' as const, reason };
        }
      }
      if (!row || !row.credential_sealed) {
        return { outcome: 'empty' as const };
      }
      const binding = row.http_binding ?? {};
      this.auditInto(auditTrail, {
        action: 'mcp.tool_credential_disclosed',
        resourceType: 'tool_catalog',
        resourceId: row.id.toUUID().toString(),
        tenantId: input.orgId,
        details: { run_id: input.runId, tool: input.toolName },
      });
      // The SEALED envelope crosses this boundary — the service decrypts
      // after replaying the audit trail. Plaintext never leaves the row.
      return {
        outcome: 'ok' as const,
        catalogId: row.id.toUUID().toString(),
        credentialSealed: row.credential_sealed,
        credentialHeader: binding.header_name ?? 'authorization',
      };
    });
    return { ...outcome, auditTrail };
  }

  private async getModelCredential(
    orgId: string,
    runId: string,
    provider: string,
    auditTrail: RepositoryAuditEvent[],
  ): Promise<
    | { outcome: 'ok'; catalogId: string; credentialSealed: string; credentialHeader: string }
    | { outcome: 'denied'; reason: string }
  > {
    return this.mongo.withOrg(orgId, async (ctx) => {
      const db = this.mongo.root;
      const s = this.sessionOpt(ctx);
      const tenant = this.tenantOrgId(ctx);
      const runs = new TenantScopedCollection<RunDoc>(db.collection('runs'));
      const run = await runs.findOne(tenant, { id: uuidToBinary(runId) }, s);
      if (!run) {
        throw ApiError.notFound('run');
      }
      const snapshots = new TenantScopedCollection<PolicySnapshotDoc>(
        db.collection('policy_snapshots'),
      );
      const snapshotRow = await snapshots.findOne(tenant, { id: run.policy_snapshot_id }, s);
      const modelRef = (snapshotRow?.model_ref ?? null) as {
        models?: Array<{ provider?: string }>;
      } | null;
      const providersOnRun = new Set(
        (modelRef?.models ?? [])
          .map((m) => m?.provider)
          .filter((p): p is string => typeof p === 'string'),
      );
      if (!providersOnRun.has(provider)) {
        // Provider not on this run's model manifest — the pg lane throws
        // forbidden WITHOUT auditing. The repository returns the denial and
        // lets the service keep the thrown semantics.
        return {
          outcome: 'denied' as const,
          reason: `provider ${provider} is not on this run's model manifest`,
        };
      }
      const denied = (
        reason: string,
        auditReason: string,
      ): { outcome: 'denied'; reason: string } => {
        this.auditInto(auditTrail, {
          action: 'mcp.model_credential_denied',
          resourceType: 'provider_credential',
          resourceId: null,
          tenantId: orgId,
          details: { run_id: runId, provider, reason: auditReason },
        });
        return { outcome: 'denied' as const, reason };
      };
      const block = await this.findActiveBlock(tenant, s, db, 'capability', `model:${provider}`);
      if (block) {
        return denied(
          `model capability ${provider} is blocked (${block.reason})`,
          `blocked (${block.reason})`,
        );
      }
      const enablements = new TenantScopedCollection<ProviderEnablementDoc>(
        db.collection('provider_enablements'),
      );
      const enableRow = await enablements.findOne(tenant, { provider }, s);
      if (enableRow && !enableRow.enabled) {
        return denied(
          `provider ${provider} is disabled at this org`,
          'provider disabled at this org',
        );
      }
      const creds = new TenantScopedCollection<ProviderCredentialDoc>(
        db.collection('provider_credentials'),
      );
      const cred = await creds.findOne(
        tenant,
        { provider, status: 'active' },
        { ...s, sort: { created_at: -1 } },
      );
      if (!cred) {
        return denied(`no active ${provider} credential at this org`, 'no active credential');
      }
      this.auditInto(auditTrail, {
        action: 'mcp.model_credential_disclosed',
        resourceType: 'provider_credential',
        resourceId: cred.id.toUUID().toString(),
        tenantId: orgId,
        details: { run_id: runId, provider },
      });
      // The SEALED secret crosses this boundary — plaintext never does.
      return {
        outcome: 'ok' as const,
        catalogId: cred.id.toUUID().toString(),
        credentialSealed: cred.secret_sealed,
        credentialHeader: 'authorization',
      };
    });
  }
}
