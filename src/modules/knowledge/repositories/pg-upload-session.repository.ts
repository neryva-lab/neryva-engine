import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { ApiError } from '../../../common/http/api-error';
import { artifacts, documents, uploadSessions } from '../schema';
import type { Artifact, UploadSession } from '../schema';
import type { NewArtifact, NewUploadSession } from './repository-types';
import type { IUploadSessionRepository } from './upload-session.repository';

/**
 * PostgreSQL implementation of `IUploadSessionRepository` (P3).
 *
 * Mechanical move of the upload-session SQL from `KnowledgeIngestionWorker`
 * (worker/bypass methods) and `ArtifactsService` (API/withOrg methods).
 * Each method owns its transaction; no transaction handle leaks.
 *
 * Tenant discipline is per-method (see the interface): worker methods run
 * `withBypass`; API methods run `withOrg`.
 *
 * What stays OUT (still the service/worker's job): S3 interaction
 * (presigned URLs, headObject), scan-verdict computation, input validation,
 * tracing spans, audit writes.
 */
export class PgUploadSessionRepository implements IUploadSessionRepository {
  constructor(private readonly db: DbService) {}

  async claimNext(states: string[], staleBefore: Date): Promise<UploadSession | null> {
    const staleBeforeIso = staleBefore.toISOString();
    return this.db.withBypass(async (tx) => {
      const rows = await tx
        .select()
        .from(uploadSessions)
        .where(
          and(
            inArray(uploadSessions.state, states),
            or(isNull(uploadSessions.lockedAt), lte(uploadSessions.lockedAt, staleBeforeIso)),
          ),
        )
        .orderBy(asc(uploadSessions.createdAt))
        .limit(1)
        .for('update', { skipLocked: true });
      if (rows.length === 0) {
        return null;
      }
      const updated = await tx
        .update(uploadSessions)
        .set({ lockedAt: new Date().toISOString() })
        .where(eq(uploadSessions.id, rows[0].id))
        .returning();
      return updated[0];
    });
  }

  async releaseLock(sessionId: string): Promise<void> {
    await this.db.withBypass(async (tx) => {
      await tx
        .update(uploadSessions)
        .set({ lockedAt: null })
        .where(eq(uploadSessions.id, sessionId));
    });
  }

  async applyScanVerdict(input: {
    sessionId: string;
    artifactId: string;
    verdict: 'clean' | 'infected' | 'skipped';
    at: Date;
  }): Promise<void> {
    const atIso = input.at.toISOString();
    await this.db.withBypass(async (tx) => {
      if (input.verdict === 'infected') {
        await tx
          .update(uploadSessions)
          .set({ state: 'QUARANTINED', updatedAt: atIso })
          .where(eq(uploadSessions.id, input.sessionId));
        await tx
          .update(artifacts)
          .set({ scanStatus: 'infected', updatedAt: atIso })
          .where(eq(artifacts.id, input.artifactId));
        return;
      }
      await tx
        .update(uploadSessions)
        .set({ state: 'SCANNING', updatedAt: atIso })
        .where(eq(uploadSessions.id, input.sessionId));
      await tx
        .update(artifacts)
        .set({
          scanStatus: input.verdict === 'skipped' ? 'skipped' : 'clean',
          updatedAt: atIso,
        })
        .where(eq(artifacts.id, input.artifactId));
    });
  }

  async markExtracting(sessionId: string, at: Date): Promise<void> {
    const atIso = at.toISOString();
    await this.db.withBypass(async (tx) => {
      await tx
        .update(uploadSessions)
        .set({ state: 'EXTRACTING', updatedAt: atIso, lastError: null })
        .where(eq(uploadSessions.id, sessionId));
    });
  }

