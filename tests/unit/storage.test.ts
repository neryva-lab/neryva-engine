import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { StorageService } from '../../src/common/infra/storage/storage.service';
import { ApiError } from '../../src/common/http/api-error';
import { env } from '../../src/common/config/env';

/**
 * A2-22: unconfigured object storage must surface as a typed 503
 * (service_unavailable), not a generic Error that the framework renders as
 * a 500 "Internal error".
 */
describe('StorageService.requireAvailable (A2-22)', () => {
  const saved = { ...env };
  const service = new StorageService();

  beforeEach(() => {
    env.S3_BUCKET = '';
    env.S3_REGION = '';
    env.S3_ACCESS_KEY_ID = '';
    env.S3_SECRET_ACCESS_KEY = '';
  });

  afterEach(() => {
    env.S3_BUCKET = saved.S3_BUCKET;
    env.S3_REGION = saved.S3_REGION;
    env.S3_ACCESS_KEY_ID = saved.S3_ACCESS_KEY_ID;
    env.S3_SECRET_ACCESS_KEY = saved.S3_SECRET_ACCESS_KEY;
  });

  it('reports unavailable (false) when S3_* is unconfigured', () => {
    expect(service.available).toBe(false);
  });

  it('throws a typed 503 service_unavailable naming the backend', () => {
    let caught: unknown;
    try {
      service.requireAvailable();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiError);
    const err = caught as ApiError;
    expect(err.getStatus()).toBe(503);
    expect(err.code).toBe('service_unavailable');
    expect(String(err.message)).toMatch(/object storage/i);
  });

  it('does not throw when fully configured', () => {
    env.S3_BUCKET = 'test-bucket';
    env.S3_REGION = 'us-east-1';
    env.S3_ACCESS_KEY_ID = 'test-key';
    env.S3_SECRET_ACCESS_KEY = 'test-secret';
    expect(service.available).toBe(true);
    expect(() => service.requireAvailable()).not.toThrow();
  });
});
