/**
 * PostgreSQL channel-template repository (P3) — `channel_message_templates`.
 * Mechanical move of `ChannelTemplatesService`'s persistence (create with the
 * account-scope check + unique (account, name, language) guard, list, status
 * set). Validation stays in the service — this port owns only the queries.
 */
import { and, desc, eq } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { ApiError } from '../../../common/http/api-error';
import { uuidv7 } from '../../../common/ids/uuidv7';
import {
  channelAccounts,
  channelMessageTemplates,
  type ChannelMessageTemplate,
} from '../schema';
import type { IChannelTemplateRepository } from './channel-template.repository';

export class PgChannelTemplateRepository implements IChannelTemplateRepository {
  constructor(private readonly db: DbService) {}

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
    return this.db.withOrg(input.orgId, async (tx) => {
      const account = await tx
        .select({ id: channelAccounts.id, platform: channelAccounts.platform })
        .from(channelAccounts)
        .where(
          and(
            eq(channelAccounts.id, input.accountId),
            eq(channelAccounts.organizationId, input.orgId),
          ),
        )
        .limit(1);
      if (account.length === 0) {
        throw ApiError.notFound('channel account');
      }
      const rows = await tx
        .insert(channelMessageTemplates)
        .values({
          id: uuidv7(),
          organizationId: input.orgId,
          channelAccountId: input.accountId,
          platform: account[0].platform,
          name: input.name,
          language: input.language,
          bodyText: input.bodyText,
          variables: input.variables,
          providerTemplateId: input.providerTemplateId,
          createdBy: input.createdBy,
        })
        .onConflictDoNothing()
        .returning();
      if (rows.length === 0) {
        throw ApiError.conflict('template with this name+language exists for the account');
      }
      return rows[0];
    });
  }

  async listTemplates(orgId: string, accountId?: string): Promise<ChannelMessageTemplate[]> {
    const conditions = [eq(channelMessageTemplates.organizationId, orgId)];
    if (accountId) {
      conditions.push(eq(channelMessageTemplates.channelAccountId, accountId));
    }
    return this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(channelMessageTemplates)
        .where(and(...conditions))
        .orderBy(desc(channelMessageTemplates.updatedAt))
        .limit(100),
    );
  }

  async setTemplateStatus(
    orgId: string,
    templateId: string,
    status: 'draft' | 'approved' | 'rejected' | 'archived',
  ): Promise<ChannelMessageTemplate> {
    return this.db.withOrg(orgId, async (tx) => {
      const rows = await tx
        .update(channelMessageTemplates)
        .set({ status, updatedAt: new Date().toISOString() })
        .where(
          and(
            eq(channelMessageTemplates.id, templateId),
            eq(channelMessageTemplates.organizationId, orgId),
          ),
        )
        .returning();
      if (rows.length === 0) {
        throw ApiError.notFound('template');
      }
      return rows[0];
    });
  }
}
