import { and, desc, eq } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { uuidv7 } from '../../common/ids/uuidv7';
import { channelAccounts, channelMessageTemplates, ChannelMessageTemplate } from './schema';

/**
 * FL-3.18 — outbound template management (WhatsApp class). Templates are
 * per channel account: body text + ordered variable descriptors + the
 * provider-side template id (Meta approval flows happen in the provider
 * console; Engine tracks the reflected status). Interactive payloads
 * (buttons/lists) are message-content parts at send time, not templates.
 */
@Injectable()
export class ChannelTemplatesService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  async create(input: {
    orgId: string;
    accountId: string;
    name: string;
    language: string;
    bodyText: string;
    variables?: string[];
    providerTemplateId?: string;
    actor: string;
  }): Promise<ChannelMessageTemplate> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.accountId, 'accountId');
    const name = input.name.trim();
    if (!/^[a-z0-9_]{1,128}$/.test(name)) {
      throw ApiError.validation({ name: 'must match ^[a-z0-9_]{1,128}$' });
    }
    const bodyText = input.bodyText.trim();
    if (bodyText.length === 0 || bodyText.length > 4096) {
      throw ApiError.validation({ body_text: 'must be 1..4096 chars' });
    }
    if (input.variables && input.variables.length > 10) {
      throw ApiError.validation({ variables: 'max 10 variables' });
    }
    const row = await this.db.withOrg(input.orgId, async (tx) => {
      const account = await tx
        .select({ id: channelAccounts.id, platform: channelAccounts.platform })
        .from(channelAccounts)
        .where(and(eq(channelAccounts.id, input.accountId), eq(channelAccounts.organizationId, input.orgId)))
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
          name,
          language: input.language.trim().slice(0, 16) || 'en',
          bodyText,
          variables: (input.variables ?? []).map((v) => v.slice(0, 64)),
          providerTemplateId: input.providerTemplateId?.slice(0, 255) ?? null,
          createdBy: input.actor.slice(0, 128),
        })
        .onConflictDoNothing()
        .returning();
      if (rows.length === 0) {
        throw ApiError.conflict('template with this name+language exists for the account');
      }
      return rows[0];
    });
    await this.audit.add({
      action: 'channel_template.created',
      resourceType: 'channel_message_template',
      resourceId: row.id,
      actorType: 'account',
      actorId: input.actor,
      tenantId: input.orgId,
      details: { account_id: input.accountId, name },
    });
    return row;
  }

  async list(orgId: string, accountId?: string): Promise<ChannelMessageTemplate[]> {
    assertUuid(orgId, 'orgId');
    const conditions = [eq(channelMessageTemplates.organizationId, orgId)];
    if (accountId) {
      assertUuid(accountId, 'accountId');
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

  async setStatus(input: { orgId: string; templateId: string; status: 'draft' | 'approved' | 'rejected' | 'archived'; actor: string }): Promise<ChannelMessageTemplate> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.templateId, 'templateId');
    const row = await this.db.withOrg(input.orgId, async (tx) => {
      const rows = await tx
        .update(channelMessageTemplates)
        .set({ status: input.status, updatedAt: new Date().toISOString() })
        .where(and(eq(channelMessageTemplates.id, input.templateId), eq(channelMessageTemplates.organizationId, input.orgId)))
        .returning();
      if (rows.length === 0) {
        throw ApiError.notFound('template');
      }
      return rows[0];
    });
    await this.audit.add({
      action: 'channel_template.status_set',
      resourceType: 'channel_message_template',
      resourceId: input.templateId,
      actorType: 'account',
      actorId: input.actor,
      tenantId: input.orgId,
      details: { status: input.status },
    });
    return row;
  }
}


function assertUuid(id: string, field: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw ApiError.validation({ [field]: 'must be a uuid' });
  }
}
