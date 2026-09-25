import { describe, it, expect } from 'vitest';
import { HttpStatus } from '@nestjs/common';
import { ApiError } from '../../src/common/http/api-error';
import { mapInputValidation, storedConfigForUpdate, ChannelsService } from '../../src/modules/channels/channels.service';

// `sanitizeConfig` is an instance method but touches no instance state —
// reach it through the prototype so the P5-C10 pass-through stays locked by
// a unit test without constructing the service's four dependencies.
const sanitizeConfig = (
  ChannelsService.prototype as unknown as {
    sanitizeConfig: (platform: string, config?: Record<string, unknown>) => Record<string, unknown>;
  }
).sanitizeConfig.bind({});

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

/**
 * P5-C9 regression: `sanitizeConfigForUpdate` returns a `{ platform, config }`
 * wrapper (the platform is needed for the routability check), but `update()`
 * stored the whole wrapper in the `config` column — so one PATCH of
 * `{config:{greeting}}` corrupted the account config into
 * `{config:{...}, platform:'web'}`, silently dropping `default_assistant_id`
 * and `allowed_domains` (widget mint then 409s "no assistant configured").
 * `storedConfigForUpdate` is the single mapping from the resolved wrapper to
 * the persisted value; this locks that mapping.
 */
describe('channel config update persistence (P5-C9)', () => {
  it('persists the merged ChannelConfig, not the {platform, config} wrapper', () => {
    const stored = storedConfigForUpdate({
      platform: 'web',
      config: {
        default_assistant_id: 'dfc4f780-d289-4a25-9825-53f7798e0086',
        allowed_domains: ['https://example.com'],
        greeting: 'hi there',
      },
    });
    expect(stored).toEqual({
      default_assistant_id: 'dfc4f780-d289-4a25-9825-53f7798e0086',
      allowed_domains: ['https://example.com'],
      greeting: 'hi there',
    });
    expect(stored).not.toHaveProperty('platform');
    expect(stored).not.toHaveProperty('config');
  });

  it('returns undefined when no config patch was supplied', () => {
    expect(storedConfigForUpdate(undefined)).toBeUndefined();
  });
});

/**
 * P5-C10 regression: `escalation_note`, `escalation_resolved_note`,
 * `quick_replies`, `csat_enabled`, `voice_replies_enabled` are declared in
 * the ChannelConfig schema and read by the outbound pipeline (escalation
 * lifecycle notes, FL-2.8 quick-reply chips / CSAT, FL-3.1 voice replies) —
 * but `sanitizeConfig` silently dropped them, so they could never be set via
 * create/PATCH and outbound always saw defaults. They are now clamped and
 * passed through; unknown keys are still dropped.
 */
describe('channel config passthrough keys (P5-C10)', () => {
  it('passes escalation notes, quick replies, csat and voice flags through', () => {
    const out = sanitizeConfig('whatsapp', {
      escalation_note: 'Connecting you with a human.',
      escalation_resolved_note: 'Welcome back.',
      quick_replies: ['Hours?', 'Pricing', 7, ''],
      csat_enabled: true,
      voice_replies_enabled: false,
      unknown_key: 'dropped',
    });
    expect(out.escalation_note).toBe('Connecting you with a human.');
    expect(out.escalation_resolved_note).toBe('Welcome back.');
    expect(out.quick_replies).toEqual(['Hours?', 'Pricing']);
    expect(out.csat_enabled).toBe(true);
    expect(out.voice_replies_enabled).toBe(false);
    expect(out).not.toHaveProperty('unknown_key');
  });

  it('clamps oversized values to the schema bounds', () => {
    const out = sanitizeConfig('web', {
      allowed_domains: ['https://example.com'],
      escalation_note: 'x'.repeat(600),
      quick_replies: Array.from({ length: 10 }, (_, i) => `chip-${i}-` + 'y'.repeat(100)),
    });
    expect((out.escalation_note as string).length).toBe(500);
    expect((out.quick_replies as string[]).length).toBe(6);
    expect((out.quick_replies as string[])[0].length).toBeLessThanOrEqual(64);
  });
});
