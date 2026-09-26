/**
 * Tool-authority repository (P3) — the persistence port for tool-call
 * authorization, outcome recording, and the audited credential-disclosure
 * rail (`McpAuthorityService`, §5.10 + GetToolCredential).
 *
 * `authorizeToolCall` and `getToolCredential` return their audit trail in
 * order; the service replays it with `auditSafe` after the repository call
 * resolves. Policy denials are RETURNED (`allowed: false` /
 * `outcome: 'denied'`); the service maps them to the HTTP error. Only
 * genuine preconditions (missing run, digest-mismatched replay) throw typed
 * `ApiError`s.
 */
import type { RepositoryAuditEvent } from './repository-types';

/** Outcome of the audited credential-disclosure rail. */
export type ToolCredentialOutcome =
  | {
      outcome: 'ok';
      catalogId: string;
      /** Still sealed — the service decrypts after replaying the audit trail. */
      credentialSealed: string;
      credentialHeader: string;
      auditTrail: RepositoryAuditEvent[];
    }
  | {
      /** Legacy empty-credential behavior: no row, or row without a sealed credential. No audit. */
      outcome: 'empty';
      auditTrail: RepositoryAuditEvent[];
    }
  | {
      /** Policy denial — the service replays the audit trail, then throws forbidden. */
      outcome: 'denied';
      reason: string;
      auditTrail: RepositoryAuditEvent[];
    };

export interface AuthorizeToolOutcome {
  allowed: boolean;
  reason?: string;
  toolCapability?: string;
  approvalRequired: boolean;
  duplicate: boolean;
  /** True when the pinned binding runs in shadow mode (simulate, never execute). */
  shadow: boolean;
  auditTrail: RepositoryAuditEvent[];
}

export interface IToolAuthorityRepository {
  /**
   * Authorize a tool call against the pinned snapshot: dedup on tool_call_id
   * (same digest replays the ack, different digest conflicts), tool-policy
   * membership, kill levels (capability/tool/assistant), catalog
   * enabled/perimeter checks, then the tool_effect insert and capability
   * mint. Denials and authorizations both arrive on the audit trail.
   */
  authorizeToolCall(input: {
    orgId: string;
    runId: string;
    stepId?: string;
    toolCallId: string;
    toolName: string;
    toolVersion?: string;
    argumentDigest: Buffer;
  }): Promise<AuthorizeToolOutcome>;

  /** Record a tool outcome: first write wins, digest-mismatched replays conflict. */
  recordToolOutcome(input: {
    orgId: string;
    toolCallId: string;
    resultDigest?: Buffer;
    status: string;
    resultArtifactId?: string;
  }): Promise<{ accepted: boolean; wasDuplicate: boolean }>;

  /**
   * GetToolCredential incl. the `model:<provider>` pseudo-tool branch.
   * Gates, in order: pinned-on-snapshot, catalog presence, operator
   * block / disabled flag (denied loudly + audited), legacy empty when no
   * row or no sealed credential. The plaintext never crosses this
   * interface — only the sealed envelope, which the service decrypts.
   */
  getToolCredential(input: {
    orgId: string;
    runId: string;
    toolName: string;
  }): Promise<ToolCredentialOutcome>;
}
