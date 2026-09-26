/**
 * Checkpoint repository (P3) — the persistence port for run checkpoints
 * (`McpAuthorityService`, §5.8).
 */
export interface CheckpointData {
  checkpointRef: string;
  checkpointVersion: number;
  artifact?: {
    artifactId: string;
    mediaType: string;
    byteLength: number;
    sha256: Buffer;
    purpose: string;
  };
}

export interface ICheckpointRepository {
  /** Idempotent per (run, ref, version): same digest replays, different digest conflicts. */
  saveCheckpointRef(input: {
    orgId: string;
    runId: string;
    checkpointRef: string;
    checkpointVersion: number;
    artifactId?: string;
    digest: Buffer;
    producer: string;
  }): Promise<{ accepted: boolean; replay: boolean }>;

  /** Newest checkpoint + its artifact row (null when none). */
  getLatestCheckpoint(input: { orgId: string; runId: string }): Promise<CheckpointData | null>;
}
