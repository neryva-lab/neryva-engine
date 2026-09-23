import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import pino from 'pino';
import { PinoNestLogger } from '../../src/common/observability/logger';

/**
 * Regression: PinoNestLogger used to JSON.stringify() every non-string log
 * message. Nest's ExceptionHandler passes the raw error object, and
 * JSON.stringify(new Error('...')) is '{}' — every bootstrap/DI failure
 * (including the by-design K-5 flag-matrix rejection) logged as an empty
 * `ERROR: {}` with no message or stack.
 */

function captureLogger(): { lines: string[]; nest: PinoNestLogger } {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc: BufferEncoding, cb: () => void) {
      lines.push(chunk.toString());
      cb();
    },
  });
  const root = pino({ level: 'trace' }, sink);
  return { lines, nest: new PinoNestLogger(root) };
}

describe('PinoNestLogger error formatting', () => {
  it('renders an Error with its message and stack, never as {}', () => {
    const { lines, nest } = captureLogger();
    const err = new Error('MODULES__CONVERSATIONS_ENABLED requires MODULES__ORGANIZATIONS_ENABLED');
    nest.error(err, undefined, 'ExceptionHandler');
    const out = lines.join('');
    expect(out).toContain('MODULES__CONVERSATIONS_ENABLED requires');
    expect(out).toContain('Error: MODULES__CONVERSATIONS_ENABLED requires');
    expect(out).not.toContain('"msg":"{}"');
  });

  it('appends enumerable own props of an Error instead of dropping them', () => {
    const { lines, nest } = captureLogger();
    const err = Object.assign(new Error('boom'), { code: 'BOOT_FAIL' });
    nest.error(err);
    const out = lines.join('');
    expect(out).toContain('boom');
    expect(out).toContain('BOOT_FAIL');
  });

  it('still JSON-stringifies plain objects and passes strings through', () => {
    const { lines, nest } = captureLogger();
    nest.error({ code: 'BOOT_FAIL' });
    nest.log('plain string');
    const out = lines.join('');
    // pino JSON-escapes the stringified message inside its own envelope —
    // assert on the payload content rather than the exact quoting.
    expect(out).toContain('BOOT_FAIL');
    expect(out).not.toContain('"msg":"{}"');
    expect(out).toContain('plain string');
  });
});
