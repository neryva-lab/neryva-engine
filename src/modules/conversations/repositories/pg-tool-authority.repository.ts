/**
 * PostgreSQL tool-authority repository (P3) — tool-call authorization,
 * outcome recording, and the audited credential-disclosure rail (ledger
 * §5.10 + GetToolCredential).
 *
 * Mechanical move of the `McpAuthorityService` units. `authorizeToolCall`
 * and `getToolCredential` collect each audit event into a local
 * `auditTrail` in call order and return it; the service replays it with
 * `auditSafe` after the repository call resolves. Policy denials are
 * RETURNED (`allowed: false` / `outcome: 'denied'`); the service maps them
 * to the HTTP error. Only genuine preconditions (missing rows,
 * digest-mismatched replays) throw typed `ApiError`s — the same codes as
 * the service, never driver errors.
 *
 * The credential-disclosure rail crosses the interface SEALED only: the
 * plaintext never crosses this interface — the service decrypts after
 * replaying the audit trail.
 *
 * Observability note: the service's `withSpan('tool.authorization', …)`
 * wrapper (P1 §6a) stays in the service; the span attributes are derived
 * from the returned outcome there.
 */
import { and, desc, eq } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { ApiError } from '../../../common/http/api-error';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { issueCapability } from '../../../common/auth/capability-token';
import { runs } from '../schema';
import { toolEffects } from '../mcp.schema';
import { policySnapshots, assistants, assistantVersions } from '../../assistants/schema';
import { toolCatalog } from '../../assistants/tool-catalog.schema';
import { BUILT_IN_TOOLS } from '../../assistants/tool-catalog.service';
import {
  providerCredentials,
  providerEnablements,
  isModelProvider,
} from '../../assistants/provider-credentials.schema';
import { ControlBlocksService } from '../../assistants/control-blocks.service';
import { isTerminalRun } from '../state-machine';
import type { RepositoryAuditEvent } from './repository-types';
import type {
  AuthorizeToolOutcome,
  IToolAuthorityRepository,
  ToolCredentialOutcome,
} from './tool-authority.repository';

export class PgToolAuthorityRepository implements IToolAuthorityRepository {
  constructor(private readonly db: DbService) {}

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
    return this.db.withOrg(input.orgId, async (tx) => {
      const found = await tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1);
      if (found.length === 0) {
        throw ApiError.notFound('run');
      }
      const run = found[0];
      if (isTerminalRun(run.state)) {
        throw ApiError.conflict('run is terminal; tool calls rejected', { state: run.state });
      }

      // Snapshot + pinned binding resolve BEFORE the dedup return: a
      // replayed ack still reports its binding's shadow mode truthfully.
      // (Reads only — the descriptor-missing DENY below stays after
      // dedup, preserving replay-ack idempotency.)
      const snapshot = await tx
        .select()
        .from(policySnapshots)
        .where(eq(policySnapshots.id, run.policySnapshotId))
        .limit(1);
      if (snapshot.length === 0) {
        throw ApiError.internal();
      }
      const bindingsRaw = (snapshot[0] as { toolBindings?: unknown }).toolBindings;
      const bindingsList = Array.isArray(bindingsRaw)
        ? (bindingsRaw as Array<Record<string, unknown>>)
        : [];
      const pin = bindingsList.find((b) => b.name === input.toolName) as
        | {
            execution_environment?: unknown;
            allowed_egress_domains?: unknown;
            execution_mode?: unknown;
          }
        | undefined;
      // Legacy snapshots predate the perimeter pin (P4): no fields = no
      // drift verdict possible — the check below skips, exactly as
      // before. Only pins that CARRY the perimeter can fail on drift.
      const shadow = pin?.execution_mode === 'shadow';

      const duplicate = await tx
        .select()
        .from(toolEffects)
        .where(
          and(
            eq(toolEffects.organizationId, input.orgId),
            eq(toolEffects.toolCallId, input.toolCallId),
          ),
        )
        .limit(1);
      if (duplicate.length > 0) {
        const same =
          duplicate[0].argumentDigest &&
          Buffer.from(duplicate[0].argumentDigest).equals(input.argumentDigest);
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
          auditTrail,
        };
      }

