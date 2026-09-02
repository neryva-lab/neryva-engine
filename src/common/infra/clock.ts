/**
 * Deterministic clock and randomness port — Phase 1.6
 *
 * Production uses the system clock / crypto.randomUUID.
 * Tests inject a frozen or advancing clock via `Clock.fake()` so that
 * `created_at`, lease `expires_at`, idempotency `expires_at`, and outbox
 * `next_attempt_at` are deterministic and do not require `vi.useFakeTimers()`
 * scattering across suites.
 *
 * Usage:
 *   // production (no args):
 *   const clock = new SystemClock();
 *   clock.now()        // Date
 *   clock.nowMs()      // number
 *   clock.uuidv7()     // string — see `uuid` note
 *
 *   // tests:
 *   const clock = new FakeClock(new Date('2026-09-01T00:00:00Z'));
 *   clock.tick(5_000); // advance 5s
 */

export interface Clock {
  /** Current time as a Date (new instance each call). */
  now(): Date;
  /** Current time as epoch millis. */
  nowMs(): number;
  /** ISO-8601 string for deterministic audit/expiry tests. */
  nowIso(): string;
  /** Monotonic-ish tick for duration measurements (ms since clock birth). */
  monotonicMs(): number;
  /** Opaque UUIDv7 for new tenant-owned rows. Pure in production, deterministic stub in tests. */
  uuidv7(): string;
}

export class SystemClock implements Clock {
  private readonly startedAt = Date.now();

  now(): Date {
    return new Date();
  }

  nowMs(): number {
    return Date.now();
  }

  nowIso(): string {
    return new Date().toISOString();
  }

  monotonicMs(): number {
    return Date.now() - this.startedAt;
  }

  uuidv7(): string {
    // Lazy import keeps the port dependency-free; production installs `uuidv7` when green-field tables land.
    // Until then, fallback is randomUUID — callers must not rely on time-sortability of the fallback.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- dynamic fallback
      const { uuidv7 } = require('uuidv7') as { uuidv7: () => string };
      return uuidv7();
    } catch {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- node:crypto fallback
      const { randomUUID } = require('node:crypto') as { randomUUID: () => string };
      return randomUUID();
    }
  }
}

export class FakeClock implements Clock {
  private ms: number;
  private readonly startedAt: number;
  private seq = 0;

  constructor(start: Date | number = new Date('2026-01-01T00:00:00Z')) {
    this.ms = typeof start === 'number' ? start : start.getTime();
    this.startedAt = this.ms;
  }

  now(): Date {
    return new Date(this.ms);
  }

  nowMs(): number {
    return this.ms;
  }

  nowIso(): string {
    return new Date(this.ms).toISOString();
  }

  monotonicMs(): number {
    return this.ms - this.startedAt;
  }

  uuidv7(): string {
    this.seq += 1;
    // Deterministic, lex-sortable stub: 00000000-0000-7000-<seq>-<ms>
    const seqHex = this.seq.toString(16).padStart(12, '0');
    const msHex = this.ms.toString(16).padStart(12, '0');
    return `00000000-0000-7000-${seqHex.slice(0, 4)}-${seqHex.slice(4, 12)}${msHex.slice(0, 4)}`.slice(0, 36);
  }

  tick(ms: number): void {
    this.ms += ms;
  }

  set(date: Date | number): void {
    this.ms = typeof date === 'number' ? date : date.getTime();
  }
}

/** Convenience singleton for production request paths — prefer DI via `CLOCK` token in tests. */
export const systemClock = new SystemClock();
export const CLOCK = Symbol('CLOCK');
