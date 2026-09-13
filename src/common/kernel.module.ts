import { Global, Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { validateFlagMatrix } from './config/feature-flags';
import { DbService } from './infra/db/db.service';
import { RedisService } from './infra/redis.service';
import { QueueService } from './infra/queue.service';
import { StorageService } from './infra/storage/storage.service';
import { JwksService } from './auth/jwks.service';
import { AuthGuard } from './auth/auth.guard';
import { PlatformStaffDirectoryService } from './auth/platform-staff.directory';
import { PLATFORM_STAFF_DIRECTORY_PORT } from './auth/ports';
import { AuditService } from './audit/audit.service';
import { AllExceptionsFilter } from './http/all-exceptions.filter';
import { RequestIdMiddleware } from './http/request-id.middleware';
import { RateLimitGuard } from './http/rate-limit';
import { HealthController, HealthRegistry } from './health/health.controller';
import { EventBus } from './events/event-bus';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { MetricsInterceptor } from './observability/metrics.interceptor';
import { MetricsController } from './observability/metrics.controller';

/**
 * The shared kernel (locked list — additions require an ADR): config,
 * pg/redis/bullmq factories, object-storage presigning (ADR-008), the auth
 * guards, audit emitter, error envelope + request-id + idempotency + rate
 * limiting, health.
 *
 * The kernel imports no module. Its PORT tokens (session registry, org
 * access, service clients) are bound by the feature modules and resolved
 * by guards registered in AppModule — which sees both the kernel (global)
 * and the feature modules' exports. The APP_GUARD registrations therefore
 * live in AppModule, not here: a guard registered in this module could
 * never see the feature modules' port bindings.
 */
@Global()
@Module({
  providers: [
    DbService,
    RedisService,
    QueueService,
    StorageService,
    JwksService,
    AuditService,
    EventBus,
    HealthRegistry,
    // AUTH-1.2 (auth_plan.md D1, justified in ADR-014): the staff directory is
    // kernel-level because PlatformStaffGuard is hosted by several modules
    // (staff, satellites, billing) and every context must resolve the same
    // authority. Grant/revoke/bootstrap stay in the staff module.
    PlatformStaffDirectoryService,
    { provide: PLATFORM_STAFF_DIRECTORY_PORT, useExisting: PlatformStaffDirectoryService },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
  ],
  controllers: [HealthController, MetricsController],
  exports: [DbService, RedisService, QueueService, StorageService, JwksService, AuditService, EventBus, HealthRegistry],
})
export class KernelModule implements NestModule {
  constructor() {
    validateFlagMatrix();
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}

export { AuthGuard, RateLimitGuard };
