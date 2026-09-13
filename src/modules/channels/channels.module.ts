import { Module } from '@nestjs/common';
import { ChannelsService } from './channels.service';
import { ChannelsController } from './channels.controller';
import { ChannelsWebhookController } from './webhooks.controller';
import { WidgetController } from './widget.controller';
import { WidgetService } from './widget.service';
import { ChannelIngestConsumer, ChannelIngestService } from './ingest.service';
import { ChannelOutboundService } from './outbound.service';
import { WhatsAppSender, MessengerSender, TelegramSender, WebSender, InstagramSender, XSender, EmailSender } from './senders';
import { VoiceService } from './voice.service';
import { ChannelTemplatesService } from './templates.service';
import { ChannelTemplatesController } from './templates.controller';
import { ConversationsModule } from '../conversations/conversations.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { AssistantsModule } from '../assistants/assistants.module';
import { LifecycleModule } from '../lifecycle/lifecycle.module';

/**
 * Channel plane (Phase C — docs/architecture/engine/channel_integrations_plan.md).
 * Console CRUD + public webhook plane + public widget plane + the two outbox
 * consumers (ingest, outbound). The worker host registers the consumers —
 * see WorkersModule.
 */
@Module({
  imports: [ConversationsModule, OrganizationsModule, AssistantsModule, LifecycleModule],
  controllers: [ChannelsController, ChannelsWebhookController, WidgetController, ChannelTemplatesController],
  providers: [
    ChannelsService,
    ChannelIngestService,
    ChannelIngestConsumer,
    ChannelOutboundService,
    WhatsAppSender,
    MessengerSender,
    TelegramSender,
    WebSender,
    InstagramSender,
    XSender,
    EmailSender,
    VoiceService,
    ChannelTemplatesService,
    WidgetService,
  ],
  exports: [ChannelsService, ChannelIngestConsumer, ChannelOutboundService],
})
export class ChannelsModule {}
