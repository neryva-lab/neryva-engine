import { Injectable, NestMiddleware } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';

/**
 * Request-id propagation: honor an inbound X-Request-Id (clamped), else mint
 * one. Attached to the request for guards/audit correlation and echoed on the
 * response.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(request: FastifyRequest, response: FastifyReply, next: () => void): void {
    const inbound = request.headers['x-request-id'];
    const candidate = Array.isArray(inbound) ? inbound[0] : inbound;
    const requestId =
      candidate && /^[A-Za-z0-9_.:-]{8,64}$/.test(candidate) ? candidate : randomUUID();
    (request as FastifyRequest & { requestId: string }).requestId = requestId;
    response.header('x-request-id', requestId);
    next();
  }
}
