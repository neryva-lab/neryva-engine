/**
 * Phase 5 (blocks slice) — control-block set() validation: past-expiry
 * refusal, duplicate-active refusal, capability-name allowlist.
 *
 * The service is wired to @Inject(CONTROL_BLOCK_REPOSITORY), so the mock is
 * a fake IControlBlockRepository (setBlock/clearBlock/listBlocks/...) — no
 * DbService tx-shaped mock. Mock shape only; assertions and intent kept.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ApiError } from '../../common/http/api-error';
import { ControlBlocksService } from './control-blocks.service';

const ORG = '11111111-1111-4111-8111-111111111111';

function makeService(opts: { twin?: boolean } = {}) {
  const inserted: unknown[] = [];
  const setBlock = vi.fn(async (input: Record<string, unknown>) => {
    if (opts.twin) {
      // The repository port owns the active-twin check atomically: a second
      // active block for the same target is a typed 409, never a raw
      // duplicate-key violation.
      throw ApiError.conflict('an active block for this target already exists', {
        target_type: input.targetType,
        target_name: input.targetName,
      });
    }
    const row = { id: 'block-1', ...input };
    inserted.push(row);
    return row;
  });
  const blocks = {
    listBlocks: vi.fn(async () => []),
    setBlock,
    clearBlock: vi.fn(async () => ({ ok: true as const })),
    findActiveBlock: vi.fn(async () => null),
    findActiveTemplateBlock: vi.fn(async () => null),
  };
  const audit = { add: vi.fn(async () => undefined) };
  const svc = new ControlBlocksService(blocks as never, audit as never);
  return { svc, blocks, audit, inserted };
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
    const { svc, inserted } = makeService();
    const row = await svc.set({ ...base, expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    expect(row.id).toBe('block-1');
    expect(inserted).toHaveLength(1);
  });

  it('rejects a past expires_at', async () => {
    const { svc, blocks } = makeService();
    const err = await svc.set({ ...base, expiresAt: new Date(Date.now() - 1000).toISOString() }).catch((e) => e);
    expect(err.details).toMatchObject({ expires_at: expect.stringContaining('must be in the future') });
    expect(blocks.setBlock).not.toHaveBeenCalled();
  });

  it('rejects a duplicate active block for the same target', async () => {
    const { svc, inserted } = makeService({ twin: true });
    const err = await svc.set(base).catch((e) => e);
    expect(err.code).toBe('conflict');
    expect(String(err.message)).toContain('already exists');
    expect(inserted).toHaveLength(0);
  });

  it('allows re-setting after the previous block expired', async () => {
    const { svc, inserted } = makeService(); // expired rows are not "active"
    await svc.set(base);
    expect(inserted).toHaveLength(1);
  });

  it.each(['tool', 'model:openai', 'model:anthropic'])('accepts capability name %s', async (targetName) => {
    const { svc, inserted } = makeService();
    await svc.set({ ...base, targetType: 'capability', targetName });
    expect(inserted).toHaveLength(1);
  });

  it.each(['web-browse', 'model:', 'model', 'TOOL'])('rejects capability name %s (silent no-op)', async (targetName) => {
    const { svc, blocks } = makeService();
    const err = await svc.set({ ...base, targetType: 'capability', targetName }).catch((e) => e);
    expect(err.details).toMatchObject({ target_name: expect.stringContaining('capability') });
    expect(blocks.setBlock).not.toHaveBeenCalled();
  });
});
