/**
 * Channel-account repository (P3) — the persistence port for `channel_accounts`
 * (`ChannelsService` CRUD, credential rotation, health probes, and the
 * ingest/widget resolution paths).
 *
 * Each method owns its transaction. No transaction handle or callback leaks
 * through this interface — callers get plain domain results.
 *
 * Tenant discipline: every tenant-scoped method takes the organization id
 * explicitly (first parameter). The PostgreSQL implementation applies it via
 * `DbService.withOrg` (RLS); the MongoDB implementation applies it as an
 * explicit `organization_id` predicate on every tenant collection access.
 * `getAccountByIdForIngest` / `getAccountByPublicKey` are the documented
 * bypass reads: the webhook signature (or the unguessable `nk_live_` public
 * key) already authenticated the call, so the read is scoped by exact id/key
 * with no tenant predicate — mirroring the pg lane's `db.withBypass`.
 *
 * Row types are imported as *types only* from the module schema — the
 * interface carries no drizzle runtime dependency.
 */
import type { ChannelAccount, ChannelConfig } from '../schema';

export interface CreateChannelAccountInput {
  orgId: string;
  accountId: string;
  platform: string;
  displayName: string;
  /** `nk_live_…` for platform='web', null otherwise. */
  publicKey: string | null;
  /** Envelope-sealed credentials (ciphertext only). */
  credentialsSealed: Record<string, string>;
  /** Envelope-sealed Meta verify token, or null. */
  verifyTokenSealed: string | null;
  config: ChannelConfig;
  createdBy: string;
  /** Entitlement-derived cap on non-suspended accounts (service computes). */
  cap: number;
}

export interface UpdateChannelAccountPatch {
  displayName?: string;
  status?: 'active' | 'suspended';
  config?: ChannelConfig;
}

export interface IChannelAccountRepository {
  /**
   * Cap check + insert in ONE transaction: the count of non-suspended
   * accounts is read and the row inserted atomically, so concurrent creates
   * cannot overshoot the cap. Throws `conflict` when the cap is reached,
   * and `conflict('a channel with this name already exists for this
   * platform')` on the (org, platform, display_name) unique violation.
   */
  createAccount(input: CreateChannelAccountInput): Promise<ChannelAccount>;

  /** Raw row read; null when the account is missing or foreign. */
  getAccount(orgId: string, accountId: string): Promise<ChannelAccount | null>;

  /**
   * Bypass read by exact id for the signature-verified webhook path.
   * No tenant predicate (mirrors `db.withBypass`).
   */
  getAccountByIdForIngest(accountId: string): Promise<ChannelAccount | null>;

  /**
   * Bypass read by exact public key for the anonymous widget plane.
   * No tenant predicate (mirrors `db.withBypass`).
   */
  getAccountByPublicKey(publicKey: string): Promise<ChannelAccount | null>;

  listAccounts(orgId: string): Promise<ChannelAccount[]>;

  /** Throws `not_found('channel account')` when the row is missing/foreign. */
  updateAccount(
    orgId: string,
    accountId: string,
    patch: UpdateChannelAccountPatch,
  ): Promise<ChannelAccount>;

  /**
   * Suspend + destroy sealed credentials + revoke every widget session in
   * ONE transaction. Throws `not_found('channel account')` when missing.
   */
  deactivateAccount(orgId: string, accountId: string): Promise<void>;

  /**
   * Rotate sealed credentials (and the Meta verify token). `reverify`
   * decides whether the account drops back to `pending` — web rotations
   * stay a status no-op (P5-C8). The service pre-reads the account; the
   * repository mirrors the current update shape exactly.
   */
  rotateCredentials(
    orgId: string,
    accountId: string,
    input: {
      credentialsSealed: Record<string, string>;
      verifyTokenSealed: string | null;
      reverify: boolean;
    },
  ): Promise<ChannelAccount>;

  /** Persist probe health; flips status to `active` when `markActive`. */
  setHealth(
    orgId: string,
    accountId: string,
    input: { health: Record<string, unknown>; markActive: boolean },
  ): Promise<void>;
}
