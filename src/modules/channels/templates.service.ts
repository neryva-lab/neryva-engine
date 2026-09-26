import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import type { ChannelMessageTemplate } from './schema';
import { CHANNEL_TEMPLATE_REPOSITORY } from './repositories/repository-tokens';
import type { IChannelTemplateRepository } from './repositories/channel-template.repository';

/**
 * FL-3.18 — outbound template management (WhatsApp class). Templates are
 * per channel account: body text + ordered variable descriptors + the
 * provider-side template id (Meta approval flows happen in the provider
 * console; Engine tracks the reflected status). Interactive payloads
 * (buttons/lists) are message-content parts at send time, not templates.
 *
 * Persistence goes through `IChannelTemplateRepository` (provider-blind P3
 * port). This service holds no provider, Drizzle, or SQL references.
 */
@Injectable()
export class ChannelTemplatesService {
  constructor(
    @Inject(CHANNEL_TEMPLATE_REPOSITORY) private readonly templates: IChannelTemplateRepository,
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
    const row = await this.templates.createTemplate({
      orgId: input.orgId,
      accountId: input.accountId,
      name,
      language: input.language.trim().slice(0, 16) || 'en',
      bodyText,
      variables: (input.variables ?? []).map((v) => v.slice(0, 64)),
      providerTemplateId: input.providerTemplateId?.slice(0, 255) ?? null,
      createdBy: input.actor.slice(0, 128),
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
    if (accountId) {
      assertUuid(accountId, 'accountId');
    }
    return this.templates.listTemplates(orgId, accountId);
  }

  async setStatus(input: { orgId: string; templateId: string; status: 'draft' | 'approved' | 'rejected' | 'archived'; actor: string }): Promise<ChannelMessageTemplate> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.templateId, 'templateId');
    const row = await this.templates.setTemplateStatus(input.orgId, input.templateId, input.status);
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
