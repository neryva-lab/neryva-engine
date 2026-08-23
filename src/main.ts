import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { env } from './common/config/env';
import { ModuleFlags } from './common/config/feature-flags';

/**
 * Bootstrap ONLY (modularity M1): Fastify adapter, proxy trust, the global
 * validation pipe, lifecycle hooks. No business logic ever lives here.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true }),
    {
      logger:
        env.LOG_LEVEL === 'debug' || env.LOG_LEVEL === 'trace'
          ? ['log', 'error', 'warn', 'debug']
          : ['log', 'error', 'warn'],
    },
  );

  app.useGlobalPipes(
    // Bodies are validated per-DTO; unknown fields are rejected so a client
    // can never smuggle fields past the contract.
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  app.enableShutdownHooks();

  await app.listen(env.PORT, env.HOST);
  new Logger('Engine').log(
    `listening on ${env.HOST}:${env.PORT} (${env.NODE_ENV}) — corporate=${ModuleFlags.corporate ? 'on' : 'off'} identity=${ModuleFlags.identity ? 'on' : 'off'} organizations=${ModuleFlags.organizations ? 'on' : 'off'}`,
  );
}

void bootstrap().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('engine failed to boot', err);
  process.exit(1);
});
