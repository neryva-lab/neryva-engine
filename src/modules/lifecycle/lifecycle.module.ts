import { Module } from '@nestjs/common';
import { RetentionPurgeService } from './retention-purge.service';
import { LifecycleService } from './lifecycle.service';
import { LifecycleController } from './lifecycle.controller';
import { OrganizationsModule } from '../organizations/organizations.module';
import { LifecycleRepositoriesModule } from './repositories/lifecycle-repositories.module';

/**
 * Lifecycle & compliance module — Phase 9. The purge worker self-gates on
 * the worker host flag (onModuleInit) like the other background workers.
 */
@Module({
  imports: [OrganizationsModule, LifecycleRepositoriesModule],
  controllers: [LifecycleController],
  providers: [RetentionPurgeService, LifecycleService],
  exports: [RetentionPurgeService, LifecycleService],
})
export class LifecycleModule {}
