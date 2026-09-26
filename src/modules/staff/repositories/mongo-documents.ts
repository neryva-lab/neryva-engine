/**
 * Shared MongoDB document shapes + row mappers for the staff-module mongo
 * repositories (P3).
 *
 * Plan D4: UUIDs are stored as BSON Binary subtype 4 (STANDARD), field names
 * are the pg snake_case column names, timestamps are ISO-8601 strings. The
 * pg `id`/`account_id` columns are kept as Binary fields; `_id` is left to
 * the driver's default ObjectId (never overridden).
 */
import type { Binary, Db, Document, WithId } from 'mongodb';
import { ApiError } from '../../../common/http/api-error';
import { uuidToBinary } from '../../../common/infra/db/mongo/mongo-tx';
import type { Impersonation } from './impersonation.repository';
import type { PlatformStaff, PlatformStaffListRow } from './platform-staff.repository';

/**
 * Parse a UUID into BSON Binary subtype 4. Fails closed with a validation
 * error rather than leaking a driver parse error.
 */
export function binUuid(id: string, field = 'id'): Binary {
  try {
    return uuidToBinary(id);
  } catch {
    throw ApiError.validation({ [field]: 'must be a uuid' });
  }
}

function uuidOf(value: Binary): string {
  return value.toUUID().toString();
}

// ── staff_impersonations ────────────────────────────────────────────────────

export interface ImpersonationMongoDoc {
  id: Binary;
  staff_account_id: Binary;
  target_account_id: Binary;
  org_id: string | null;
  reason: string;
  session_sid: string;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
}

export function toImpersonation(doc: WithId<ImpersonationMongoDoc>): Impersonation {
  return {
    id: uuidOf(doc.id),
    staffAccountId: uuidOf(doc.staff_account_id),
    targetAccountId: uuidOf(doc.target_account_id),
    orgId: doc.org_id,
    reason: doc.reason,
    sessionSid: doc.session_sid,
    expiresAt: doc.expires_at,
    revokedAt: doc.revoked_at,
    createdAt: doc.created_at,
  };
}

// ── platform_staff ──────────────────────────────────────────────────────────

export interface PlatformStaffMongoDoc {
  account_id: Binary;
  role: string;
  granted_by: Binary | null;
  granted_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
}

export function toPlatformStaff(doc: WithId<PlatformStaffMongoDoc>): PlatformStaff {
  return {
    accountId: uuidOf(doc.account_id),
    role: doc.role,
    grantedBy: doc.granted_by ? uuidOf(doc.granted_by) : null,
    grantedAt: doc.granted_at,
    expiresAt: doc.expires_at,
    revokedAt: doc.revoked_at,
    revokeReason: doc.revoke_reason,
  };
}

// ── accounts (read-only projection for the staff list join) ─────────────────

export interface AccountPlaneMongoDoc {
  id: Binary;
  email: string | null;
  display_name: string | null;
}

export function toPlatformStaffListRow(
  staff: WithId<PlatformStaffMongoDoc>,
  account: WithId<AccountPlaneMongoDoc> | null,
): PlatformStaffListRow {
  return {
    accountId: uuidOf(staff.account_id),
    email: account?.email ?? null,
    displayName: account?.display_name ?? null,
    role: staff.role,
    grantedAt: staff.granted_at,
    expiresAt: staff.expires_at,
    revokedAt: staff.revoked_at,
  };
}

// ── oauth_sessions (read-only projection for the sweep join) ────────────────

export interface SessionPlaneMongoDoc {
  sid: string;
  revoked_at: string | null;
}

export type StaffDb = Db;
export type { Document };