      // Policy check against the pinned snapshot's tool_policy.
      const toolPolicy = snapshot[0].toolPolicy as {
        tools?: Array<{ name: string; approval?: string }>;
      };
      const descriptor = toolPolicy?.tools?.find((t) => t.name === input.toolName);
      if (!descriptor) {
        return {
          allowed: false,
          reason: `tool ${input.toolName} is not in the pinned tool policy`,
          approvalRequired: false,
          duplicate: false,
          shadow: false,
          auditTrail,
        };
      }

      // TPL-6.3 kill levels 2-4 — evaluated on EVERY new authorization (no
      // cache, so kill-to-deny latency is one RPC). Order: explicit operator
      // blocks first (cheapest, most specific), then the catalog enabled
      // flag. NOTE: the dedup early-return above intentionally precedes all
      // of this — replaying an already-authorized call's ack is idempotency,
      // not a new authorization; freezing it would corrupt exactly-once
      // completion of in-flight effects.
      const deny = async (
        reason: string,
      ): Promise<{
        allowed: false;
        reason: string;
        approvalRequired: false;
        duplicate: false;
        shadow: boolean;
        auditTrail: RepositoryAuditEvent[];
      }> => {
        auditTrail.push({
          action: 'mcp.tool_denied',
          resourceType: 'tool_effect',
          resourceId: run.id,
          tenantId: input.orgId,
          details: { run_id: input.runId, tool: input.toolName, reason },
        });
        return { allowed: false, reason, approvalRequired: false, duplicate: false, shadow, auditTrail };
      };
      const capabilityBlock = await ControlBlocksService.findActiveBlock(
        tx,
        input.orgId,
        'capability',
        'tool',
      );
      if (capabilityBlock) {
        return deny(`tool capability frozen (${capabilityBlock.reason})`);
      }
      const toolBlock = await ControlBlocksService.findActiveBlock(
        tx,
        input.orgId,
        'tool',
        input.toolName,
      );
      if (toolBlock) {
        return deny(`tool ${input.toolName} is blocked (${toolBlock.reason})`);
      }
      if (!BUILT_IN_TOOLS.has(input.toolName)) {
        const catalogRows = await tx
          .select({
            id: toolCatalog.id,
            enabled: toolCatalog.enabled,
            executionEnvironment: toolCatalog.executionEnvironment,
            allowedEgressDomains: toolCatalog.allowedEgressDomains,
          })
          .from(toolCatalog)
          .where(
            and(
              eq(toolCatalog.organizationId, input.orgId),
              eq(toolCatalog.name, input.toolName),
            ),
          )
          .limit(1);
        const row = catalogRows[0];
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
          const liveEgress = Array.isArray(row.allowedEgressDomains)
            ? (row.allowedEgressDomains as unknown[])
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
          const envDrifted = row.executionEnvironment !== pin.execution_environment;
          const egressDrifted =
            liveEgress.length !== pinnedEgress.length ||
            liveEgress.some((d, i) => d !== pinnedEgress[i]);
          if (envDrifted || egressDrifted) {
            return deny(
              `tool ${input.toolName} perimeter drifted since publish (environment ${String(pin.execution_environment)}→${row.executionEnvironment}, egress [${pinnedEgress.join(',')}]→[${liveEgress.join(',')}]) — re-publish to re-pin the perimeter`,
            );
          }
        }
      }
      // Assistant-level kill for in-flight runs: acceptance already refuses
      // new runs, but a run accepted BEFORE the kill must not authorize new
      // tool calls after it. Either the disabled flag or an active block
      // freezes the assistant. (Version blocks intentionally do NOT gate
      // here — in-flight runs stay pinned to their manifest by invariant.)
      const versionRows = await tx
        .select({ assistantId: assistantVersions.assistantId })
        .from(assistantVersions)
        .where(eq(assistantVersions.id, run.assistantVersionId))
        .limit(1);
      const assistantId = versionRows[0]?.assistantId;
      if (assistantId) {
        const assistantRows = await tx
          .select({ disabledAt: assistants.disabledAt })
          .from(assistants)
          .where(eq(assistants.id, assistantId))
          .limit(1);
        if (assistantRows[0]?.disabledAt) {
          return deny(`assistant is disabled`);
        }
        const assistantBlock = await ControlBlocksService.findActiveBlock(
          tx,
          input.orgId,
          'assistant',
          assistantId,
        );
        if (assistantBlock) {
          return deny(`assistant is blocked (${assistantBlock.reason})`);
        }
      }

      const effectId = uuidv7();
      await tx.insert(toolEffects).values({
        id: effectId,
        organizationId: input.orgId,
        runId: input.runId,
        stepId: input.stepId ?? null,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        toolVersion: input.toolVersion ?? null,
        argumentDigest: input.argumentDigest,
      });

      const approvalRequired = descriptor.approval === 'required';
      const toolCapability = issueCapability({
        organizationId: input.orgId,
        conversationId: run.conversationId,
        runId: input.runId,
        assistantVersionId: run.assistantVersionId,
        policyVersion: run.policySnapshotId,
        allowedOps: ['tool'],
        subject: 'agent-studio-tool',
      }).token;

      auditTrail.push({
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
        auditTrail,
      };
    });
  }

  async recordToolOutcome(input: {
    orgId: string;
    toolCallId: string;
    resultDigest?: Buffer;
    status: string;
    resultArtifactId?: string;
  }): Promise<{ accepted: boolean; wasDuplicate: boolean }> {
    return this.db.withOrg(input.orgId, async (tx) => {
      const rows = await tx
        .select()
        .from(toolEffects)
        .where(
          and(
            eq(toolEffects.organizationId, input.orgId),
            eq(toolEffects.toolCallId, input.toolCallId),
          ),
        )
        .limit(1);
      if (rows.length === 0) {
        throw ApiError.notFound('tool call authorization');
      }
      const effect = rows[0];
      if (effect.recordedAt) {
        const same =
          input.resultDigest &&
          effect.resultDigest &&
          Buffer.from(effect.resultDigest).equals(input.resultDigest);
        if (!same) {
          throw ApiError.conflict('tool outcome replay with different digest', {
            tool_call_id: input.toolCallId,
          });
        }
        return { accepted: true, wasDuplicate: true };
      }
      await tx
        .update(toolEffects)
        .set({
          resultDigest: input.resultDigest ?? null,
          status: input.status,
          resultArtifactId: input.resultArtifactId ?? null,
          recordedAt: new Date().toISOString(),
        })
        .where(eq(toolEffects.id, effect.id));
      return { accepted: true, wasDuplicate: false };
    });
  }

  /**
   * GetToolCredential (contract v1.3, FL-2.10) — scoped disclosure of a
   * tool's customer-endpoint credential. The tool must be pinned on the
   * run's policy snapshot AND present in the org catalog with a bound
   * credential; disclosure is audited and never flows through the manifest.
   *
   * REL-1.4 (release_ledger.md): model-provider keys ride the SAME audited
   * disclosure rail as tool credentials — the gateway asks for the
   * pseudo-tool `model:<provider>`. No contract change: GetToolCredential
   * already carries (credential, credential_header) and the capability
   * scope check happened at the transport boundary.
   *
   * Gates, in order: pinned-on-snapshot, catalog presence, operator block /
   * disabled flag (denied loudly + audited), legacy empty when no row or no
   * sealed credential. The SEALED envelope crosses the interface, never
   * plaintext — the service decrypts after replaying the audit trail.
   */
  async getToolCredential(input: {
    orgId: string;
    runId: string;
    toolName: string;
  }): Promise<ToolCredentialOutcome> {
    if (input.toolName.startsWith('model:')) {
      const provider = input.toolName.slice('model:'.length);
      if (!isModelProvider(provider)) {
        throw ApiError.validation({ tool_name: `unknown model provider: ${provider}` });
      }
      return this.getModelCredential({ orgId: input.orgId, runId: input.runId, provider });
    }
    const auditTrail: RepositoryAuditEvent[] = [];
    const row = await this.db.withOrg(input.orgId, async (tx) => {
      const runRows = await tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1);
      if (runRows.length === 0) {
        throw ApiError.notFound('run');
      }
      const run = runRows[0];
      const snapshotRows = await tx
        .select()
        .from(policySnapshots)
        .where(eq(policySnapshots.id, run.policySnapshotId))
        .limit(1);
      const toolPolicy = (snapshotRows[0]?.toolPolicy as {
        tools?: Array<{ name: string }>;
      } | null) ?? { tools: [] };
      const pinned = (toolPolicy.tools ?? []).some((t) => t.name === input.toolName);
      if (!pinned) {
        throw ApiError.validation({ tool_name: 'tool is not pinned on this run' });
      }
      const catalogRows = await tx
        .select()
        .from(toolCatalog)
        .where(
          and(eq(toolCatalog.organizationId, input.orgId), eq(toolCatalog.name, input.toolName)),
        )
        .limit(1);
      const catalogRow = catalogRows[0] ?? null;
      // TPL-6.3 — same gates as authorize, adapted to the disclosure shape:
      // an operator block or a disabled flag denies loudly (audited), while
      // a missing row keeps the legacy empty-credential behavior (platform
      // built-ins carry no row and need no credential).
      if (catalogRow) {
        const toolBlock = await ControlBlocksService.findActiveBlock(
          tx,
          input.orgId,
          'tool',
          input.toolName,
        );
        if (toolBlock || !catalogRow.enabled) {
          const reason = toolBlock
            ? `tool ${input.toolName} is blocked (${toolBlock.reason})`
            : `tool ${input.toolName} is disabled at this org`;
          auditTrail.push({
            action: 'mcp.tool_credential_denied',
            resourceType: 'tool_catalog',
            resourceId: catalogRow.id,
            tenantId: input.orgId,
            details: { run_id: input.runId, tool: input.toolName, reason },
          });
          // Policy denial, not a malformed request — the service maps this
          // to forbidden (403), the same semantics an authorize denial would
          // produce.
          return { denied: true as const, reason };
        }
      }
      return { denied: false as const, catalogRow };
    });
    if (row.denied) {
      return { outcome: 'denied', reason: row.reason, auditTrail };
    }
    const entry = row.catalogRow;
    if (!entry || !entry.credentialSealed) {
      // Legacy empty-credential behavior: no row, or row without a sealed
      // credential. No audit.
      return { outcome: 'empty', auditTrail };
    }
    const binding = (entry.httpBinding ?? {}) as { header_name?: string };
    auditTrail.push({
      action: 'mcp.tool_credential_disclosed',
      resourceType: 'tool_catalog',
      resourceId: entry.id,
      tenantId: input.orgId,
      details: { run_id: input.runId, tool: input.toolName },
    });
    return {
      outcome: 'ok',
      catalogId: entry.id,
      credentialSealed: entry.credentialSealed,
      credentialHeader: binding.header_name ?? 'authorization',
      auditTrail,
    };
  }

  /**
   * Model-provider credential disclosure (REL-1.4 Engine half). Gates, in
   * order: the provider must appear on THIS run's resolved model manifest
   * (a run can never reach a provider its snapshot did not pin), the
   * capability-level kill switch (`model:<provider>`) must be silent, the
   * provider must be enabled at the org, and an ACTIVE credential must
   * exist. Every outcome — denial or disclosure — is audited. The plaintext
   * never exists here: only the sealed envelope crosses the interface.
   */
  private async getModelCredential(input: {
    orgId: string;
    runId: string;
    provider: string;
  }): Promise<ToolCredentialOutcome> {
    const auditTrail: RepositoryAuditEvent[] = [];
    const result = await this.db.withOrg(input.orgId, async (tx) => {
      const runRows = await tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1);
      if (runRows.length === 0) {
        throw ApiError.notFound('run');
      }
      const snapshotRows = await tx
        .select()
        .from(policySnapshots)
        .where(eq(policySnapshots.id, runRows[0].policySnapshotId))
        .limit(1);
      const modelRef = (snapshotRows[0]?.modelRef ?? null) as {
        models?: Array<{ provider?: string }>;
      } | null;
      const providersOnRun = new Set(
        (modelRef?.models ?? [])
          .map((m) => m?.provider)
          .filter((p): p is string => typeof p === 'string'),
      );
      if (!providersOnRun.has(input.provider)) {
        return {
          denied: true as const,
          reason: `provider ${input.provider} is not on this run's model manifest`,
        };
      }
      const block = await ControlBlocksService.findActiveBlock(
        tx,
        input.orgId,
        'capability',
        `model:${input.provider}`,
      );
      if (block) {
        const reason = `blocked (${block.reason})`;
        auditTrail.push({
          action: 'mcp.model_credential_denied',
          resourceType: 'provider_credential',
          resourceId: null,
          tenantId: input.orgId,
          details: { run_id: input.runId, provider: input.provider, reason },
        });
        return {
          denied: true as const,
          reason: `model capability ${input.provider} is blocked (${block.reason})`,
        };
      }
      const enableRows = await tx
        .select()
        .from(providerEnablements)
        .where(
          and(
            eq(providerEnablements.organizationId, input.orgId),
            eq(providerEnablements.provider, input.provider),
          ),
        )
        .limit(1);
      if (enableRows[0] && !enableRows[0].enabled) {
        auditTrail.push({
          action: 'mcp.model_credential_denied',
          resourceType: 'provider_credential',
          resourceId: null,
          tenantId: input.orgId,
          details: {
            run_id: input.runId,
            provider: input.provider,
            reason: 'provider disabled at this org',
          },
        });
        return {
          denied: true as const,
          reason: `provider ${input.provider} is disabled at this org`,
        };
      }
      const credRows = await tx
        .select()
        .from(providerCredentials)
        .where(
          and(
            eq(providerCredentials.organizationId, input.orgId),
            eq(providerCredentials.provider, input.provider),
            eq(providerCredentials.status, 'active'),
          ),
        )
        .orderBy(desc(providerCredentials.createdAt))
        .limit(1);
      const cred = credRows[0] ?? null;
      if (!cred) {
        auditTrail.push({
          action: 'mcp.model_credential_denied',
          resourceType: 'provider_credential',
          resourceId: null,
          tenantId: input.orgId,
          details: {
            run_id: input.runId,
            provider: input.provider,
            reason: 'no active credential',
          },
        });
        return {
          denied: true as const,
          reason: `no active ${input.provider} credential at this org`,
        };
      }
      auditTrail.push({
        action: 'mcp.model_credential_disclosed',
        resourceType: 'provider_credential',
        resourceId: cred.id,
        tenantId: input.orgId,
        details: { run_id: input.runId, provider: input.provider },
      });
      return { denied: false as const, cred };
    });
    if (result.denied) {
      return { outcome: 'denied', reason: result.reason, auditTrail };
    }
    return {
      outcome: 'ok',
      catalogId: result.cred.id,
      credentialSealed: result.cred.secretSealed,
      credentialHeader: 'authorization',
      auditTrail,
    };
  }
}
