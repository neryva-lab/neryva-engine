/**
 * MongoDB lane for `IContactInboxRepository` (P3).
 *
 * Plan D4: UUIDs as BSON Binary subtype 4, pg snake_case field names,
 * ISO-8601 timestamp strings. Corporate tables are global (non-tenant) —
 * every method is one `withBypass` unit with plain collection handles.
 *
 * The staff list's LIKE/ILIKE filters become case-insensitive regexes
 * (with `%`/`_` wildcards stripped, as the pg lane does).
 */
import type { Db } from 'mongodb';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { uuidv7 } from '../../../common/ids/uuidv7';
import type {
  ContactSubmissionRow,
  IContactInboxRepository,
  IntakeContactSubmissionInput,
  ListSubmissionsFilter,
  TransitionSubmissionInput,
} from './contact-inbox.repository';
import { binUuid, corporateCollections, toContactSubmission } from './mongo-documents';

export class MongoContactInboxRepository implements IContactInboxRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private tx(db: Db, ctx: MongoTxContext) {
    return { session: { session: ctx.session }, ...corporateCollections(db) };
  }

  async insertSubmission(input: IntakeContactSubmissionInput): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      await t.contactSubmissions.insertOne(
        {
          id: binUuid(uuidv7()),
          name: input.name,
          email: input.email,
          company: input.company,
          message: input.message,
          request_ip: input.requestIp,
          status: 'new',
          notes: null,
          replied_at: null,
          opt_in_updates: input.optInUpdates,
          created_at: new Date().toISOString(),
        },
        t.session,
      );
    });
  }

  async listSubmissions(filter: ListSubmissionsFilter): Promise<{ submissions: Record<string, unknown>[]; total: number; limit: number; offset: number }> {
    const db = this.mongo.root;
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const offset = Math.max(filter.offset ?? 0, 0);
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const match: Record<string, unknown> = {};
      if (filter.status) {
        match['status'] = filter.status;
      }
      if (filter.q) {
        // The pg lane strips %/_ then wraps in %...%: substring match.
        // ILIKE on name/company, LIKE (case-sensitive) on email.
        const raw = filter.q.replace(/[%_]/g, '');
        const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        match['$or'] = [
          { email: { $regex: escaped } },
          { name: { $regex: escaped, $options: 'i' } },
          { company: { $regex: escaped, $options: 'i' } },
        ];
      }
      const total = await t.contactSubmissions.countDocuments(match, t.session);
      const docs = await t.contactSubmissions
        .find(match, t.session)
        .sort({ created_at: -1 })
        .skip(offset)
        .limit(limit)
        .toArray();
      const submissions = docs.map((d) => ({
        id: d.id.toUUID().toString(),
        name: d.name,
        email: d.email,
        company: d.company,
        message: d.message,
        status: d.status,
        notes: d.notes,
        replied_at: d.replied_at,
        opt_in_updates: d.opt_in_updates,
        created_at: d.created_at,
      }));
      return { submissions, total, limit, offset };
    });
  }

  async getSubmissionById(submissionId: string): Promise<ContactSubmissionRow | null> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const doc = await t.contactSubmissions.findOne({ id: binUuid(submissionId, 'submissionId') }, t.session);
      return doc ? toContactSubmission(doc) : null;
    });
  }

  async transitionSubmission(input: TransitionSubmissionInput): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const update: Record<string, unknown> = { status: input.target };
      if (input.notes !== undefined) {
        update['notes'] = input.notes.slice(0, 8000);
      }
      if (input.markReplied) {
        update['replied_at'] = new Date().toISOString();
      }
      await t.contactSubmissions.updateOne(
        { id: binUuid(input.submissionId, 'submissionId') },
        { $set: update },
        t.session,
      );
    });
  }
}