  async markFailed(input: {
    sessionId: string;
    artifactId: string;
    error: string;
    at: Date;
  }): Promise<void> {
    const atIso = input.at.toISOString();
    await this.db.withBypass(async (tx) => {
      await tx
        .update(uploadSessions)
        .set({ state: 'FAILED', lastError: input.error, updatedAt: atIso })
        .where(eq(uploadSessions.id, input.sessionId));
      // The document match is keyed on the artifact id, NOT the session's
      // document: a re-ingested session has no single document row, and
      // matching by session would leave orphaned `processing` documents.
      // Version sessions (new artifact) deliberately miss here — the prior
      // version keeps serving in its prior state.
      await tx
        .update(documents)
        .set({ state: 'failed', updatedAt: atIso })
        .where(eq(documents.sourceArtifactId, input.artifactId));
    });
  }

  async markReady(sessionId: string, at: Date): Promise<void> {
    const atIso = at.toISOString();
    await this.db.withBypass(async (tx) => {
      await tx
        .update(uploadSessions)
        .set({ state: 'READY', updatedAt: atIso })
        .where(eq(uploadSessions.id, sessionId));
    });
  }

  async createWithArtifact(
    orgId: string,
    artifact: NewArtifact,
    session: NewUploadSession,
  ): Promise<{ artifact: Artifact; session: UploadSession }> {
    return this.db.withOrg(orgId, async (tx) => {
      const artifactRows = await tx.insert(artifacts).values(artifact).returning();
      const sessionRows = await tx
        .insert(uploadSessions)
        .values({ ...session, artifactId: artifactRows[0].id })
        .returning();
      return { artifact: artifactRows[0], session: sessionRows[0] };
    });
  }

  async getSessionWithArtifact(
    orgId: string,
    sessionId: string,
  ): Promise<{ session: UploadSession; artifact: Artifact } | null> {
    return this.db.withOrg(orgId, async (tx) => {
      const sessionRows = await tx
        .select()
        .from(uploadSessions)
        .where(eq(uploadSessions.id, sessionId))
        .limit(1);
      if (sessionRows.length === 0) {
        return null;
      }
      const artifactRows = await tx
        .select()
        .from(artifacts)
        .where(eq(artifacts.id, sessionRows[0].artifactId))
        .limit(1);
      // The FK guarantees this; a missing artifact is data corruption, not
      // "not found" — fail loud exactly as the old code did (internal).
      if (artifactRows.length === 0) {
        throw ApiError.internal();
      }
      return { session: sessionRows[0], artifact: artifactRows[0] };
    });
  }

  async claimUploaded(
    orgId: string,
    sessionId: string,
    detectedContentType: string,
  ): Promise<UploadSession | null> {
    return this.db.withOrg(orgId, async (tx) => {
      const updated = await tx
        .update(uploadSessions)
        .set({ state: 'UPLOADED', updatedAt: new Date().toISOString() })
        .where(and(eq(uploadSessions.id, sessionId), eq(uploadSessions.state, 'CREATED')))
        .returning();
      if (updated.length === 0) {
        return null;
      }
      await tx
        .update(artifacts)
        .set({ contentTypeDetected: detectedContentType, updatedAt: new Date().toISOString() })
        .where(eq(artifacts.id, updated[0].artifactId));
      return updated[0];
    });
  }

  async getArtifactForExtraction(artifactId: string): Promise<{
    objectKey: string;
    contentTypeDetected: string | null;
    contentTypeDeclared: string;
  } | null> {
    return this.db.withBypass(async (tx) => {
      const rows = await tx.execute(sql`
        select object_key, content_type_detected, content_type_declared
        from artifacts
        where id = ${artifactId}::uuid
        limit 1
      `);
      const r = rows.rows[0] as
        | { object_key: string; content_type_detected: string | null; content_type_declared: string }
        | undefined;
      if (!r) {
        return null;
      }
      return {
        objectKey: r.object_key,
        contentTypeDetected: r.content_type_detected,
        contentTypeDeclared: r.content_type_declared,
      };
    });
  }
}
