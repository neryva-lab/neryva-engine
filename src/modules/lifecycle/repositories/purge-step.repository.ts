/**
 * Purge-step repository (P3) — the persistence port for the per-step EFFECTS
 * of the purge workflow, executed by `RetentionPurgeService` (9.6).
 *
 * `IPurgeTaskRepository` owns the task state machine; this port owns what
 * each step DOES to the world. Each method owns its transaction and its
 * tenant scoping internally (the scoping mirrors the original service:
 * hold checks, availability marks, content purges and outbox writes are
 * tenant-scoped; object-state flips and tombstone writes are platform-plane).
 *
 * The service orchestrates: check → mark → emit → objects (batched, with
 * `StorageService` deletes between list and mark) → content → tombstone.
 * Object storage itself is NOT a persistence port — the service keeps
 * calling `StorageService.deleteObject` directly.
 */
export interface IPurgeStepRepository {
  /**
   * True when an ACTIVE, unexpired legal hold covers the scope
   * (org-wide holds cover every task in the org; scoped holds cover their
   * exact (scopeType, scopeId)). The purge gate is the ACTIVE window — an
   * expired hold no longer blocks.
   */
  findBlockingHold(orgId: string, scopeType: string, scopeId: string): Promise<boolean>;

  /**
   * Product surface unavailable BEFORE anything is destroyed: conversations
   * → `deleted`, artifacts → `retiring` (the DDL-sanctioned state).
   */
  markUnavailable(input: {
    orgId: string;
    scopeType: 'conversation' | 'artifact';
    scopeId: string;
  }): Promise<void>;

  /**
   * Derived stores (chunks/embeddings/caches) delete via the outbox —
   * `conversation.purged` / `artifact.purged` — same durable-delivery
   * guarantee as every other fact (invariant 7: outbox in the same unit as
   * the fact it announces).
   */
  emitDerivedDeletion(input: {
    orgId: string;
    scopeType: string;
    scopeId: string;
    reason: string;
  }): Promise<void>;

  /**
   * Object keys to purge, in `active`/`retiring` state, capped at `limit`.
   * Artifact scope reads the artifact row directly; conversation scope reads
   * ONLY artifacts bound to THIS conversation via its runs (run_events /
   * checkpoints / tool outcomes) — never org-wide artifacts.
   */
  listPurgeableObjects(input: {
    orgId: string;
    scopeType: 'conversation' | 'artifact';
    scopeId: string;
    limit: number;
  }): Promise<Array<{ id: string; objectKey: string }>>;

  /** Flip one artifact to `purged` after its object was deleted. */
  markObjectPurged(objectId: string): Promise<void>;

  /**
   * Relational content per policy: messages purged (transcript data), runs
   * kept as redacted skeletons for billing/audit explainability, memory
   * items soft-deleted.
   */
  purgeConversationContent(orgId: string, conversationId: string): Promise<void>;

  /**
   * Terminal step: idempotent tombstone insert (no-op when the pair is
   * already tombstoned).
   */
  writeTombstone(input: {
    orgId: string;
    scopeType: string;
    scopeId: string;
    reason: string;
  }): Promise<void>;

  /**
   * Tombstone lookup for the typed-410 guard (`assertNotTombstoned`).
   * Platform-plane (withBypass): the caller checks a resource id that may
   * belong to any tenant. Returns the tombstone's reason, or null.
   */
  findTombstone(resourceType: string, resourceId: string): Promise<{ reason: string } | null>;
}
