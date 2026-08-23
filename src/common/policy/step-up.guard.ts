import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FastifyRequest } from 'fastify';
import { ApiError } from '../http/api-error';
import { MFA_PROOF_HEADER, verifyMfaProof } from '../auth/mfa-proof';
import { Principal } from '../auth/principal';

export const STEP_UP_KEY = 'stepUpMfa';

/**
 * Step-up MFA on privileged acts (access-model): role assignment, ownership
 * transfer, org deletion, purchases, key creation with wildcard scopes.
 * Uses `RequireStepUp()` on the route; only L1 principals can hold proofs
 * (L2/L3 callers receive a clear 403 — API keys can never escalate, the
 * code-level equivalent of Anthropic's "owner/admin not assignable via API").
 */
export const RequireStepUp = (): MethodDecorator & ClassDecorator => SetMetadata(STEP_UP_KEY, true);

@Injectable()
export class StepUpGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required =
      this.reflector.getAllAndOverride<boolean>(STEP_UP_KEY, [context.getHandler(), context.getClass()]) ?? false;
    if (!required) {
      return true;
    }
    const request = context.switchToHttp().getRequest<FastifyRequest & { principal?: Principal }>();
    const principal = request.principal;
    if (!principal) {
      throw ApiError.unauthenticated();
    }
    if (principal.kind !== 'l1') {
      throw ApiError.forbidden('Step-up MFA proofs exist only for console sessions (L1)');
    }
    const header = request.headers[MFA_PROOF_HEADER];
    const proof = Array.isArray(header) ? header[0] : header;
    const result = verifyMfaProof(proof, principal.id);
    if (!result.valid) {
      throw ApiError.stepUpRequired();
    }
    return true;
  }
}
