import { Module } from '@nestjs/common';
import { ConversationsService } from './conversations.service';
import { ConversationsController, RunsController } from './conversations.controller';
import { LifecycleModule } from '../lifecycle/lifecycle.module';

@Module({
  imports: [LifecycleModule],
  controllers: [ConversationsController, RunsController],
  providers: [ConversationsService],
  exports: [ConversationsService],
})
export class ConversationsModule {}
