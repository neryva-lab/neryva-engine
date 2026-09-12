import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AuthLayer, CurrentPrincipal } from '../../common/auth/decorators';
import { L1Principal } from '../../common/auth/principal';
import { OrgRolesGuard, Roles } from '../../common/policy/org-roles.guard';
import { Idempotent } from '../../common/http/idempotency';
import { ApiError } from '../../common/http/api-error';
import { ChannelsService } from './channels.service';
import { CreateChannelDto, RotateCredentialsDto, UpdateChannelDto } from './dto';

/**
 * Channel account console surface (Phase C1). Org-role guarded; credentials
 * are sealed at write time and never returned — rotate/verify/setup are the
 * only paths that touch secrets, and they run server-side.
 */
@Controller('console/org/:orgId/channels')
@AuthLayer('l1')
export class ChannelsController {
  constructor(private readonly channels: ChannelsService) {}

  @Post()
  @Roles('owner', 'admin')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async create(@Param('orgId') orgId: string, @Body() dto: CreateChannelDto, @CurrentPrincipal() principal: L1Principal) {
    const row = await this.channels.create({
      orgId,
      platform: dto.platform,
      displayName: dto.display_name,
      credentials: dto.credentials,
      config: dto.config,
      actor: principal.id,
    });
    return { channel: this.channels.toPublicView(row) };
  }

  @Get()
  @Roles('owner', 'admin', 'developer', 'reader', 'billing')
  @UseGuards(OrgRolesGuard)
  async list(@Param('orgId') orgId: string) {
    const rows = await this.channels.list(orgId);
    return { channels: rows.map((r) => this.channels.toPublicView(r)) };
  }

  @Get(':channelId')
  @Roles('owner', 'admin', 'developer', 'reader', 'billing')
  @UseGuards(OrgRolesGuard)
  async get(@Param('orgId') orgId: string, @Param('channelId') channelId: string) {
    const row = await this.channels.get(orgId, channelId);
    if (!row) {
      throw ApiError.notFound('channel account');
    }
    return { channel: this.channels.toPublicView(row) };
  }

  @Patch(':channelId')
  @Roles('owner', 'admin')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async update(@Param('orgId') orgId: string, @Param('channelId') channelId: string, @Body() dto: UpdateChannelDto, @CurrentPrincipal() principal: L1Principal) {
    const row = await this.channels.update({
      orgId,
      accountId: channelId,
      displayName: dto.display_name,
      status: dto.status,
      config: dto.config,
      actor: principal.id,
    });
    return { channel: this.channels.toPublicView(row) };
  }

  @Delete(':channelId')
  @Roles('owner', 'admin')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async deactivate(@Param('orgId') orgId: string, @Param('channelId') channelId: string, @CurrentPrincipal() principal: L1Principal) {
    await this.channels.deactivate({ orgId, accountId: channelId, actor: principal.id });
    return { deactivated: true };
  }

  @Post(':channelId/credentials/rotate')
  @Roles('owner', 'admin')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async rotate(@Param('orgId') orgId: string, @Param('channelId') channelId: string, @Body() dto: RotateCredentialsDto, @CurrentPrincipal() principal: L1Principal) {
    const row = await this.channels.rotateCredentials({ orgId, accountId: channelId, credentials: dto.credentials, actor: principal.id });
    return { channel: this.channels.toPublicView(row) };
  }

  @Post(':channelId/verify')
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async verify(@Param('orgId') orgId: string, @Param('channelId') channelId: string, @CurrentPrincipal() principal: L1Principal) {
    return this.channels.verifyCredentials({ orgId, accountId: channelId, actor: principal.id });
  }

  /**
   * Returns the Engine webhook URL + (Meta) verify token for platform setup,
   * or registers the Telegram webhook server-side. The verify token is
   * displayed ONCE here — it is the hub.verify_token echo secret.
   */
  @Post(':channelId/webhook-setup')
  @Roles('owner', 'admin')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async webhookSetup(@Param('orgId') orgId: string, @Param('channelId') channelId: string, @CurrentPrincipal() principal: L1Principal) {
    return this.channels.setupWebhook({ orgId, accountId: channelId, actor: principal.id });
  }
}
