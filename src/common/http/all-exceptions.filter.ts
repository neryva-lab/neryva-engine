import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ApiError } from './api-error';
import { asReplySurface } from './reply-surface';
import { captureEngineError } from '../observability/sentry';

/**
 * One envelope for every error: validation, guards, domain errors, and the
 * unknown-exception path. request_id propagates from the middleware so a
 * client can correlate an error with the server log line.
 *
 * Sentry capture (ADR-008): domain ApiErrors never report (client outcomes,
 * not defects); unknown exceptions and 5xx HttpExceptions do, with the
 * request id attached so the issue links back to logs and traces.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    // Raw ServerResponse under middie/getResponse paths, FastifyReply under
    // @Res() — the adapter normalizes both (see reply-surface.ts).
    const response = asReplySurface(ctx.getResponse());
    const request = ctx.getRequest<{ requestId?: string; url?: string }>();

    const requestId = request?.requestId ?? 'unknown';

    if (exception instanceof ApiError) {
      const body = exception.getResponse() as { code: string; message: string; details?: unknown };
      void response.status(exception.getStatus()).send({
        error: {
          code: body.code,
          message: body.message,
          ...(body.details !== undefined ? { details: body.details } : {}),
          request_id: requestId,
        },
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      if (status >= 500) {
        captureEngineError(exception, { requestId, route: request?.url });
      }
      const payload = exception.getResponse();
      const message = typeof payload === 'string' ? payload : ((payload as { message?: string | string[] }).message ?? HttpStatus[status] ?? 'error');
      const details = typeof payload === 'object' && payload !== null && 'message' in payload && Array.isArray((payload as { message: unknown }).message)
        ? { issues: (payload as { message: string[] }).message }
        : undefined;
      void response.status(status).send({
        error: {
          code: status === HttpStatus.BAD_REQUEST ? 'validation_failed' : status === HttpStatus.UNAUTHORIZED ? 'unauthenticated' : 'http_error',
          message: typeof message === 'string' ? message : 'Request failed',
          ...(details ? { details } : {}),
          request_id: requestId,
        },
      });
      return;
    }

    // Unknown: log with stack, return a clean 500. Never leak internals.
    const err = exception as { message?: string; stack?: string };
    this.logger.error(`unhandled exception req=${requestId}: ${err?.message ?? String(exception)}`, err?.stack);
    captureEngineError(exception, { requestId, route: request?.url });
    void response.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
      error: {
        code: 'internal_error',
        message: 'Internal error',
        request_id: requestId,
      },
    });
  }
}
