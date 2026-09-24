import { describe, it, expect } from 'vitest';
import { HttpStatus } from '@nestjs/common';
import { ApiError } from '../../src/common/http/api-error';
import { mapInputValidation } from '../../src/modules/channels/channels.service';

/**
 * P5-C6 regression: assertCredentialsShape / assertAllowedDomainFormat threw
 * plain Errors, which Fastify rendered as HTTP 500 for customer input
 * problems (malformed credentials, unsupported platform, bad web origin).
 * The service now maps them to 400 validation errors the console can explain.
 */
describe('channel input validation mapping (P5-C6)', () => {
  it('maps a plain Error to 400 validation', () => {
    let caught: unknown;
    try {
      mapInputValidation(new Error('whatsapp credentials require app_secret (64 hex chars)'));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiError);
    const api = caught as ApiError;
    expect(api.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect((api.getResponse() as { code?: string }).code).toBe('validation_failed');
  });

  it('lets ApiErrors pass through untouched', () => {
    const original = ApiError.conflict('a channel with this name already exists for this platform');
    let caught: unknown;
    try {
      mapInputValidation(original);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(original);
  });

  it('carries the original message in details', () => {
    let caught: unknown;
    try {
      mapInputValidation(new Error('unsupported channel platform x'));
    } catch (e) {
      caught = e;
    }
    const body = (caught as ApiError).getResponse() as { details?: { input?: string } };
    expect(body.details?.input).toContain('unsupported channel platform x');
  });
});
