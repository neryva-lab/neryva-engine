import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsArray, IsIn, IsObject, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { AuthLayer, CurrentPrincipal, RequireScopes } from '../../common/auth/decorators';
import { L2Principal, L3Principal } from '../../common/auth/principal';
import { PlatformStaffGuard, StaffRoles } from '../../common/policy/staff.guard';
import { RateLimit } from '../../common/http/rate-limit';
import { ApiError } from '../../common/http/api-error';
import { SatelliteActivityService } from './satellite-activity.service';
import { SatelliteIncidentsService } from './satellite-incidents.service';
import { SatelliteRegistryService } from './satellite-registry.service';

export class HeartbeatDto {
  @IsOptional()
  @IsString()
  @Length(1, 64)
  version?: string;

  @IsOptional()
  @IsObject()
  capabilities?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  metrics?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class RegisterSatelliteDto {
  @IsString()
  @Length(2, 64)
  key!: string;

  @IsIn(['agent-runtime', 'inference', 'custom', 'worker', 'gateway'])
  kind!: string;

  @IsOptional()
  @IsIn(['active', 'placeholder'])
  status?: 'active' | 'placeholder';

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  route_prefixes?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(64)
  service_client_id?: string | null;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  products?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(512)
  endpoint_url?: string | null;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  version_floor?: string | null;

  @IsOptional()
  @IsObject()
  capabilities?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class QuarantineDto {
  @IsString()
  @Length(3, 512)
  reason!: string;
}

export class RetireDto {
  @IsString()
  confirmation!: string;
}

/**
 * The satellite operations plane (/internal/satellites — auth map row 19):
 * heartbeats arrive on L3 service tokens and answer with DIRECTIVES the
 * satellite converges on itself; the registry/lifecycle views and controls
 * are the staff overlay (L2 platform roles). Placeholder satellites are
 * refused here, not at the network edge, so the audit trail records the
 * attempt.
 */
@Controller('internal/satellites')
export class SatellitesController {
  constructor(
    private readonly registry: SatelliteRegistryService,
    private readonly incidents: SatelliteIncidentsService,
    private readonly activity: SatelliteActivityService,
  ) {}

  /**
   * Heartbeat (connection contract part 1 evidence; lease renewal). The
   * satellite's own service identity authorizes it: a service token may
   * only beat its own row (svc-agent-runtime → agent-runtime). The answer
   * carries the desired state (run/drain/quarantine), the version floor,
   * and timing — the control loop's entire downstream contract.
   */
  @Post(':key/heartbeat')
  @AuthLayer('l3')
  @RequireScopes('engine:heartbeat')
  @RateLimit({ name: 'satellite-heartbeat', capacity: 30, refillPerSecond: 0.5, scope: 'principal' })
  async heartbeat(
    @Param('key') key: string,
    @CurrentPrincipal() principal: L3Principal,
    @Body() dto: HeartbeatDto,
  ): Promise<{
    ok: true;
    interval_seconds: number;
    liveness: string;
    desired: 'run' | 'drain' | 'quarantine';
    version_floor: string | null;
    quarantine_reason: string | null;
    server_time: string;
  }> {
    const expectedKey = principal.id.replace(/^svc-/, '');
    if (key !== expectedKey && principal.id !== key) {
      throw ApiError.forbidden('A service token may only heartbeat its own satellite row');
    }
    try {
      return await this.registry.heartbeat({
        key,
        version: dto?.version,
        capabilities: dto?.capabilities,
        metrics: dto?.metrics,
        metadata: dto?.metadata,
      });
    } catch (err) {
      throw ApiError.forbidden((err as Error).message);
    }
  }

  // ── Staff overlay: views (any platform role incl. auditor) ───────────────

  /** Operational status with liveness + lease age + open incidents. */
  @Get()
  @AuthLayer('l2')
  @UseGuards(PlatformStaffGuard)
  @StaffRoles('super_admin', 'tenant_admin', 'operator', 'auditor')
  async status(): Promise<{ satellites: unknown[]; open_incidents_total: number }> {
    return {
      satellites: await this.registry.statusView(),
      open_incidents_total: await this.incidents.openCount(),
    };
  }

  /** One satellite's detail (row + compliance evidence + open incidents). */
  @Get(':key')
  @AuthLayer('l2')
  @UseGuards(PlatformStaffGuard)
  @StaffRoles('super_admin', 'tenant_admin', 'operator', 'auditor')
  async detail(@Param('key') key: string): Promise<{ satellite: unknown; compliance: unknown; open_incidents: unknown[] }> {
    const satellite = await this.registry.get(key);
    if (!satellite) {
      throw ApiError.notFound('satellite');
    }
    return {
      satellite,
      compliance: await this.activity.compliance(key, this.registry.heartbeatIntervalSeconds),
      open_incidents: await this.incidents.listOpen(key),
    };
  }

  /** Heartbeat sample history (the ops view's liveness/metrics graph). */
  @Get(':key/history')
  @AuthLayer('l2')
  @UseGuards(PlatformStaffGuard)
  @StaffRoles('super_admin', 'tenant_admin', 'operator', 'auditor')
  async history(@Param('key') key: string, @Query('limit') limit?: string): Promise<{ heartbeats: unknown[] }> {
    const parsed = limit ? Number.parseInt(limit, 10) : 200;
    return { heartbeats: await this.registry.history(key, Number.isFinite(parsed) ? parsed : 200) };
  }

  /** Fleet-wide heartbeat history window (the status page's trend graph). */
  @Get('history/recent')
  @AuthLayer('l2')
  @UseGuards(PlatformStaffGuard)
  @StaffRoles('super_admin', 'tenant_admin', 'operator', 'auditor')
  async recentHistory(@Query('minutes') minutes?: string): Promise<{ heartbeats: unknown[] }> {
    const parsed = minutes ? Number.parseInt(minutes, 10) : 60;
    return { heartbeats: await this.registry.recentHistory(Math.min(Math.max(Number.isFinite(parsed) ? parsed : 60, 5), 1440)) };
  }

  /** The incident timeline (status-page history for one satellite). */
  @Get(':key/incidents')
  @AuthLayer('l2')
  @UseGuards(PlatformStaffGuard)
  @StaffRoles('super_admin', 'tenant_admin', 'operator', 'auditor')
  async incidentsFor(@Param('key') key: string, @Query('limit') limit?: string): Promise<{ incidents: unknown[] }> {
    const parsed = limit ? Number.parseInt(limit, 10) : 100;
    return { incidents: await this.incidents.listFor(key, Number.isFinite(parsed) ? parsed : 100) };
  }

  /** Fleet-wide recent incidents (the status page's history feed). */
  @Get('incidents/recent')
  @AuthLayer('l2')
  @UseGuards(PlatformStaffGuard)
  @StaffRoles('super_admin', 'tenant_admin', 'operator', 'auditor')
  async recentIncidents(@Query('limit') limit?: string): Promise<{ incidents: unknown[] }> {
    const parsed = limit ? Number.parseInt(limit, 10) : 100;
    return { incidents: await this.incidents.recent(Number.isFinite(parsed) ? parsed : 100) };
  }

  // ── Staff overlay: lifecycle controls (operator+) ────────────────────────

  /** Register or update a satellite row (audited; retired keys are terminal). */
  @Post()
  @AuthLayer('l2')
  @UseGuards(PlatformStaffGuard)
  @StaffRoles('super_admin', 'operator')
  @RateLimit({ name: 'satellite-register', capacity: 10, refillPerSecond: 0.02, scope: 'principal' })
  async register(@Body() dto: RegisterSatelliteDto, @CurrentPrincipal() principal: L2Principal): Promise<{ satellite: unknown }> {
    return {
      satellite: await this.registry.register({
        key: dto.key,
        kind: dto.kind,
        status: dto.status,
        routePrefixes: dto.route_prefixes,
        serviceClientId: dto.service_client_id ?? null,
        products: dto.products,
        endpointUrl: dto.endpoint_url ?? null,
        versionFloor: dto.version_floor ?? null,
        capabilities: dto.capabilities,
        metadata: dto.metadata,
        actorId: principal.id,
      }),
    };
  }

  /**
   * Quarantine: the satellite stays visible (heartbeats keep flowing) but
   * is refused everywhere else and told to drain itself via directives.
   */
  @Post(':key/quarantine')
  @AuthLayer('l2')
  @UseGuards(PlatformStaffGuard)
  @StaffRoles('super_admin', 'operator')
  async quarantine(
    @Param('key') key: string,
    @Body() dto: QuarantineDto,
    @CurrentPrincipal() principal: L2Principal,
  ): Promise<{ ok: true }> {
    await this.registry.quarantine({ key, reason: dto.reason, actorId: principal.id });
    return { ok: true };
  }

  @Post(':key/release')
  @AuthLayer('l2')
  @UseGuards(PlatformStaffGuard)
  @StaffRoles('super_admin', 'operator')
  async release(@Param('key') key: string, @CurrentPrincipal() principal: L2Principal): Promise<{ ok: true }> {
    await this.registry.release({ key, actorId: principal.id });
    return { ok: true };
  }

  /** Graceful retirement step 1: stop new work, finish in-flight. */
  @Post(':key/drain')
  @AuthLayer('l2')
  @UseGuards(PlatformStaffGuard)
  @StaffRoles('super_admin', 'operator')
  async drain(@Param('key') key: string, @CurrentPrincipal() principal: L2Principal): Promise<{ ok: true }> {
    await this.registry.drain({ key, actorId: principal.id });
    return { ok: true };
  }

  @Post(':key/resume')
  @AuthLayer('l2')
  @UseGuards(PlatformStaffGuard)
  @StaffRoles('super_admin', 'operator')
  async resume(@Param('key') key: string, @CurrentPrincipal() principal: L2Principal): Promise<{ ok: true }> {
    await this.registry.resume({ key, actorId: principal.id });
    return { ok: true };
  }

  /** Terminal retirement (typed confirmation; register a new key instead of un-retiring). */
  @Post(':key/retire')
  @AuthLayer('l2')
  @UseGuards(PlatformStaffGuard)
  @StaffRoles('super_admin', 'operator')
  async retire(
    @Param('key') key: string,
    @Body() dto: RetireDto,
    @CurrentPrincipal() principal: L2Principal,
  ): Promise<{ ok: true }> {
    if (dto.confirmation !== 'retire') {
      throw ApiError.validation({ confirmation: 'type "retire" to confirm' });
    }
    await this.registry.retire({ key, actorId: principal.id });
    return { ok: true };
  }
}
