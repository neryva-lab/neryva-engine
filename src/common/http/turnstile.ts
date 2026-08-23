import { Logger } from '@nestjs/common';
import { env } from '../config/env';

/**
 * Cloudflare Turnstile verification (ADR-008) — the human-proofing layer on
 * the engine's ONLY unauthenticated write surface (the corporate public
 * forms). Semantics:
 *
 *  - TURNSTILE_SECRET_KEY unset → the check is OFF (dev/test posture; the
 *    honeypot + rate limits remain).
 *  - configured → REQUIRED and fail-closed: a token that is missing,
 *    already-consumed, stale, or unverifiable fails the request. When the
 *    secret is set, operators have decided these forms must be protected —
 *    a Cloudflare outage failing open would silently disable that decision.
 *
 * The client sends its widget token on the X-Turnstile-Token header (kept
 * out of DTOs so the form contract stays about the form).
 */
const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const logger = new Logger('Turnstile');

export function turnstileEnabled(): boolean {
  return Boolean(env.TURNSTILE_SECRET_KEY);
}

/**
 * Verify a Turnstile token. Throws nothing — returns a verdict, because the
 * unconfigured case is a normal state, not an error path.
 */
export async function verifyTurnstile(token: string | undefined, remoteIp: string | null): Promise<boolean> {
  if (!turnstileEnabled()) {
    return true;
  }
  if (!token || token.length < 10 || token.length > 4096) {
    return false;
  }
  const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token });
  if (remoteIp) {
    body.set('remoteip', remoteIp);
  }
  try {
    const response = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      logger.warn(`siteverify HTTP ${response.status} — failing closed`);
      return false;
    }
    const verdict = (await response.json()) as { success?: boolean; 'error-codes'?: string[] };
    if (verdict.success !== true && verdict['error-codes']?.length) {
      logger.warn(`siteverify rejected: ${verdict['error-codes'].join(',')}`);
    }
    return verdict.success === true;
  } catch (err) {
    logger.warn(`siteverify unreachable (${(err as Error).message}) — failing closed`);
    return false;
  }
}
