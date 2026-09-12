import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * The one error envelope (modularity §4). Every error response is
 * `{ error: { code, message, details?, request_id } }` — machine-readable
 * codes drive product SDK upgrade prompts (access-model: entitlement
 * denials carry codes, never prose).
 */
export const ERROR_CODES = {
  UNAUTHENTICATED: 'unauthenticated',
  DENIED_BY_DEFAULT: 'denied_by_default',
  FORBIDDEN: 'forbidden',
  ENTITLEMENT_REQUIRED: 'entitlement_required',
  PAST_DUE: 'past_due',
  STEP_UP_REQUIRED: 'step_up_required',
  NOT_FOUND: 'not_found',
  VALIDATION: 'validation_failed',
  RATE_LIMITED: 'rate_limited',
  IDEMPOTENCY_IN_FLIGHT: 'idempotency_in_flight',
  IDEMPOTENCY_CONFLICT: 'idempotency_conflict',
  CONFLICT: 'conflict',
  RESOURCE_PURGED: 'resource_purged',
  INTERNAL: 'internal_error',
  SERVICE_UNAVAILABLE: 'service_unavailable',
  SERIALIZATION_FAILURE: 'serialization_failure',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export type Retryability = 'retry' | 'no-retry' | 'retry-after';

export class ApiError extends HttpException {
  declare readonly code: ErrorCode;
  declare readonly details: unknown | undefined;
  readonly retryability: Retryability;
  readonly internalCause: unknown | undefined;

  constructor(
    status: HttpStatus,
    code: ErrorCode,
    message: string,
    details?: unknown,
    opts?: { retryability?: Retryability; cause?: unknown },
  ) {
    super({ code, message, details }, status);
    // Bypass HttpException's `cause` constructor param (Nest 11) by assigning via defineProperty
    Object.defineProperty(this, 'code', { value: code, enumerable: true });
    Object.defineProperty(this, 'details', { value: details, enumerable: true });
    this.retryability = opts?.retryability ?? (status >= 500 ? 'retry' : 'no-retry');
    this.internalCause = opts?.cause;
  }

  static unauthenticated(message = 'Authentication required'): ApiError {
    return new ApiError(HttpStatus.UNAUTHORIZED, ERROR_CODES.UNAUTHENTICATED, message);
  }

  static deniedByDefault(): ApiError {
    return new ApiError(
      HttpStatus.FORBIDDEN,
      ERROR_CODES.DENIED_BY_DEFAULT,
      'Route is not marked @Public() or @AuthLayer(...) — deny-by-default refuses anonymous access',
    );
  }

  static forbidden(message = 'Forbidden', details?: unknown): ApiError {
    return new ApiError(HttpStatus.FORBIDDEN, ERROR_CODES.FORBIDDEN, message, details);
  }

  static entitlementRequired(product: string): ApiError {
    return new ApiError(
      HttpStatus.FORBIDDEN,
      ERROR_CODES.ENTITLEMENT_REQUIRED,
      `This organization is not entitled to product "${product}"`,
      { product },
    );
  }

  static pastDue(product: string): ApiError {
    return new ApiError(
      HttpStatus.PAYMENT_REQUIRED,
      ERROR_CODES.PAST_DUE,
      `Payment required: entitlement for "${product}" is past due (read-only)`,
      { product },
    );
  }

  static stepUpRequired(): ApiError {
    return new ApiError(HttpStatus.UNAUTHORIZED, ERROR_CODES.STEP_UP_REQUIRED, 'A fresh MFA proof (X-MFA-Proof) is required for this action');
  }

  static notFound(what = 'resource'): ApiError {
    return new ApiError(HttpStatus.NOT_FOUND, ERROR_CODES.NOT_FOUND, `${what} not found`);
  }

  static validation(details: unknown): ApiError {
    return new ApiError(HttpStatus.BAD_REQUEST, ERROR_CODES.VALIDATION, 'Request validation failed', details);
  }

  static rateLimited(retryAfterSeconds: number): ApiError {
    return new ApiError(HttpStatus.TOO_MANY_REQUESTS, ERROR_CODES.RATE_LIMITED, 'Rate limit exceeded', { retry_after_seconds: retryAfterSeconds });
  }

  static conflict(message: string, details?: unknown): ApiError {
    return new ApiError(HttpStatus.CONFLICT, ERROR_CODES.CONFLICT, message, details, { retryability: 'no-retry' });
  }

  static serializationFailure(cause?: unknown): ApiError {
    return new ApiError(HttpStatus.CONFLICT, ERROR_CODES.SERIALIZATION_FAILURE, 'serialization failure, retry', undefined, {
      retryability: 'retry',
      cause,
    });
  }

  /** A backing subsystem (e.g. object storage) is not configured/reachable. */
  static unavailable(what: string): ApiError {
    return new ApiError(HttpStatus.SERVICE_UNAVAILABLE, ERROR_CODES.SERVICE_UNAVAILABLE, `${what} is unavailable`);
  }

  static internal(): ApiError {
    return new ApiError(HttpStatus.INTERNAL_SERVER_ERROR, ERROR_CODES.INTERNAL, 'Internal error');
  }
}
