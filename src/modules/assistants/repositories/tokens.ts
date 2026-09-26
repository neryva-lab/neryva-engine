/**
 * Repository injection tokens (P3).
 *
 * `AssistantsService` depends on the repository PORTS (interfaces), never
 * on the lane adapters. The module maps each token to the lane adapter
 * (`Pg*` vs `Mongo*`) — lane selection lives in module wiring, not in the
 * service. Until the module registers these providers, the tokens are
 * compile-time only (see the P3 report).
 */
import type { IAssistantRepository, VersionPayloadValues } from './assistant.repository';
import type { IAssistantVersionRepository } from './assistant-version.repository';
import type { IPolicySnapshotRepository } from './policy-snapshot.repository';
import type { IAssistantKnowledgeQueries } from './assistant-knowledge.queries';

/**
 * The three aggregate tokens are defined once in `repository-tokens.ts` —
 * re-exported here so every consumer resolves the same `Symbol()`.
 */
export {
  ASSISTANT_REPOSITORY,
  ASSISTANT_VERSION_REPOSITORY,
  POLICY_SNAPSHOT_REPOSITORY,
} from './repository-tokens';

export type {
  IAssistantRepository,
  IAssistantVersionRepository,
  IPolicySnapshotRepository,
  IAssistantKnowledgeQueries,
  VersionPayloadValues,
};

export const ASSISTANT_KNOWLEDGE_QUERIES = Symbol('IAssistantKnowledgeQueries');
export type AssistantKnowledgeQueriesToken = typeof ASSISTANT_KNOWLEDGE_QUERIES;
