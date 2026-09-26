import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { pgViolation } from '../../../common/infra/db/pg-types';
import { chunks, documents, documentVersions } from '../schema';
import type {
  DocumentInventoryRow,
  DocumentPreview,
  DocumentVersionTarget,
} from './repository-types';
import type { IDocumentRepository } from './document.repository';

/**
 * PostgreSQL implementation of `IDocumentRepository` (P3).
 *
 * Mechanical move of the `documents` management SQL from
 * `ArtifactsService` (inventory, slug rename, retirement, gated preview)
 * and the version-target/slug-clash reads from `createUploadSession`. Each
 * method owns its transaction; no transaction handle leaks.
 *
 * The ACL fragment in `readPreview` is built INLINE (byte-identical to the
 * canonical `buildSourceAclFilter` in `retrieval.service.ts`, which stays
 * there with its unit test — referenced here, never imported, per the
 * interface).
 *
 * Known race, preserved — NOT fixed: `renameSourceSlug`'s clash check has
 * no `FOR UPDATE`, so two concurrent renames to the same slug can both
 * pass the check and one loses to the unique constraint. The 23505 from
 * the update propagates; the service maps it to the `slug_taken` outcome.
 *
 * INTERFACE DEFECT (reported 2026-09-26, not silently altered):
 * `DocumentPreviewChunk` carries `{sequence, text}` only — the
 * `source_range` the current public preview returns on each chunk has no
 * field. The service's public `getDocumentPreview` response will therefore
 * lose `source_range` on chunks unless the interface is amended.
 *
 * What stays OUT (still the service's job): slug derivation/validation
 * (`source-slug.ts`), chunk-limit clamping, audit writes.
 */
export class PgDocumentRepository implements IDocumentRepository {
  constructor(private readonly db: DbService) {}

  async findVersionTarget(orgId: string, documentId: string): Promise<DocumentVersionTarget | null> {
    return this.db.withOrg(orgId, async (tx) => {
      const rows = await tx
        .select({ id: documents.id, state: documents.state })
        .from(documents)
        .where(and(eq(documents.id, documentId), eq(documents.organizationId, orgId)))
        .limit(1);
      return rows[0] ?? null;
    });
  }

  async isSourceSlugTaken(orgId: string, slug: string): Promise<boolean> {
    return this.db.withOrg(orgId, async (tx) => {
      const rows = await tx
        .select({ id: documents.id })
        .from(documents)
        .where(and(eq(documents.organizationId, orgId), eq(documents.sourceSlug, slug)))
        .limit(1);
      return rows.length > 0;
    });
  }

  async listInventory(orgId: string, limit: number): Promise<DocumentInventoryRow[]> {
    return this.db.withOrg(orgId, async (tx) => {
      const rows = await tx.execute(sql`
        select d.id, d.source_slug, d.title, d.state, d.updated_at,
               (select max(dv.version) from document_versions dv where dv.document_id = d.id) as latest_version
        from documents d
        where d.organization_id = ${orgId}::uuid
        order by d.updated_at desc
        limit ${limit}
      `);
      return (rows.rows as Array<Record<string, unknown>>).map((r) => ({
        id: String(r.id),
        source_slug: String(r.source_slug),
        title: r.title == null ? null : String(r.title),
        state: String(r.state),
        updated_at: String(r.updated_at),
        // The raw max() is NULL when the document has no version yet; the
        // wire shape documents 0 for that case.
        latest_version: r.latest_version == null ? 0 : Number(r.latest_version),
      }));
    });
  }

  async renameSourceSlug(
    orgId: string,
    documentId: string,
    slug: string,
  ): Promise<'renamed' | 'unchanged' | 'not_found' | 'slug_taken'> {
    return this.db.withOrg(orgId, async (tx) => {
      const rows = await tx
        .select({ id: documents.id, sourceSlug: documents.sourceSlug })
        .from(documents)
        .where(and(eq(documents.id, documentId), eq(documents.organizationId, orgId)))
        .limit(1);
      if (!rows[0]) {
        return 'not_found';
      }
      if (rows[0].sourceSlug === slug) {
        return 'unchanged';
      }
      const clash = await tx
        .select({ id: documents.id })
        .from(documents)
        .where(and(eq(documents.organizationId, orgId), eq(documents.sourceSlug, slug)))
        .limit(1);
      if (clash.length > 0) {
        return 'slug_taken';
      }
      // Known race (documented above): no FOR UPDATE on the clash check, so
      // a concurrent rename can win the unique constraint between the check
      // and this update. The 23505 propagates; the service maps it to
      // `slug_taken`.
      try {
        await tx
          .update(documents)
          .set({ sourceSlug: slug, updatedAt: new Date().toISOString() })
          .where(eq(documents.id, documentId));
      } catch (err) {
        if (pgViolation(err).code === '23505') {
          return 'slug_taken';
        }
        throw err;
      }
      return 'renamed';
    });
  }

