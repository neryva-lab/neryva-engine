import { Module } from '@nestjs/common';
import { ConversationsService } from './conversations.service';
import { ConversationsController, RunsController } from './conversations.controller';

@Module({
  controllers: [ConversationsController, RunsController],
  providers: [ConversationsService],
  exports: [ConversationsService],
})
export class ConversationsModule {}
