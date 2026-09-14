import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { ApiError } from '../../common/http/api-error';

/**
 * Publish-gate evaluation (REL-3.2 gates, REL-3.3 matrix).
 *
 * The publish path (`AssistantsService`) delegates to `evaluatePublishGate`
 * and throws on refusal — the SQL, precedence, and error shapes here ARE the
 * gate, factored out so the negative matrix is testable without booting the
 * application (the service carries seven dependencies; this needs a tx).
 *
 * Precedence is load-bearing: the BLOCK refusal wins over a missing-PASS
 * refusal when both apply, because a critical failure is the more urgent
 * fact. The decision lookup is keyed by CONTENT hash against the latest
 * completed decision, so a bad payload cannot re-enter through
 * rollback-as-new or a fresh draft, while a re-evaluation that passes
 * clears an earlier BLOCK (latest wins).
 */

export interface GateRefusal {
  gate: 'blocked_content' | 'required_checks';
  message: string;
  details: Record<string, unknown>;
}

/** BLOCK rule (TPL-6.1): the latest completed decision must not be BLOCK. */
export function decideBlockedContent(latestDecision: string | null | undefined): GateRefusal | null {
  if (latestDecision === 'BLOCK') {
    return {
      gate: 'blocked_content',
      message: 'the latest evaluation of this content decided BLOCK — resolve the critical failures and re-evaluate before publishing',
      details: {},
    };
  }
  return null;
}

/**
 * Required-checks rule (REL-3.2, D1 adopted): when the source template
 * declares required checks, only a fresh PASS on THIS content hash publishes.
 * WARN, BLOCK, and absent all refuse. No declared checks keeps the legacy
 * posture (this rule passes; the BLOCK rule still applies).
 */
export function decideRequiredChecks(required: string[], latestDecision: string | null): GateRefusal | null {
  if (required.length === 0) {
    return null;
  }
  if (latestDecision === 'PASS') {
    return null;
  }
  return {
    gate: 'required_checks',
    message: `release policy requires a fresh PASS evaluation (checks: ${required.join(', ')}); the latest decision for this content is ${latestDecision ?? 'absent'} — evaluate this version, then publish`,
    details: { required_checks: required, latest_decision: latestDecision },
  };
}

/**
 * Full gate against live rows. Returns the refusal to raise, or null when
 * the content may publish. Callers throw `ApiError.conflict` with the
 * refusal's message plus the assistant id — the conflict contract the
 * publish path has always exposed.
 */
export async function evaluatePublishGate(
  tx: NodePgDatabase,
  orgId: string,
  assistantId: string,
  hash: string,
): Promise<GateRefusal | null> {
  const policyRows = await tx.execute(sql`
    select t.release_policy
    from assistant_installs i
    join assistant_templates t on t.slug = i.slug and t.version = i.template_version
    where i.assistant_id = ${assistantId}::uuid
    limit 1
  `);
  const policy = (policyRows.rows[0] as { release_policy?: { required?: unknown } } | undefined)?.release_policy;
  const required = Array.isArray(policy?.required) ? (policy?.required as unknown[]).filter((c): c is string => typeof c === 'string') : [];

  const decisionRows = await tx.execute(sql`
    select er.decision
    from eval_runs er
    join assistant_versions av on av.id = er.assistant_version_id
    where er.organization_id = ${orgId}::uuid
      and av.assistant_id = ${assistantId}::uuid
      and av.hash = ${hash}
      and er.state = 'completed'
      and er.decision is not null
    order by er.finished_at desc nulls last, er.created_at desc
    limit 1
  `);
  const decision = (decisionRows.rows[0] as { decision?: string } | undefined)?.decision ?? null;

  return decideBlockedContent(decision) ?? decideRequiredChecks(required, decision);
}

/** Throw the publish-path conflict for a refusal (keeps the error shape in one place). */
export function throwGateRefusal(refusal: GateRefusal, assistantId: string): never {
  throw ApiError.conflict(refusal.message, { assistant_id: assistantId, ...refusal.details });
}
