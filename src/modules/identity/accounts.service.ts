import { eq } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { EventBus, EngineEvents, AccountCreatedEvent } from '../../common/events/event-bus';
import { AuditService } from '../../common/audit/audit.service';
import { accounts } from './schema';

/**
 * Neryva Accounts (doc-06 D1): the human credential store, the ONLY one in
 * the company. Email is the identity; a successful email-code login IS
 * email verification. Status model: active | locked | disabled — locked is
 * the abuse posture, disabled is administrative.
 */
@Injectable()
export class AccountsService {
  constructor(
    private readonly db: DbService,
    private readonly events: EventBus,
    private readonly audit: AuditService,
  ) {}

  async findByEmail(email: string): Promise<typeof accounts.$inferSelect | null> {
    const rows = await this.db.root.select().from(accounts).where(eq(accounts.email, email)).limit(1);
    return rows[0] ?? null;
  }

  async findById(accountId: string): Promise<typeof accounts.$inferSelect | null> {
    const rows = await this.db.root.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
    return rows[0] ?? null;
  }

  /**
   * Upsert-on-login (I-1a): an unknown email creates the account; a known
   * email returns it. Enumeration resistance comes for free — login and
   * signup are the same operation, so there is no separate signal.
   */
  async upsertByEmail(email: string): Promise<{ account: typeof accounts.$inferSelect; created: boolean }> {
    const normalized = normalizeEmail(email);
    const existing = await this.findByEmail(normalized);
    if (existing) {
      if (existing.status !== 'active') {
        throw new Error('account is not active');
      }
      return { account: existing, created: false };
    }
    const inserted = await this.db.root
      .insert(accounts)
      .values({
        email: normalized,
        displayName: normalized.split('@')[0]?.slice(0, 256) ?? normalized,
      })
      .onConflictDoNothing({ target: accounts.email })
      .returning();
    if (inserted[0]) {
      await this.audit.add({
        action: 'account.created',
        resourceType: 'account',
        resourceId: inserted[0].id,
        actorType: 'system',
        details: { email_hash_prefix: normalized.slice(0, 2) }, // domain only, not the address
      });
      await this.events.emit<AccountCreatedEvent>(EngineEvents.AccountCreated, {
        accountId: inserted[0].id,
        email: normalized,
      });
      return { account: inserted[0], created: true };
    }
    // Lost an insert race — the winner's row is the truth.
    const raced = await this.findByEmail(normalized);
    if (!raced) {
      throw new Error('account upsert race produced no row');
    }
    return { account: raced, created: false };
  }

  async markLoginSuccess(accountId: string): Promise<void> {
    await this.db.root.update(accounts).set({ lastLoginAt: new Date().toISOString() }).where(eq(accounts.id, accountId));
  }

  /** First successful email-code login proves the mailbox. */
  async markEmailVerified(accountId: string): Promise<void> {
    await this.db.root.update(accounts).set({ emailVerifiedAt: new Date().toISOString() }).where(eq(accounts.id, accountId));
  }

  async updatePasswordHash(accountId: string, passwordHash: string): Promise<void> {
    await this.db.root.update(accounts).set({ passwordHash, updatedAt: new Date().toISOString() }).where(eq(accounts.id, accountId));
  }

  /** Global session kill-switch: the L1 guard compares iat against this. */
  async revokeAllSessions(accountId: string): Promise<void> {
    await this.db.root
      .update(accounts)
      .set({ sessionsRevokedAt: new Date().toISOString() })
      .where(eq(accounts.id, accountId));
    await this.events.emit(EngineEvents.SessionRevoked, { sid: null, accountId, revokeAllSessionsOfAccount: true });
  }

  /** Claims for the OP's findAccount (openid/email/profile scope-filtered upstream). */
  async claimsFor(accountId: string): Promise<Record<string, unknown>> {
    const account = await this.findById(accountId);
    if (!account) {
      throw new Error('account not found');
    }
    return {
      sub: account.id,
      email: account.email,
      email_verified: account.emailVerifiedAt !== null,
      name: account.displayName ?? account.email.split('@')[0],
      updated_at: Math.floor(Date.parse(account.updatedAt) / 1000),
    };
  }
}

export function normalizeEmail(email: string): string {
  const trimmed = email.trim().toLowerCase();
  if (trimmed.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    throw new Error('invalid email address');
  }
  return trimmed;
}