  async retire(orgId: string, documentId: string): Promise<'retired' | 'already_retired' | 'not_found'> {
    return this.db.withOrg(orgId, async (tx) => {
      const rows = await tx
        .select({ id: documents.id, state: documents.state })
        .from(documents)
        .where(and(eq(documents.id, documentId), eq(documents.organizationId, orgId)))
        .limit(1);
      const doc = rows[0];
      if (!doc) {
        return 'not_found';
      }
      if (doc.state === 'retired') {
        return 'already_retired';
      }
      await tx
        .update(documents)
        .set({ state: 'retired', updatedAt: new Date().toISOString() })
        .where(eq(documents.id, documentId));
      return 'retired';
    });
  }

  async readPreview(input: {
    orgId: string;
    documentId: string;
    accountId: string | null;
    callerEmails: string[];
    chunkLimit: number;
  }): Promise<DocumentPreview | null> {
    // Inline ACL fragment — byte-identical to the canonical
    // `buildSourceAclFilter` in retrieval.service.ts (which owns the unit
    // test). Referenced here, never imported, per the interface.
    const restricted = sql`exists (select 1 from document_source_acls s where s.document_id = d.id)`;
    const emailList = input.callerEmails.map((e) => e.trim().toLowerCase()).filter((e) => e.length > 0);
    const sourceAclFilter =
      input.accountId === null && emailList.length === 0
        ? sql`and (not ${restricted})`
        : sql`and ((not ${restricted}) or (exists (
    select 1 from document_source_acls s
    where s.document_id = d.id
      and (
        (${
          input.accountId === null
            ? sql`false`
            : sql`exists (
          select 1 from external_identity_links l
          where l.organization_id = ${input.orgId}::uuid
            and l.provider = s.provider
            and l.external_id = s.external_id
            and l.account_id = ${input.accountId}::uuid
        )`
        })
        or (${
          emailList.length === 0
            ? sql`false`
            : sql`exists (
          select 1 from external_principals p
          where p.organization_id = ${input.orgId}::uuid
            and p.provider = s.provider
            and p.external_id = s.external_id
            and lower(p.email) in (${sql.join(
              emailList.map((e) => sql`${e}`),
              sql`, `,
            )})
        )`
        })
      )
  )))`;

    return this.db.withOrg(input.orgId, async (tx) => {
      // A4-12 gate — byte-identical shape to retrieval's aclPredicate:
      // authorization before any chunk text is touched. A document failing
      // any gate is unreachable here exactly as it is unreachable by
      // retrieval — null (the service maps to 404, not 403, so the
      // existence of a non-visible document is never disclosed).
      const gated = await tx.execute(sql`
        select 1
        from documents d
        join artifacts a on a.id = d.source_artifact_id
        left join retrieval_acl acl
          on acl.organization_id = d.organization_id
          and acl.resource_type = 'document'
          and acl.resource_id = d.id
        where d.id = ${input.documentId}::uuid
          and d.organization_id = ${input.orgId}::uuid
          and d.state = 'ready'
          and a.state = 'active'
          and (a.scan_status in ('clean', 'skipped'))
          and (a.expires_at is null or a.expires_at > now())
          and (acl.visibility = 'organization' or (acl.visibility = 'private' and acl.scope_account_id = ${input.accountId}::uuid))
          ${sourceAclFilter}
        limit 1
      `);
      if (gated.rows.length === 0) {
        return null;
      }
      const docs = await tx
        .select({ id: documents.id, sourceSlug: documents.sourceSlug, title: documents.title, state: documents.state })
        .from(documents)
        .where(and(eq(documents.id, input.documentId), eq(documents.organizationId, input.orgId)))
        .limit(1);
      const doc = docs[0];
      if (!doc) {
        return null;
      }
      const versions = await tx
        .select({ id: documentVersions.id, version: documentVersions.version })
        .from(documentVersions)
        .where(and(eq(documentVersions.documentId, doc.id), eq(documentVersions.organizationId, input.orgId)))
        .orderBy(desc(documentVersions.version))
        .limit(1);
      const version = versions[0] ?? null;
      // A 'ready' document always has a version (READY is published after
      // INDEXING mints one); a missing version is treated as not found.
      if (!version) {
        return null;
      }
      const counted = await tx.execute(
        sql`select count(*)::int as n from chunks where document_version_id = ${version.id}::uuid and organization_id = ${input.orgId}::uuid`,
      );
      const chunkCount = Number((counted.rows[0] as { n: number } | undefined)?.n ?? 0);
      const rows = await tx
        .select({ sequence: chunks.sequence, text: chunks.text, sourceRange: chunks.sourceRange })
        .from(chunks)
        .where(and(eq(chunks.documentVersionId, version.id), eq(chunks.organizationId, input.orgId)))
        .orderBy(asc(chunks.sequence))
        .limit(input.chunkLimit);
      return {
        id: doc.id,
        title: doc.title,
        state: doc.state,
        source_slug: doc.sourceSlug,
        version: version.version,
        chunkCount,
        chunks: rows.map((r) => ({
          sequence: r.sequence,
          text: r.text,
          sourceRange: (r.sourceRange ?? null) as { byteStart: number; byteEnd: number } | null,
        })),
      };
    });
  }
}
