import { Module } from '@nestjs/common';
import { ConversationsService } from './conversations.service';
import { EscalationsService } from './escalations.service';
import { ConversationsController, RunsController } from './conversations.controller';
import { ConversationsPublicController } from './conversations.public.controller';
import { PublicSharesController } from './conversations.public-shares.controller';
import { EscalationsController } from './escalations.controller';
import { LifecycleModule } from '../lifecycle/lifecycle.module';

@Module({
  imports: [LifecycleModule],
  controllers: [ConversationsController, RunsController, EscalationsController, ConversationsPublicController, PublicSharesController],
  providers: [ConversationsService, EscalationsService],
  exports: [ConversationsService, EscalationsService],
})
export class ConversationsModule {}
