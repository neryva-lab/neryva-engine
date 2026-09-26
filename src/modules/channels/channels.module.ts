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
import { AssistantRepositoriesModule } from '../assistants/repositories/assistant-repositories.module';
import { LifecycleModule } from '../lifecycle/lifecycle.module';
import { env } from '../../common/config/env';
import { DbService } from '../../common/infra/db/db.service';
import { MongoDbService } from '../../common/infra/db/mongo/mongo.service';
import {
  CHANNEL_ACCOUNT_REPOSITORY,
  CHANNEL_EVENT_REPOSITORY,
  CHANNEL_IDENTITY_REPOSITORY,
  CHANNEL_MESSAGE_LINK_REPOSITORY,
  CHANNEL_SESSION_REPOSITORY,
  CHANNEL_TEMPLATE_REPOSITORY,
} from './repositories/repository-tokens';
import { PgChannelAccountRepository } from './repositories/pg-channel-account.repository';
import { MongoChannelAccountRepository } from './repositories/mongo-channel-account.repository';
import { PgChannelIdentityRepository } from './repositories/pg-channel-identity.repository';
import { MongoChannelIdentityRepository } from './repositories/mongo-channel-identity.repository';
import { PgChannelEventRepository } from './repositories/pg-channel-event.repository';
import { MongoChannelEventRepository } from './repositories/mongo-channel-event.repository';
import { PgChannelMessageLinkRepository } from './repositories/pg-channel-message-link.repository';
import { MongoChannelMessageLinkRepository } from './repositories/mongo-channel-message-link.repository';
import { PgChannelSessionRepository } from './repositories/pg-channel-session.repository';
import { MongoChannelSessionRepository } from './repositories/mongo-channel-session.repository';
import { PgChannelTemplateRepository } from './repositories/pg-channel-template.repository';
import { MongoChannelTemplateRepository } from './repositories/mongo-channel-template.repository';

/**
 * Provider selection for the channels persistence ports (P3).
 *
 * This factory is the SINGLE place where the active provider is chosen:
 * `DB_PROVIDER=mongodb` selects the MongoDB implementation, anything else
 * (default `postgres`) selects PostgreSQL. Services inject only the
 * interface tokens and stay provider-blind; repositories contain no
 * provider conditionals.
 */
function repositoryProvider(
  token: symbol,
  create: (db: DbService, mongo: MongoDbService) => unknown,
) {
  return {
    provide: token,
    useFactory: create,
    inject: [DbService, MongoDbService],
  };
}

const isMongo = (): boolean => env.DB_PROVIDER === 'mongodb';

/**
 * Channel plane (Phase C — docs/architecture/engine/channel_integrations_plan.md).
 * Console CRUD + public webhook plane + public widget plane + the two outbox
 * consumers (ingest, outbound). The worker host registers the consumers —
 * see WorkersModule.
 */
@Module({
  imports: [ConversationsModule, OrganizationsModule, AssistantsModule, AssistantRepositoriesModule, LifecycleModule],
  controllers: [ChannelsController, ChannelsWebhookController, WidgetController, ChannelTemplatesController],
  providers: [
    repositoryProvider(
      CHANNEL_ACCOUNT_REPOSITORY,
      (db, mongo) => (isMongo() ? new MongoChannelAccountRepository(mongo) : new PgChannelAccountRepository(db)),
    ),
    repositoryProvider(
      CHANNEL_IDENTITY_REPOSITORY,
      (db, mongo) => (isMongo() ? new MongoChannelIdentityRepository(mongo) : new PgChannelIdentityRepository(db)),
    ),
    repositoryProvider(
      CHANNEL_EVENT_REPOSITORY,
      (db, mongo) => (isMongo() ? new MongoChannelEventRepository(mongo) : new PgChannelEventRepository(db)),
    ),
    repositoryProvider(
      CHANNEL_MESSAGE_LINK_REPOSITORY,
      (db, mongo) => (isMongo() ? new MongoChannelMessageLinkRepository(mongo) : new PgChannelMessageLinkRepository(db)),
    ),
    repositoryProvider(
      CHANNEL_SESSION_REPOSITORY,
      (db, mongo) => (isMongo() ? new MongoChannelSessionRepository(mongo) : new PgChannelSessionRepository(db)),
    ),
    repositoryProvider(
      CHANNEL_TEMPLATE_REPOSITORY,
      (db, mongo) => (isMongo() ? new MongoChannelTemplateRepository(mongo) : new PgChannelTemplateRepository(db)),
    ),
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
