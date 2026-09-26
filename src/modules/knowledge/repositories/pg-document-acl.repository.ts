import { and, desc, eq } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { accounts } from '../../identity/schema';
import { documents, documentSourceAcls, documentVersions, externalIdentityLinks, externalPrincipals, retrievalAcl, uploadSessions } from '../schema';
import type { IDocumentAclRepository } from './document-acl.repository';

/**
 * PostgreSQL implementation of `IDocumentAclRepository` (P3).
 *
 * Mechanical move of the `KnowledgeIngestionWorker.readyStage` document/ACL
 * SQL — INCLUDING the session→READY flip as the FIRST statement of the
 * transaction, restoring the legacy READY-stage transaction boundary (a
 * later failure rolls the flip back atomically): one
 * `DbService.withBypass` transaction. No transaction handle leaks.
 * (`markReady` remains `IUploadSessionRepository`'s separate API, exercised
 * by parity tests independently.)
 *
 * Best-effort semantics are preserved INSIDE the transaction (a principal
 * row that fails to upsert aborts the whole stage — fail-closed, never
 * half-published); no failure is swallowed, the repository throws and the
 * worker retries.
 *
 * What stays OUT (still the worker's job, precomputed before the call):
 * - the org knowledge config (the `embeddingModel` arrives resolved)
 * - `sourceAcl` intent parsing (mode/principals arrive structured)
 * - the connector provider string (`connectorProvider` arrives resolved)
 * - the version-append audit (the worker audits AFTER the repo returns,
 *   using `latestVersion`).
 */
export class PgDocumentAclRepository implements IDocumentAclRepository {
  constructor(private readonly db: DbService) {}

  async publishDocumentReady(input: {
    orgId: string;
    sessionId: string;
    artifactId: string;
    targetDocumentId: string | null;
    embeddingModel: string;
    sourceAcl: {
      mode: 'open' | 'restricted';
      principals: Array<{ kind: string; id: string; email?: string }>;
    } | null;
    connectorProvider: string;
    at: Date;
  }): Promise<{ documentId: string | null }> {
    const orgId = input.orgId;
    const atIso = input.at.toISOString();
    return this.db.withBypass(async (tx) => {
      // READY-stage transaction boundary: the session flips to READY as the
      // FIRST statement of this transaction (restores the legacy worker's
      // boundary — `readyStage` updated the session before touching
      // documents); a later failure rolls the flip back atomically.
      await tx
        .update(uploadSessions)
        .set({ state: 'READY', updatedAt: atIso })
        .where(eq(uploadSessions.id, input.sessionId));
      // A4-11: version sessions attach to the re-ingestion target (the
      // session's artifact is new, so a sourceArtifactId match misses);
      // first ingests match on the source artifact as before.
      const docCond =
        input.targetDocumentId != null
          ? eq(documents.id, input.targetDocumentId)
          : eq(documents.sourceArtifactId, input.artifactId);
      await tx
        .update(documents)
        .set({ state: 'ready', embeddingModel: input.embeddingModel, updatedAt: atIso })
        .where(docCond);
      // Default ACL: documents are organization-visible at ingest
      // (retrieval.service's contract). Without this row the retrieval join
      // excludes the document entirely — it would be indexed but unreachable.
      const docRows = await tx.select({ id: documents.id }).from(documents).where(docCond).limit(1);
      const documentId = docRows[0]?.id ?? null;
      if (documentId) {
        await tx
          .insert(retrievalAcl)
          .values({
            id: uuidv7(),
            organizationId: orgId,
            resourceType: 'document',
            resourceId: documentId,
            visibility: 'organization',
            scopeAccountId: null,
          })
          .onConflictDoNothing();
        // P0-1: source permission verdicts land here (replacing any prior
        // set — sync is the authority on source truth). Open mode clears
        // restrictions (permissions widened at the source).
        await this.applySourceAcl(tx, orgId, input, documentId);
      }
      return { documentId };
    });
  }

  private async applySourceAcl(
    tx: Parameters<Parameters<DbService['withBypass']>[0]>[0],
    orgId: string,
    input: {
      sourceAcl: {
        mode: 'open' | 'restricted';
        principals: Array<{ kind: string; id: string; email?: string }>;
      } | null;
      connectorProvider: string;
    },
    documentId: string,
  ): Promise<void> {
    const intent = input.sourceAcl;
    const provider = input.connectorProvider;
    if (!intent || intent.mode !== 'restricted') {
      if (intent && intent.mode === 'open') {
        await tx.delete(documentSourceAcls).where(eq(documentSourceAcls.documentId, documentId));
      }
      return;
    }
    const clean = intent.principals
      .filter((p): p is { kind: string; id: string; email?: string } => {
        return (
          (p.kind === 'user' || p.kind === 'group' || p.kind === 'domain') &&
          typeof p.id === 'string' &&
          p.id.length > 0
        );
      })
      .slice(0, 500);
    for (const p of clean) {
      const email =
        typeof p.email === 'string' && p.email.includes('@') ? p.email.toLowerCase().slice(0, 320) : null;
      await tx
        .insert(externalPrincipals)
        .values({
          id: uuidv7(),
          organizationId: orgId,
          provider,
          externalId: p.id.slice(0, 512),
          kind: p.kind,
          email,
          display: null,
        })
        .onConflictDoUpdate({
          target: [externalPrincipals.organizationId, externalPrincipals.provider, externalPrincipals.externalId],
          set: { kind: p.kind, email, updatedAt: new Date().toISOString() },
        });
      // Auto-link on verified-email equality (the common case) so account
      // matching works without manual mapping. No link = default-deny.
      if (email) {
        const owners = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.email, email)).limit(1);
        if (owners[0]) {
          await tx
            .insert(externalIdentityLinks)
            .values({
              id: uuidv7(),
              organizationId: orgId,
              provider,
              externalId: p.id.slice(0, 512),
              accountId: owners[0].id,
            })
            .onConflictDoNothing({
              target: [externalIdentityLinks.organizationId, externalIdentityLinks.provider, externalIdentityLinks.externalId],
            });
        }
      }
    }
    await tx.delete(documentSourceAcls).where(eq(documentSourceAcls.documentId, documentId));
    for (const p of clean) {
      await tx
        .insert(documentSourceAcls)
        .values({
          id: uuidv7(),
          organizationId: orgId,
          documentId,
          provider,
          externalId: p.id.slice(0, 512),
        })
        .onConflictDoNothing({
          target: [documentSourceAcls.documentId, documentSourceAcls.provider, documentSourceAcls.externalId],
        });
    }
  }

  async latestVersion(orgId: string, documentId: string): Promise<number | null> {
    return this.db.withOrg(orgId, async (tx) => {
      // Tenant-isolated: orgB cannot see orgA's versions (the interface
      // requires cross-org invisibility on every port).
      const rows = await tx
        .select({ version: documentVersions.version })
        .from(documentVersions)
        .where(
          and(
            eq(documentVersions.documentId, documentId),
            eq(documentVersions.organizationId, orgId),
          ),
        )
        .orderBy(desc(documentVersions.version))
        .limit(1);
      return rows[0]?.version ?? null;
    });
  }
}
