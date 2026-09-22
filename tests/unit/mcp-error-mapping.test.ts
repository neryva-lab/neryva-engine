import { describe, it, expect } from 'vitest';
import { Code, ConnectError } from '@connectrpc/connect';
import { ApiError } from '../../src/common/http/api-error';
import { toConnectError } from '../../src/transport/mcp/mapper';

/**
 * MCP error mapping (toConnectError) — ApiError HTTP semantics must surface
 * as typed Connect codes on the wire. Regression: `ConnectError.from(err)`
 * was used as the pass-through guard, but `from()` is a converter that
 * returns a truthy ConnectError for ANY Error input, so the guard was always
 * true, the mapping below was dead code, and every ApiError (not_found,
 * invalid_argument, ...) reached the Connect framework as a raw non-
 * ConnectError and was sanitized to code=internal. Studio clients could not
 * distinguish error kinds.
 */
describe('toConnectError — ApiError to Connect code mapping', () => {
  it('maps 404 not_found to Code.NotFound (not internal)', () => {
    const out = toConnectError(ApiError.notFound('run'));
    expect(out).toBeInstanceOf(ConnectError);
    expect((out as ConnectError).code).toBe(Code.NotFound);
    expect((out as ConnectError).message).toContain('run not found');
  });

  it('maps 400 validation to Code.InvalidArgument', () => {
    const out = toConnectError(ApiError.validation({ field: 'x' }));
    expect(out).toBeInstanceOf(ConnectError);
    expect((out as ConnectError).code).toBe(Code.InvalidArgument);
  });

  it('maps 403 forbidden to Code.PermissionDenied', () => {
    const out = toConnectError(ApiError.forbidden('nope'));
    expect(out).toBeInstanceOf(ConnectError);
    expect((out as ConnectError).code).toBe(Code.PermissionDenied);
  });

  it('maps conflict to Code.Aborted', () => {
    const out = toConnectError(new ApiError(409, 'conflict', 'version mismatch'));
    expect(out).toBeInstanceOf(ConnectError);
    expect((out as ConnectError).code).toBe(Code.Aborted);
  });

  it('passes a genuine ConnectError through by identity', () => {
    const original = new ConnectError('denied', Code.PermissionDenied);
    expect(toConnectError(original)).toBe(original);
  });

  it('does not leak non-ApiError internals (returned raw for framework sanitization)', () => {
    const boom = new Error('db connection string exploded');
    const out = toConnectError(boom);
    expect(out).toBe(boom);
    expect(out).not.toBeInstanceOf(ConnectError);
  });
});
