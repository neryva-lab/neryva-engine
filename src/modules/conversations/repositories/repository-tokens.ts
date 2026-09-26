/**
 * DI tokens for the conversations-module repository ports (P3).
 *
 * One focused token per aggregate/transaction-boundary cluster (interface
 * segregation): services depend only on these interfaces, never on a
 * concrete `Pg*`/`Mongo*` class. The concrete implementation behind each
 * token is selected by `DB_PROVIDER` (PostgreSQL default) in
 * `ConversationsModule` via a single `useFactory` per token — no
 * provider conditionals in services or repositories.
 */
export const CONVERSATION_REPOSITORY = Symbol('IConversationRepository');
export const RUN_REPOSITORY = Symbol('IRunRepository');
export const SHARE_REPOSITORY = Symbol('IShareRepository');
export const FEEDBACK_REPOSITORY = Symbol('IFeedbackRepository');
export const ESCALATION_REPOSITORY = Symbol('IEscalationRepository');
export const RUN_LEASE_REPOSITORY = Symbol('IRunLeaseRepository');
export const RUN_EVENTS_REPOSITORY = Symbol('IRunEventsRepository');
export const APPROVAL_REPOSITORY = Symbol('IApprovalRepository');
export const TOOL_AUTHORITY_REPOSITORY = Symbol('IToolAuthorityRepository');
export const CHECKPOINT_REPOSITORY = Symbol('ICheckpointRepository');
export const ARTIFACT_REPOSITORY = Symbol('IArtifactRepository');
export const RUN_CONTEXT_REPOSITORY = Symbol('IRunContextRepository');
export const MEMORY_REPOSITORY = Symbol('IMemoryRepository');
export const RUN_TERMINAL_REPOSITORY = Symbol('IRunTerminalRepository');
