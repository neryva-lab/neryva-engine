import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Db } from 'mongodb';
import { MongoClient } from 'mongodb';
import { env } from '../../../config/env';
import type { MongoTxContext } from './mongo-tx';
import { runInTransaction } from './retry';
import type { TxRetryOptions } from './retry';

export interface MongoTxOptions {
  /**
   * Best-effort per-operation timeout in ms, mapped to the transaction's
   * `maxTimeMS`.
   *
   * GAP vs the PostgreSQL lane (documented, not hidden): `statement_timeout`
   * bounds the whole statement stream of a pg transaction and
   * `idle_in_transaction_session_timeout` kills transactions that hold locks
   * while idle. MongoDB's `maxTimeMS` is PER OPERATION — a transaction that
   * runs many fast operations can still hold locks far longer than this
   * value, and there is no idle-in-transaction killer. Keep transaction
   * bodies short and never await external I/O inside them; the 30s pg
   * idle-in-transaction default has no Mongo equivalent.
   */
  maxTimeMs?: number;
  /** Retry tuning for the transaction wrapper (see retry.ts). */
  retry?: TxRetryOptions;
}

/**
 * MongoDB counterpart of `DbService` (plan D1–D3). Same access discipline:
 *
 * - `root`            — the raw `Db` handle: platform-plane collections and
 *                       explicitly filtered cross-tenant reads. No session.
 * - `withOrg(orgId)`  — one transaction in a `ClientSession`; the orgId is
 *                       carried on the context for explicit tenant predicates
 *                       (there is no RLS/GUC mechanism on this lane — D6).
 * - `withBypass()`    — one transaction with `orgId: null` for the narrow
 *                       documented administrative paths.
 *
 * The service is inert when `DB_PROVIDER=postgres`: it never connects and
 * every entry point throws a clear error naming the active provider.
 */
@Injectable()
export class MongoDbService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MongoDbService.name);
  private readonly isMongoProvider = env.DB_PROVIDER === 'mongodb';
  private client: MongoClient | null = null;
  private dbHandle: Db | null = null;
  /** Resolves once the eager boot connection + replica-set check complete. */
  private readonly ready: Promise<void>;

  constructor() {
    if (!this.isMongoProvider) {
      this.ready = Promise.resolve();
      return;
    }
    const uri = env.MONGODB_URI; // guaranteed present by env superRefine
    if (!uri) {
      throw new Error('MONGODB_URI is required when DB_PROVIDER=mongodb');
    }
    this.client = new MongoClient(uri, {
      maxPoolSize: env.MONGODB_POOL_MAX,
      serverSelectionTimeoutMS: env.MONGODB_SERVER_SELECTION_TIMEOUT_MS,
      socketTimeoutMS: env.MONGODB_SOCKET_TIMEOUT_MS,
      appName: 'neryva-engine',
    });
    // Eager connect started in the constructor; the replica-set verification
    // is awaited in onModuleInit so a standalone server is a fail-closed
    // boot error (multi-document transactions require a replica set — D5).
    this.ready = this.initialize();
  }

  private async initialize(): Promise<void> {
    const client = this.client;
    if (!client) return;
    await client.connect();
    this.dbHandle = client.db();
    // Fail closed unless the topology supports multi-document transactions:
    // a replica set (hello.setName) or a sharded cluster (mongos). A
    // standalone server would silently break every transactional invariant.
    const hello = await this.dbHandle.admin().command({ hello: 1 });
    const setName = (hello as { setName?: string }).setName;
    const isMongos = (hello as { msg?: string }).msg === 'isdbgrid';
    if (!setName && !isMongos) {
      await client.close().catch(() => undefined);
      this.client = null;
      this.dbHandle = null;
      throw new Error(
        'MongoDB provider requires a replica set (or sharded cluster): the server answered hello without setName. ' +
          'Start mongod with --replSet and initiate it; single-node replica sets are fine for dev/CI.',
      );
    }
    this.logger.log(
      `MongoDB lane connected (topology: ${isMongos ? 'sharded' : `replica set "${setName}"`})`,
    );
  }

  async onModuleInit(): Promise<void> {
    // Await the eager boot connection so the app never serves traffic on a
    // half-initialized Mongo lane; a failed replica-set check throws here.
    await this.ready;
  }

  private async ensureMongo(): Promise<MongoClient> {
    if (!this.isMongoProvider) {
      throw new Error(
        'MongoDbService is not active: DB_PROVIDER=postgres. Use DbService for the PostgreSQL lane.',
      );
    }
    await this.ready;
    const client = this.client;
    if (!client) {
      throw new Error('MongoDbService failed to initialize: no MongoClient (see boot logs)');
    }
    return client;
  }

  /** Root access — platform-plane collections and explicitly filtered reads. No session. */
  get root(): Db {
    if (!this.isMongoProvider || !this.dbHandle) {
      throw new Error(
        'MongoDbService.root is not available: DB_PROVIDER=postgres (or the Mongo lane failed to initialize).',
      );
    }
    return this.dbHandle;
  }

  /** Run `fn` inside one transaction scoped to one organization (explicit tenant predicates). */
  async withOrg<T>(
    orgId: string,
    fn: (ctx: MongoTxContext) => Promise<T>,
    options?: MongoTxOptions,
  ): Promise<T> {
    if (!orgId) {
      throw new Error('withOrg requires a non-empty orgId (fail-closed tenant scoping)');
    }
    return this.withSession({ orgId }, fn, options);
  }

  /**
   * Run `fn` with the documented administrative bypass (`orgId: null`).
   * Callers MUST filter explicitly and state the justification — this is an
   * escape hatch for cross-org administrative reads, not a default.
   */
  async withBypass<T>(
    fn: (ctx: MongoTxContext) => Promise<T>,
    options?: MongoTxOptions,
  ): Promise<T> {
    return this.withSession({ orgId: null }, fn, options);
  }

  /**
   * API symmetry with `DbService.withSerializable`. No callers exist on the
   * PostgreSQL lane today. MongoDB transactions are snapshot-isolated; a
   * true serializable isolation level is not offered, so this is an alias
   * for `withBypass` — documented here rather than silently emulated.
   */
  async withSerializable<T>(
    fn: (ctx: MongoTxContext) => Promise<T>,
    options?: MongoTxOptions,
  ): Promise<T> {
    return this.withBypass(fn, options);
  }

  private async withSession<T>(
    scope: { orgId: string | null },
    fn: (ctx: MongoTxContext) => Promise<T>,
    options?: MongoTxOptions,
  ): Promise<T> {
    const client = await this.ensureMongo();
    const session = client.startSession();
    try {
      return await runInTransaction(
        session,
        () => fn({ session, orgId: scope.orgId }),
        {
          ...options?.retry,
          transactionOptions: {
            ...(options?.maxTimeMs !== undefined ? { maxTimeMS: options.maxTimeMs } : {}),
            ...options?.retry?.transactionOptions,
          },
        },
      );
    } finally {
      await session.endSession().catch(() => undefined);
    }
  }

  /** Liveness probe for the active provider. Throws with a clear message on failure. */
  async check(): Promise<void> {
    if (!this.isMongoProvider) {
      throw new Error('MongoDbService.check: DB_PROVIDER=postgres — the MongoDB lane is not active');
    }
    await this.ensureMongo();
    try {
      await this.dbHandle!.admin().command({ ping: 1 });
    } catch (err) {
      throw new Error(`MongoDB ping failed: ${(err as Error).message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.close().catch(() => undefined);
    this.client = null;
    this.dbHandle = null;
  }
}
