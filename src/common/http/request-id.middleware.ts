import { Injectable, NestMiddleware } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';

/**
 * Request-id propagation: ONE id per request across every plane — Fastify's
 * own request logs (via genReqId, ADR-008), the error envelope, audit
 * correlation. genReqId already honors/clamps an inbound X-Request-Id at
 * request creation, so its id is authoritative here; the inbound-header
 * path below only matters for non-Fastify-shaped requests (tests).
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(request: FastifyRequest & { id?: string }, response: FastifyReply, next: () => void): void {
    const requestId =
      typeof request.id === 'string' && /^[A-Za-z0-9_.:-]{8,64}$/.test(request.id)
        ? request.id
        : mintFromHeader(request.headers['x-request-id']);
    (request as FastifyRequest & { requestId: string }).requestId = requestId;
    // Under the Fastify adapter, global middleware runs through middie with
    // the RAW Node response (setHeader only) — not a FastifyReply (header).
    // Call whichever surface exists so the header survives both.
    const res = response as unknown as {
      header?: (name: string, value: string) => void;
      setHeader?: (name: string, value: string) => void;
    };
    if (typeof res.header === 'function') {
      res.header('x-request-id', requestId);
    } else if (typeof res.setHeader === 'function') {
      res.setHeader('x-request-id', requestId);
    }
    next();
  }
}

function mintFromHeader(inbound: string | string[] | undefined): string {
  const candidate = Array.isArray(inbound) ? inbound[0] : inbound;
  return candidate && /^[A-Za-z0-9_.:-]{8,64}$/.test(candidate) ? candidate : randomUUID();
}
