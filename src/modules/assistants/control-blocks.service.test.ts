/**
 * Phase 5 (blocks slice) — control-block set() validation: past-expiry
 * refusal, duplicate-active refusal, capability-name allowlist.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ControlBlocksService } from './control-blocks.service';

const ORG = '11111111-1111-4111-8111-111111111111';

function makeService(existing: unknown[] = []) {
  const inserted: unknown[] = [];
  const tx = {
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve(existing) }) }) }),
    insert: () => ({ values: (v: unknown) => ({ returning: () => { inserted.push(v); return Promise.resolve([{ id: 'block-1', ...(v as object) }]); } }) }),
  };
  const db = { withOrg: vi.fn(async (_orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn(tx)) };
  const audit = { add: vi.fn(async () => undefined) };
  const svc = new ControlBlocksService(db as never, audit as never);
  return { svc, db, audit, inserted };
}

const base = {
  orgId: ORG,
  targetType: 'assistant',
  targetName: 'asst-1',
  reason: 'test',
  actor: 'owner-1',
};

describe('ControlBlocksService.set validation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sets a valid block', async () => {
    const { svc, inserted } = makeService([]);
    const row = await svc.set({ ...base, expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    expect(row.id).toBe('block-1');
    expect(inserted).toHaveLength(1);
  });

  it('rejects a past expires_at', async () => {
    const { svc, db } = makeService([]);
    const err = await svc.set({ ...base, expiresAt: new Date(Date.now() - 1000).toISOString() }).catch((e) => e);
    expect(err.details).toMatchObject({ expires_at: expect.stringContaining('must be in the future') });
    expect(db.withOrg).not.toHaveBeenCalled();
  });

  it('rejects a duplicate active block for the same target', async () => {
    const { svc, inserted } = makeService([{ id: 'twin', targetType: 'assistant', targetName: 'asst-1', expiresAt: null }]);
    const err = await svc.set(base).catch((e) => e);
    expect(err.code).toBe('conflict');
    expect(String(err.message)).toContain('already exists');
    expect(inserted).toHaveLength(0);
  });

  it('allows re-setting after the previous block expired', async () => {
    const { svc, inserted } = makeService([]); // expired rows are not "active"
    await svc.set(base);
    expect(inserted).toHaveLength(1);
  });

  it.each(['tool', 'model:openai', 'model:anthropic'])('accepts capability name %s', async (targetName) => {
    const { svc, inserted } = makeService([]);
    await svc.set({ ...base, targetType: 'capability', targetName });
    expect(inserted).toHaveLength(1);
  });

  it.each(['web-browse', 'model:', 'model', 'TOOL'])('rejects capability name %s (silent no-op)', async (targetName) => {
    const { svc, db } = makeService([]);
    const err = await svc.set({ ...base, targetType: 'capability', targetName }).catch((e) => e);
    expect(err.details).toMatchObject({ target_name: expect.stringContaining('capability') });
    expect(db.withOrg).not.toHaveBeenCalled();
  });
});
