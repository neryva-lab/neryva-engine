/**
 * MongoDB lane for `IChannelTemplateRepository` (P3).
 *
 * Plan D4: UUIDs as BSON Binary subtype 4, pg snake_case field names,
 * ISO-8601 timestamp strings, jsonb columns as subdocuments/arrays. Every
 * method is one `withOrg` unit.
 *
 * The (channel_account_id, name, language) duplicate-key maps to the same
 * client-facing conflict the pg lane raises from its
 * onConflictDoNothing().returning() empty set.
 */
import type { Db } from 'mongodb';
import { ApiError } from '../../../common/http/api-error';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { uuidv7 } from '../../../common/ids/uuidv7';
import type { ChannelMessageTemplate } from '../schema';
import type { IChannelTemplateRepository } from './channel-template.repository';
import {
  binUuid,
  channelCollections,
  isDuplicateKey,
  toChannelMessageTemplate,
} from './mongo-documents';

export class MongoChannelTemplateRepository implements IChannelTemplateRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private tx(db: Db, ctx: MongoTxContext) {
    return { session: { session: ctx.session }, ...channelCollections(db) };
  }

  async createTemplate(input: {
    orgId: string;
    accountId: string;
    name: string;
    language: string;
    bodyText: string;
    variables: string[];
    providerTemplateId: string | null;
    createdBy: string;
  }): Promise<ChannelMessageTemplate> {
    const db = this.mongo.root;
    const now = new Date().toISOString();
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const account = await t.accounts.findOne(
        input.orgId,
        { id: binUuid(input.accountId, 'accountId') },
        t.session,
      );
      if (!account) throw ApiError.notFound('channel account');
      const doc = {
        id: binUuid(uuidv7()),
        organization_id: binUuid(input.orgId, 'orgId'),
        channel_account_id: binUuid(input.accountId, 'accountId'),
        platform: account.platform,
        name: input.name,
        language: input.language,
        body_text: input.bodyText,
        variables: input.variables,
        provider_template_id: input.providerTemplateId,
        status: 'draft',
        created_by: input.createdBy,
        created_at: now,
        updated_at: now,
      };
      try {
        await t.templates.insertOne(input.orgId, doc, t.session);
      } catch (err) {
        if (isDuplicateKey(err)) {
          throw ApiError.conflict('template with this name+language exists for the account');
        }
        throw err;
      }
      return toChannelMessageTemplate({ ...doc, _id: undefined as never });
    });
  }

  async listTemplates(orgId: string, accountId?: string): Promise<ChannelMessageTemplate[]> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const docs = await t.templates
        .find(
          orgId,
          {
            ...(accountId ? { channel_account_id: binUuid(accountId, 'accountId') } : {}),
          },
          t.session,
        )
        .sort({ updated_at: -1 })
        .limit(100)
        .toArray();
      return docs.map(toChannelMessageTemplate);
    });
  }

  async setTemplateStatus(
    orgId: string,
    templateId: string,
    status: 'draft' | 'approved' | 'rejected' | 'archived',
  ): Promise<ChannelMessageTemplate> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const doc = await t.templates.findOneAndUpdate(
        orgId,
        { id: binUuid(templateId, 'templateId') },
        { $set: { status, updated_at: new Date().toISOString() } },
        { ...t.session, returnDocument: 'after' },
      );
      if (!doc) throw ApiError.notFound('template');
      return toChannelMessageTemplate(doc);
    });
  }
}
