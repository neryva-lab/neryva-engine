import { createSign } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { EventBus, EngineEvents } from '../../common/events/event-bus';
import { env } from '../../common/config/env';
import { JwksCustody } from '../identity/oidc/jwks-custody';
import { oauthSessions } from '../identity/schema';
import { staffImpersonations } from './schema';

/**
 * Support impersonation (the staff overlay's sharpest tool — therefore the
 * most constrained): a super_admin mints a short-lived (≤60 min) READ-ONLY
 * L1 session for a target account.
 *
 * How the token works: it is a standard OP-signed RS256 access JWT (the
 * same key/kid the L1 guard verifies) with `imp: true` + `act: {sub:
 * staffId}`, backed by a real oauth_sessions row so the session registry,
 * deny-list, and revocation machinery all apply. The guards enforce the
 * read-only posture: StepUpGuard refuses imp principals (no privileged
 * acts) and OrgRolesGuard refuses non-GET methods for them (no mutations).
 * Every mint and revoke is audited; the operational record supports list +
 * revoke; expiry is enforced by the JWT exp AND the session row's status.
 */
const MAX_TTL_MINUTES = 60;
const DEFAULT_TTL_MINUTES = 30;

@Injectable()
export class StaffImpersonationService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly custody: JwksCustody,
  ) {}

  async start(input: { staffAccountId: string; targetAccountId: string; orgId?: string | null; reason: string; ttlMinutes?: number }): Promise<{ token: string; expires_at: string; impersonation_id: string }> {
    const reason = input.reason.trim().slice(0, 512);
    if (reason.length < 10) {
      throw ApiError.validation({ reason: 'a substantive reason is required (min 10 chars) — it lands in the audit chain' });
    }
    if (input.staffAccountId === input.targetAccountId) {
      throw ApiError.validation({ target_account_id: 'cannot impersonate yourself' });
    }
    const ttl = Math.min(Math.max(input.ttlMinutes ?? DEFAULT_TTL_MINUTES, 1), MAX_TTL_MINUTES);

    const keys = this.custody.load();
    const now = Math.floor(Date.now() / 1000);
    const sid = `imp-${randomBytes(16).toString('hex')}`;
    const expiresAt = new Date((now + ttl * 60) * 1000).toISOString();

    // The session row: registry-verifiable, revocable, device-tagged so the
    // target's own session list shows the support access transparently.
    await this.db.root.insert(oauthSessions).values({
      sid,
      accountId: input.targetAccountId,
      clientId: 'neryva-console',
      familyId: randomBytes(16).toString('hex') as `${string}-${string}-${string}-${string}-${string}`,
      device: { impersonated: true, impersonated_by: input.staffAccountId, reason: reason.slice(0, 120) },
    });

    const header = { alg: 'RS256', typ: 'JWT', kid: keys.currentKid };
    const payload = {
      iss: env.IDENTITY_ISSUER,
      aud: env.IDENTITY_API_AUDIENCE,
      sub: input.targetAccountId,
      sid,
      iat: now,
      exp: now + ttl * 60,
      scope: 'openid profile',
      imp: true,
      act: { sub: input.staffAccountId },
    };
    const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    const privateKey = keys.privateKeys.get(keys.currentKid);
    if (!privateKey) {
      throw new Error('no active JWT signing key — impersonation refused');
    }
    const signer = createSign('RSA-SHA256');
    signer.update(signingInput);
    const signature = signer.sign(privateKey).toString('base64url');
    const token = `${signingInput}.${signature}`;

    const inserted = await this.db.root
      .insert(staffImpersonations)
      .values({
        staffAccountId: input.staffAccountId,
        targetAccountId: input.targetAccountId,
        orgId: input.orgId ?? null,
        reason,
        sessionSid: sid,
        expiresAt,
      })
      .returning({ id: staffImpersonations.id });

    await this.audit.add({
      action: 'staff.impersonation_started',
      resourceType: 'account',
      resourceId: input.targetAccountId,
      actorType: 'account',
      actorId: input.staffAccountId,
      details: { ttl_minutes: String(ttl), org_id: input.orgId ?? '', reason: reason.slice(0, 200) },
    });
    return { token, expires_at: expiresAt, impersonation_id: inserted[0].id };
  }

  async revoke(input: { staffAccountId: string; impersonationId: string }): Promise<void> {
    const rows = await this.db.root.select().from(staffImpersonations).where(eq(staffImpersonations.id, input.impersonationId)).limit(1);
    const row = rows[0];
    if (!row) {
      throw ApiError.notFound('impersonation');
    }
    const now = new Date().toISOString();
    await this.db.root.update(oauthSessions).set({ revokedAt: now }).where(eq(oauthSessions.sid, row.sessionSid));
    await this.db.root.update(staffImpersonations).set({ revokedAt: now }).where(eq(staffImpersonations.id, row.id));
    await this.events.emit(EngineEvents.SessionRevoked, { sid: row.sessionSid, accountId: row.targetAccountId });
    await this.audit.add({
      action: 'staff.impersonation_revoked',
      resourceType: 'account',
      resourceId: row.targetAccountId,
      actorType: 'account',
      actorId: input.staffAccountId,
      details: {},
    });
  }

  /** Expired rows whose session survived (crash between exp and cleanup). */
  async sweepExpiredSessions(): Promise<number> {
    const result = await this.db.root.execute<{ sid: string }>(sql`
      select i.session_sid as sid
      from staff_impersonations i
      join oauth_sessions s on s.sid = i.session_sid
      where i.revoked_at is null and i.expires_at < now() and s.revoked_at is null
      limit 100
    `);
    for (const row of result.rows) {
      await this.db.root.update(oauthSessions).set({ revokedAt: new Date().toISOString() }).where(eq(oauthSessions.sid, row.sid));
      await this.events.emit(EngineEvents.SessionRevoked, { sid: row.sid, accountId: '' });
    }
    return result.rows.length;
  }

  async listActive(): Promise<Array<typeof staffImpersonations.$inferSelect>> {
    return this.db.root
      .select()
      .from(staffImpersonations)
      .where(and(isNull(staffImpersonations.revokedAt), sql`${staffImpersonations.expiresAt} > now()`))
      .orderBy(desc(staffImpersonations.createdAt))
      .limit(100);
  }
}

function b64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}
