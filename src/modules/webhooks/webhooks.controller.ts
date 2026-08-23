import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AuthLayer, CurrentPrincipal } from '../../common/auth/decorators';
import { L1Principal } from '../../common/auth/principal';
import { ApiError } from '../../common/http/api-error';
import { Idempotent } from '../../common/http/idempotency';
import { RateLimit } from '../../common/http/rate-limit';
import { OrgRolesGuard, Roles } from '../../common/policy/org-roles.guard';
import { WebhooksService } from './webhooks.service';

/**
 * Webhook management (the console surface behind the studio nav's
 * "webhooks" page — org furniture, any product's customers can use it):
 * L1 + membership; manage roles create/update/delete, all roles view.
 */
@Controller('console/org/:orgId/webhooks')
@AuthLayer('l1')
@UseGuards(OrgRolesGuard)
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Get()
  @Roles('owner', 'admin', 'billing', 'developer', 'reader')
  async list(@Param('orgId') orgId: string) {
    return { webhooks: await this.webhooks.list(orgId) };
  }

  @Post()
  @Roles('owner', 'admin', 'developer')
  @Idempotent()
  @RateLimit({ name: 'webhook-create', capacity: 10, refillPerSecond: 0.05, scope: 'principal' })
  async create(
    @Param('orgId') orgId: string,
    @Body() body: { url?: string; events?: string[]; description?: string },
    @CurrentPrincipal() principal: L1Principal,
  ) {
    if (!body.url || !Array.isArray(body.events)) {
      throw ApiError.validation({ url: 'required', events: 'array of event types required' });
    }
    const created = await this.webhooks.create({ orgId, url: body.url, events: body.events, description: body.description, actorId: principal.id });
    return { webhook: created.webhook, secret: created.secret }; // secret shown exactly once
  }

  @Post(':webhookId')
  @Roles('owner', 'admin', 'developer')
  async update(
    @Param('orgId') orgId: string,
    @Param('webhookId') webhookId: string,
    @Body() body: { url?: string; events?: string[]; description?: string; status?: 'active' | 'disabled' },
    @CurrentPrincipal() principal: L1Principal,
  ) {
    return { webhook: await this.webhooks.update({ orgId, webhookId, ...body, actorId: principal.id }) };
  }

  @Delete(':webhookId')
  @Roles('owner', 'admin', 'developer')
  async remove(@Param('orgId') orgId: string, @Param('webhookId') webhookId: string, @CurrentPrincipal() principal: L1Principal): Promise<{ ok: true }> {
    await this.webhooks.remove({ orgId, webhookId, actorId: principal.id });
    return { ok: true };
  }

  @Post(':webhookId/rotate-secret')
  @Roles('owner', 'admin', 'developer')
  async rotateSecret(@Param('orgId') orgId: string, @Param('webhookId') webhookId: string, @CurrentPrincipal() principal: L1Principal) {
    return this.webhooks.rotateSecret({ orgId, webhookId, actorId: principal.id }); // secret shown exactly once
  }

  @Post(':webhookId/test')
  @Roles('owner', 'admin', 'developer')
  @RateLimit({ name: 'webhook-test', capacity: 10, refillPerSecond: 0.1, scope: 'principal' })
  async test(@Param('orgId') orgId: string, @Param('webhookId') webhookId: string, @CurrentPrincipal() principal: L1Principal) {
    return this.webhooks.sendTest({ orgId, webhookId, actorId: principal.id });
  }

  @Get(':webhookId/deliveries')
  @Roles('owner', 'admin', 'billing', 'developer', 'reader')
  async deliveries(@Param('orgId') orgId: string, @Param('webhookId') webhookId: string) {
    return { deliveries: await this.webhooks.deliveries(orgId, webhookId) };
  }
}
