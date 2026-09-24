/**
 * Phase 5 webhooks (P5-W7): delivery-time SSRF re-check.
 * `recheckWebhookTarget` must apply the same block rules as the create-time
 * `checkWebhookUrl`, but with a FRESH lookup every call (no cache) so DNS
 * drift/rebinding after registration cannot smuggle a blocked target past
 * the guard. These tests use loopback targets only — no external DNS needed.
 */
import { describe, expect, it } from 'vitest';
import { checkWebhookUrl, recheckWebhookTarget } from './webhook-url.guard';

describe('recheckWebhookTarget (delivery-time, uncached)', () => {
  it('blocks a literal loopback IPv4 target', async () => {
    const res = await recheckWebhookTarget('https://127.0.0.1:9/hook');
    expect(res.ok).toBe(false);
  });

  it('blocks a hostname that resolves to loopback (fresh lookup, no cache)', async () => {
    // localhost -> 127.0.0.1 / ::1 here; a cached create-time verdict must
    // not be trusted at delivery time.
    const res = await recheckWebhookTarget('https://localhost:9/hook');
    expect(res.ok).toBe(false);
  });

  it('blocks metadata/link-local targets', async () => {
    const res = await recheckWebhookTarget('https://169.254.169.254/latest');
    expect(res.ok).toBe(false);
  });

  it('rejects credentials embedded in the URL', async () => {
    const res = await recheckWebhookTarget('https://user:pass@example.com/hook');
    expect(res.ok).toBe(false);
  });

  it('agrees with the create-time check on blocked targets', async () => {
    const blocked = ['https://127.0.0.1:9/hook', 'https://localhost:9/hook'];
    for (const url of blocked) {
      const [atCreate, atDelivery] = await Promise.all([checkWebhookUrl(url), recheckWebhookTarget(url)]);
      expect(atCreate.ok).toBe(false);
      expect(atDelivery.ok).toBe(false);
    }
  });
});
