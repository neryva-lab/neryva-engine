import { createHmac, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { env } from '../config/env';

/**
 * Run-scoped capability tokens (ledger 5.3). Engine issues a short-lived
 * HS256 JWT bound to one run: audience, tenant, conversation, run, assistant
 * and policy versions, an allow-listed operation set, capability_id/nonce,
 * and the key id (kid) for rotation. The token is the Studio caller's
 * authentication AND authorization for MCP authority RPCs — a valid service
 * identity alone never suffices (ADR-004).
 *
 * Transport security (mTLS/SPIFFE) terminates before this layer; rotation
 * works by overlapping `kid`s in MCP_CAPABILITY_SIGNING_KEY (current) — a
 * single active key today, extended to a map when rotation lands.
 */
export const CAPABILITY_AUDIENCE = 'neryva-agent-studio';

export const CAPABILITY_OPS = [
  'lease',
  'context',
  'search_knowledge',
  'append_events',
  'approval',
  'memory_proposal',
  'tool',
  'checkpoint',
  'commit',
  'observe',
] as const;

export type CapabilityOp = (typeof CAPABILITY_OPS)[number];

export interface CapabilityClaims {
  aud: string;
  iss: string;
  sub: string;
  organization_id: string;
  conversation_id: string;
  run_id: string;
  assistant_version_id?: string;
  policy_version?: string;
  allowed_ops: CapabilityOp[];
  capability_id: string;
  nonce: string;
  iat: number;
  exp: number;
  kid: string;
  lease_epoch?: number;
}

export interface CapabilityIssueInput {
  organizationId: string;
  conversationId: string;
  runId: string;
  assistantVersionId?: string;
  policyVersion?: string;
  allowedOps: readonly CapabilityOp[];
  ttlSeconds?: number;
  leaseEpoch?: number;
  subject?: string;
}

function currentKey(): { kid: string; secret: Buffer } {
  const raw = env.MCP_CAPABILITY_SIGNING_KEY;
  if (!raw) {
    throw new Error('MCP_CAPABILITY_SIGNING_KEY is not configured (capability issuance is fail-closed)');
  }
  const secret = Buffer.from(raw, 'base64');
  if (secret.length < 32) {
    throw new Error('MCP_CAPABILITY_SIGNING_KEY must decode to at least 32 bytes');
  }
  // kid is the stable fingerprint of the key material — rotation overlaps kids.
  return { kid: createHash('sha256').update(secret).digest('base64url').slice(0, 16), secret };
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function hmacSign(data: string, secret: Buffer): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

export function issueCapability(input: CapabilityIssueInput): { token: string; capabilityId: string; expiresAt: Date } {
  const { kid, secret } = currentKey();
  const now = Math.floor(Date.now() / 1000);
  const ttl = input.ttlSeconds ?? env.MCP_CAPABILITY_TTL_SECONDS;
  const capabilityId = randomUUID();
  const claims: CapabilityClaims = {
    aud: CAPABILITY_AUDIENCE,
    iss: 'neryva-engine',
    sub: input.subject ?? 'agent-studio-runtime',
    organization_id: input.organizationId,
    conversation_id: input.conversationId,
    run_id: input.runId,
    assistant_version_id: input.assistantVersionId,
    policy_version: input.policyVersion,
    allowed_ops: [...input.allowedOps],
    capability_id: capabilityId,
    nonce: randomUUID(),
    iat: now,
    exp: now + ttl,
    kid,
    lease_epoch: input.leaseEpoch,
  };
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid }));
  const payload = b64url(JSON.stringify(claims));
  const token = `${header}.${payload}.${hmacSign(`${header}.${payload}`, secret)}`;
  return { token, capabilityId, expiresAt: new Date((now + ttl) * 1000) };
}

export type CapabilityValidation =
  | { ok: true; claims: CapabilityClaims }
  | { ok: false; reason: string };

/**
 * Verify signature + expiry + audience. Scope matching (organization_id /
 * conversation_id / run_id against the RPC's RequestContext) is enforced by
 * the caller — never repair a scope mismatch, reject it.
 */
export function verifyCapability(token: string): CapabilityValidation {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return { ok: false, reason: 'malformed capability token' };
  }
  const { kid, secret } = currentKey();
  const [headerB64, payloadB64, signatureB64] = parts;
  let header: { alg?: string; kid?: string };
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed capability header' };
  }
  if (header.alg !== 'HS256' || header.kid !== kid) {
    return { ok: false, reason: 'unknown capability key id or algorithm' };
  }
  const expected = hmacSign(`${headerB64}.${payloadB64}`, secret);
  const given = Buffer.from(signatureB64);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    return { ok: false, reason: 'capability signature mismatch' };
  }
  let claims: CapabilityClaims;
  try {
    claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed capability claims' };
  }
  if (claims.aud !== CAPABILITY_AUDIENCE) {
    return { ok: false, reason: 'capability audience mismatch' };
  }
  if (typeof claims.exp !== 'number' || claims.exp <= Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: 'capability expired' };
  }
  if (!Array.isArray(claims.allowed_ops)) {
    return { ok: false, reason: 'capability has no allowed operations' };
  }
  return { ok: true, claims };
}

/** Capability must carry `op` AND match every provided scope field exactly. */
export function assertCapabilityFor(
  token: string | undefined,
  op: CapabilityOp,
  scope: { organizationId: string; conversationId?: string; runId?: string },
): CapabilityClaims {
  if (!token) {
    throw new Error('missing capability token');
  }
  const result = verifyCapability(token);
  if (!result.ok) {
    throw new Error(result.reason);
  }
  const { claims } = result;
  if (!claims.allowed_ops.includes(op)) {
    throw new Error(`capability does not allow operation ${op}`);
  }
  if (claims.organization_id !== scope.organizationId) {
    throw new Error('capability organization scope mismatch');
  }
  if (scope.conversationId && claims.conversation_id !== scope.conversationId) {
    throw new Error('capability conversation scope mismatch');
  }
  if (scope.runId && claims.run_id !== scope.runId) {
    throw new Error('capability run scope mismatch');
  }
  return claims;
}
