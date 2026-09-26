/**
 * Artifact repository (P3) — the persistence port for run artifacts
 * (`McpAuthorityService` artifact registration + the GetRunArtifact
 * claim-check facade reads).
 *
 * `findRunArtifact` returns the artifact row (org-scoped) and whether it is
 * bound to the run via its checkpoints, tool effects, or run events. The 7
 * facade checks and the presigned URL stay in the service.
 */
export interface RunArtifactData {
  artifact: {
    id: string;
    purpose: string;
    expiresAt: string | null;
    sha256: Buffer | null;
    byteLength: number;
    state: string;
    scanStatus: string | null;
    objectKey: string;
    contentTypeDetected: string | null;
    contentTypeDeclared: string | null;
    encryptionKeyRef: string | null;
  } | null;
  bound: boolean;
}

export interface IArtifactRepository {
  /** Register the artifact row for just-uploaded bytes (bytes already in storage). */
  registerArtifact(input: {
    orgId: string;
    artifactId: string;
    purpose: 'CHECKPOINT' | 'TOOL_RESULT' | 'GENERATED_MEDIA';
    objectKey: string;
    mediaType: string;
    byteLength: number;
    sha256: Buffer;
  }): Promise<void>;

  findRunArtifact(input: {
    orgId: string;
    runId: string;
    artifactId: string;
  }): Promise<RunArtifactData>;
}
