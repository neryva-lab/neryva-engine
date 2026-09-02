import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { env } from '../../config/env';
import './pg-types';

export interface TxOptions {
  /** Per-transaction statement_timeout in ms (default 10_000). */
  statementTimeoutMs?: number;
  /** Per-transaction idle_in_transaction_session_timeout in ms (default 30_000). */
  idleInTransactionMs?: number;
  /** Serializable retry helper — if true, caller handles 40001 retry. */
  isolationLevel?: 'read committed' | 'repeatable read' | 'serializable';
}

/**
 * Database access discipline (partitioning Tier-0 / correction C16):
 *
 * - `root`           — engine-owned platform-plane tables and explicitly
 *                      filtered cross-tenant reads. No RLS context is set.
 * - `withOrg(orgId)` — a transaction with `app.current_tenant` set; RLS on
 *                      tenant-scoped tables (org_memberships, org_invites,
 *                      projects, product_entitlements) admits exactly that org.
 * - `withBypass()`    — a transaction with `app.engine_bypass = on` for the
 *                      narrow documented administrative paths (membership
 *                      lookups by account across orgs, invite redemption
 *                      before membership exists).
 *
 * Tenant context is ALWAYS transaction-local (`set_config(..., true)`), so
 * a pooled connection can never leak one request's tenant into another's.
 *
 * The kernel carries NO module schemas (the kernel imports no module):
 * queries use the core builder API (select().from(table)) against schema
 * objects imported by each module from its own schema file.
 */
@Injectable()
export class DbService implements OnModuleDestroy {
  private readonly pool: Pool;
  readonly db: NodePgDatabase;

  constructor() {
    this.pool = new Pool({
      connectionString: env.DATABASE_URL,
      max: env.DATABASE_POOL_MAX,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      application_name: 'neryva-engine',
      // Per-connection session defaults are applied lazily in `withOrg`/`withBypass`
      // so that pooled connections never carry stale `app.current_tenant` without `true`.
      // The `idle_in_transaction_session_timeout` + `statement_timeout` are set per-transaction
      // (see `applySessionTimeouts`) to bound slow-query and lock-held behavior.
    });
    this.pool.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error('[db] idle client error', err.message);
    });
    this.db = drizzle(this.pool);
  }

  private async applySessionTimeouts(tx: NodePgDatabase, options?: TxOptions): Promise<void> {
    const statementTimeout = options?.statementTimeoutMs ?? 10_000;
    const idleTimeout = options?.idleInTransactionMs ?? 30_000;
    await tx.execute(sql`select set_config('statement_timeout', ${String(statementTimeout)}, true)`);
    await tx.execute(sql`select set_config('idle_in_transaction_session_timeout', ${String(idleTimeout)}, true)`);
  }

  /** Root access — platform-plane tables and explicitly filtered reads. */
  get root(): NodePgDatabase {
    return this.db;
  }

  /** Run `fn` inside a transaction scoped to one organization (RLS context). */
  async withOrg<T>(orgId: string, fn: (tx: NodePgDatabase) => Promise<T>, options?: TxOptions): Promise<T> {
    return this.db.transaction(async (tx) => {
      await this.applySessionTimeouts(tx as NodePgDatabase, options);
      await tx.execute(sql`select set_config('app.current_tenant', ${orgId}, true)`);
      return fn(tx as NodePgDatabase);
    });
  }

  /**
   * Run `fn` with the documented administrative bypass. Callers MUST filter
   * explicitly and state the justification — this is an escape hatch for
   * cross-org administrative reads, not a default.
   */
  async withBypass<T>(fn: (tx: NodePgDatabase) => Promise<T>, options?: TxOptions): Promise<T> {
    return this.db.transaction(async (tx) => {
      await this.applySessionTimeouts(tx as NodePgDatabase, options);
      await tx.execute(sql`select set_config('app.engine_bypass', 'on', true)`);
      return fn(tx as NodePgDatabase);
    });
  }

  /**
   * Serializable helper — retries the transaction body on 40001/40P01 serialization failures.
   * Use only around a demonstrated invariant that requires repeatable-read/serializable.
   */
  async withSerializable<T>(fn: (tx: NodePgDatabase) => Promise<T>, attempts = 3): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await this.db.transaction(async (tx) => {
          await tx.execute(sql`select set_config('transaction_isolation', 'serializable', true)`);
          await this.applySessionTimeouts(tx as NodePgDatabase);
          return fn(tx as NodePgDatabase);
        });
      } catch (err: unknown) {
        const code = (err as { code?: string })?.code;
        if (code === '40001' || code === '40P01') {
          lastErr = err;
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }

  async check(): Promise<boolean> {
    try {
      await this.pool.query('select 1');
      return true;
    } catch {
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end().catch(() => undefined);
  }
}
