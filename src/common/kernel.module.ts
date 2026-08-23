import { Global, Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { validateFlagMatrix } from './config/feature-flags';
import { DbService } from './infra/db/db.service';
import { RedisService } from './infra/redis.service';
import { QueueService } from './infra/queue.service';
import { JwksService } from './auth/jwks.service';
import { AuthGuard } from './auth/auth.guard';
import { AuditService } from './audit/audit.service';
import { AllExceptionsFilter } from './http/all-exceptions.filter';
import { RequestIdMiddleware } from './http/request-id.middleware';
import { RateLimitGuard } from './http/rate-limit';
import { HealthController, HealthRegistry } from './health/health.controller';
import { EventBus } from './events/event-bus';

/**
 * The shared kernel (locked list — additions require an ADR): config,
 * pg/redis/bullmq factories, the auth guards, audit emitter, error envelope
 * + request-id + idempotency + rate limiting, health.
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
    JwksService,
    AuditService,
    EventBus,
    HealthRegistry,
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
  controllers: [HealthController],
  exports: [DbService, RedisService, QueueService, JwksService, AuditService, EventBus, HealthRegistry],
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
