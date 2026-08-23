import { Controller, Get, Injectable, Logger, Res } from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { Public } from '../auth/decorators';

/**
 * Per-module readiness indicators (K-5): modules register a named check;
 * /health/ready is green only when every enabled module's check is green —
 * readiness refuses traffic when an enabled module is degraded.
 */
@Injectable()
export class HealthRegistry {
  private readonly checks = new Map<string, () => Promise<boolean> | boolean>();

  register(name: string, check: () => Promise<boolean> | boolean): void {
    this.checks.set(name, check);
  }

  async runAll(): Promise<{ name: string; ok: boolean }[]> {
    const entries = [...this.checks.entries()];
    return Promise.all(
      entries.map(async ([name, check]) => {
        try {
          return { name, ok: await check() };
        } catch {
          return { name, ok: false };
        }
      }),
    );
  }
}

@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(private readonly registry: HealthRegistry) {}

  /** Liveness: process is up. No dependencies — a broken DB must not kill pods in a restart loop. */
  @Public()
  @Get('live')
  live(): { status: string } {
    return { status: 'ok' };
  }

  /** Readiness: aggregate of every registered module check (503 when degraded). */
  @Public()
  @Get('ready')
  async ready(@Res({ passthrough: true }) reply: FastifyReply): Promise<{ status: string; checks: { name: string; ok: boolean }[] }> {
    const checks = await this.registry.runAll();
    const failing = checks.filter((c) => !c.ok);
    if (failing.length > 0) {
      this.logger.warn(`readiness failing: ${failing.map((c) => c.name).join(', ')}`);
      reply.status(503);
      return { status: 'degraded', checks };
    }
    return { status: 'ok', checks };
  }
}
