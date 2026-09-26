/**
 * Domain types for the bounded ContextManifest (contract v1.1), assembled by
 * `IRunContextRepository.assembleRunContext` exactly as the current
 * `McpAuthorityService.getAuthorizedRunContext`. Shape is intentionally a
 * verbatim copy of the service's declared return type — provider-blind.
 */

/** P2 (overflow routing): alias → context window in tokens, null when unknown. */
export type ModelWindows = Record<string, number | null>;

/**
 * The bounded ContextManifest (contract v1.1).
 */
export interface RunContextManifest {
  assistantVersionId: string;
  policyVersion: string;
  /** The run actor's account id (null for service/channel triggers). */
  runUserId: string | null;
  conversationSummary: string;
  recentMessages: Array<{ messageId: string; role: string; text: string }>;
  memories: Array<{
    memoryId: string;
    scope: string;
    scopeId?: string;
    provenance: string;
    content?: string;
    contentMediaType?: string;
  }>;
  knowledgeRefs: Array<{
    documentId: string;
    chunkId: string;
    snippet?: string;
    title?: string;
    score?: number;
    sourceRangeStart?: number;
    sourceRangeEnd?: number;
  }>;
  tools: Array<{
    name: string;
    effectClass: string;
    approvalRequirement: string;
    description?: string;
    inputSchemaJson?: string;
    httpBinding?: { url: string; method: string; timeout_ms: number; header_name: string } | null;
    annotations?: {
      readOnly: boolean;
      destructive: boolean;
      idempotent: boolean;
      openWorld: boolean;
    };
  }>;
  artifactRefs: unknown[];
  instructions?: string;
  allowedModels: string[];
  /** Alias → context window in tokens, null when the catalog has no window. */
  modelWindows: ModelWindows;
  modelParams?: {
    temperature?: number;
    maxOutputTokens?: number;
    topP?: number;
    reasoningEffort?: string;
    outputSchema?: string;
  };
  budgets: {
    maxToolCalls: number;
    maxModelCalls: number;
    maxOutputBytes: bigint;
    maxTotalTokens: bigint;
    maxCostMicros: bigint;
    wallClockSeconds: number;
  };
  guardrailPolicy: {
    inputPolicy: string;
    outputPolicy: string;
    piiRedaction: boolean;
    /** blocking | logging — legacy snapshots resolve blocking. */
    executionMode: 'blocking' | 'logging';
  };
  brandVoice?: string;
}
