/**
 * EvalService unit tests (FL-2.21) — the service is wired to repository
 * ports, so every persistence collaborator is a fake port (no DB, no
 * network). Covers: eval-gate precedence (BLOCK > FAIL > WARN > PASS),
 * regression math with the TPL-7.5 bound message, candidate
 * promote/reject state transitions, and shadow-eval 24h dedup.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EvalService } from './eval.service';

const ORG = '11111111-1111-4111-8111-111111111111';
const DATASET_ID = '22222222-2222-4222-8222-222222222222';
const RUN_ID = '33333333-3333-4333-8333-333333333333';
const VERSION_ID = '44444444-4444-4444-8444-444444444444';
const ASSISTANT_ID = '55555555-5555-4555-8555-555555555555';
const CASE_ID = '77777777-7777-4777-8777-777777777777';
const SNAPSHOT_ID = '66666666-6666-4666-8666-666666666666';

interface MakeOpts {
  /** Template release policy (null = no template install → no policy). */
  policy?: unknown;
  runState?: string;
  prevScore?: string | null;
  versions?: Array<{ id: string; version: number; status: string }>;
  hasRecentShadow?: boolean;
}

function makeService(opts: MakeOpts = {}) {
  const auditCalls: Array<{ action: string; details: unknown }> = [];
  const audit = {
    add: vi.fn(async (input: { action: string; details?: unknown }) => {
      auditCalls.push({ action: input.action, details: input.details });
    }),
  };

  const runs = {
    findById: vi.fn(async () => ({
      id: RUN_ID,
      organizationId: ORG,
      state: opts.runState ?? 'pending',
      assistantVersionId: VERSION_ID,
      datasetId: DATASET_ID,
      policySnapshotId: null,
      attemptsPerCase: 1,
    })),
    completeIfOpen: vi.fn(async (_orgId: string, _runId: string, patch: { decision: string }) => ({
      id: RUN_ID,
      decision: patch.decision,
    })),
    latestCompletedRunScore: vi.fn(async () => opts.prevScore ?? null),
    listExecutedContentHashes: vi.fn(async () => [] as string[]),
    listCasesForHash: vi.fn(async () => [] as unknown[]),
    hasRecentShadowRun: vi.fn(async () => opts.hasRecentShadow ?? false),
    createWithOutboxEvent: vi.fn(async () => ({ id: '99999999-9999-4999-8999-999999999999' })),
    list: vi.fn(async () => []),
  };
  const versions = {
    getVersion: vi.fn(async () => ({
      id: VERSION_ID,
      assistantId: ASSISTANT_ID,
      version: 0,
      status: 'DRAFT',
      modelPolicy: {},
      contextPolicy: {},
      toolPolicy: { tools: [] },
      knowledgePolicy: null,
      guardrailPolicy: {},
    })),
    listVersions: vi.fn(async () => opts.versions ?? []),
  };
  const datasets = {
    findById: vi.fn(async () => ({ id: DATASET_ID, name: 'ds' })),
    findByName: vi.fn(async () => null as { id: string } | null),
    promoteCandidate: vi.fn(async () => ({ promotedCaseId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })),
    deleteCase: vi.fn(async () => true),
  };
  const templates = {
    getInstallByAssistantId: vi.fn(async () =>
      opts.policy === undefined
        ? null
        : { organizationId: ORG, slug: 't', templateVersion: '1.0.0' },
    ),
    getTemplateBySlugAndVersion: vi.fn(async () => ({
      slug: 't',
      version: '1.0.0',
      hash: 'h',
      releasePolicy: opts.policy ?? null,
    })),
  };
  const snapshots = {
    getSnapshot: vi.fn(async () => null),
    getSnapshotForVersion: vi.fn(async () => ({ id: SNAPSHOT_ID })),
  };
  const toolCatalog = {
    getTool: vi.fn(async () => null),
    listTools: vi.fn(async () => [] as Array<{ enabled: boolean }>),
  };
  const assistants = { getAssistant: vi.fn(async () => null) };
  const configPublish = { latest: vi.fn(async () => null) };
  const retrieval = {};

  const svc = new EvalService(
    datasets as never,
    runs as never,
    assistants as never,
    versions as never,
    snapshots as never,
    templates as never,
    toolCatalog as never,
    audit as never,
    retrieval as never,
    configPublish as never,
  );
  return { svc, runs, versions, datasets, templates, snapshots, toolCatalog, audit, auditCalls };
}

const results = (
  passed: boolean[],
  extra: Record<string, unknown> = {},
) => ({
  cases: passed.map((p, i) => ({
    case_id: `c${i}`,
    attempt: 1,
    passed: p,
    score: p ? 1 : 0,
  })),
  ...extra,
});

const completeInput = (body: Record<string, unknown>) => ({
  orgId: ORG,
  evalRunId: RUN_ID,
  results: body,
  actor: 'owner-1',
});

/**
 * completeRun returns Promise<unknown>, so a bare `.catch((e) => e)` leaves
 * the error untyped under strict mode — normalize to the ApiError shape.
 */
const catchErr = (p: Promise<unknown>): Promise<{ code: string; details?: unknown }> =>
  p.then(
    () => {
      throw new Error('expected rejection');
    },
    (e) => e as { code: string; details?: unknown },
  );

describe('EvalService.completeRun decision precedence', () => {
  beforeEach(() => vi.clearAllMocks());

  it('PASS when every case passes and the policy is empty', async () => {
    const { svc } = makeService();
    const out = (await svc.completeRun(completeInput(results([true, true, true])))) as {
      decision: string;
    };
    expect(out.decision).toBe('PASS');
  });

  it('FAIL outranks PASS when a case fails (A2-80)', async () => {
    const { svc } = makeService();
    const out = (await svc.completeRun(completeInput(results([true, false])))) as {
      decision: string;
    };
    expect(out.decision).toBe('FAIL');
  });

  it('BLOCK outranks FAIL on a critical failure', async () => {
    const { svc, auditCalls } = makeService({
      policy: { critical_failures: ['data_leak'] },
    });
    const out = (await svc.completeRun(
      completeInput(results([true, false], { critical_failures: ['data_leak'] })),
    )) as { decision: string };
    expect(out.decision).toBe('BLOCK');
    const details = auditCalls.find((c) => c.action === 'template.version_evaluated')
      ?.details as { block_reasons: string[] };
    expect(details.block_reasons).toContain('critical failure: data_leak');
  });

  it('BLOCK on a failed required worker check', async () => {
    const { svc } = makeService({ policy: { required: ['worker_check'] } });
    const out = (await svc.completeRun(
      completeInput(
        results([true, true], { checks: [{ name: 'worker_check', passed: false }] }),
      ),
    )) as { decision: string };
    expect(out.decision).toBe('BLOCK');
  });

  it('BLOCK on an unevaluated required check (fail-closed)', async () => {
    const { svc } = makeService({ policy: { required: ['never_run'] } });
    const out = (await svc.completeRun(completeInput(results([true, true])))) as {
      decision: string;
    };
    expect(out.decision).toBe('BLOCK');
  });

  it('WARN on an unevaluated threshold, never invented', async () => {
    const { svc, auditCalls } = makeService({
      policy: { thresholds: { groundedness: 0.9 } },
    });
    const out = (await svc.completeRun(completeInput(results([true, true])))) as {
      decision: string;
    };
    expect(out.decision).toBe('WARN');
    const details = auditCalls.find((c) => c.action === 'template.version_evaluated')
      ?.details as { warnings: string[] };
    expect(details.warnings).toContain('threshold groundedness unevaluated (no worker metric)');
  });

  it('FAIL outranks WARN', async () => {
    const { svc } = makeService({ policy: { thresholds: { groundedness: 0.9 } } });
    const out = (await svc.completeRun(completeInput(results([true, false])))) as {
      decision: string;
    };
    expect(out.decision).toBe('FAIL');
  });

  it('BLOCK outranks WARN', async () => {
    const { svc } = makeService({
      policy: { critical_failures: ['data_leak'], thresholds: { groundedness: 0.9 } },
    });
    const out = (await svc.completeRun(
      completeInput(results([true, true], { critical_failures: ['data_leak'] })),
    )) as { decision: string };
    expect(out.decision).toBe('BLOCK');
  });

  it('conflicts on a run that is not open', async () => {
    const { svc, runs } = makeService({ runState: 'completed' });
    const err = await catchErr(svc.completeRun(completeInput(results([true]))));
    expect(err.code).toBe('conflict');
    expect(runs.completeIfOpen).not.toHaveBeenCalled();
  });

  it('404s on an unknown run', async () => {
    const { svc, runs } = makeService();
    runs.findById.mockResolvedValueOnce(null as never);
    const err = await catchErr(svc.completeRun(completeInput(results([true]))));
    expect(err.code).toBe('not_found');
  });
});

describe('EvalService.completeRun regression (TPL-7.5)', () => {
  beforeEach(() => vi.clearAllMocks());

  const published = [{ id: 'pub-1', version: 1, status: 'PUBLISHED' }];

  it('BLOCKs with the exact bound message when the delta exceeds the bound', async () => {
    const { svc, auditCalls } = makeService({
      policy: { regression_no_worse_than: 0.05 },
      versions: published,
      prevScore: '0.9',
    });
    // 4/5 pass → score 0.8; delta 0.1 > bound 0.05.
    const out = (await svc.completeRun(
      completeInput(results([true, true, true, true, false])),
    )) as { decision: string };
    expect(out.decision).toBe('BLOCK');
    const details = auditCalls.find((c) => c.action === 'template.version_evaluated')
      ?.details as { block_reasons: string[] };
    expect(details.block_reasons).toContain(
      'regression 0.1000 exceeds bound 0.05 (previous score 0.9)',
    );
  });

  it('does not block when the delta is within the bound', async () => {
    const { svc } = makeService({
      policy: { regression_no_worse_than: 0.05 },
      versions: published,
      prevScore: '0.97',
    });
    const out = (await svc.completeRun(completeInput(results([true, true])))) as {
      decision: string;
    };
    expect(out.decision).toBe('PASS');
  });

  it('skips the regression check when there is no previous score', async () => {
    const { svc, runs } = makeService({
      policy: { regression_no_worse_than: 0.05 },
      versions: published,
      prevScore: null,
    });
    const out = (await svc.completeRun(completeInput(results([true, true])))) as {
      decision: string;
    };
    expect(out.decision).toBe('PASS');
    expect(runs.latestCompletedRunScore).toHaveBeenCalled();
  });
});

describe('EvalService candidate promote/reject', () => {
  beforeEach(() => vi.clearAllMocks());

  const candidateName = 'template:slug@1.0.0:candidates';
  const targetId = '88888888-8888-4888-8888-888888888888';

  it('promotes a candidate case and audits', async () => {
    const { svc, datasets, auditCalls } = makeService();
    datasets.findById.mockResolvedValueOnce({ id: DATASET_ID, name: candidateName });
    datasets.findByName.mockResolvedValueOnce({ id: targetId });
    const out = await svc.promoteCandidateCase({
      orgId: ORG,
      datasetId: DATASET_ID,
      caseId: CASE_ID,
      actor: 'owner-1',
    });
    expect(out.promoted_case_id).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(datasets.promoteCandidate).toHaveBeenCalledWith(ORG, DATASET_ID, targetId, CASE_ID);
    expect(auditCalls.some((c) => c.action === 'eval.case_promoted')).toBe(true);
  });

  it('refuses promote from a non-candidate dataset', async () => {
    const { svc, datasets } = makeService();
    datasets.findById.mockResolvedValueOnce({ id: DATASET_ID, name: 'plain-dataset' });
    const err = await catchErr(
      svc.promoteCandidateCase({
        orgId: ORG,
        datasetId: DATASET_ID,
        caseId: CASE_ID,
        actor: 'owner-1',
      }),
    );
    expect(err.code).toBe('validation_failed');
    expect(datasets.promoteCandidate).not.toHaveBeenCalled();
  });

  it('conflicts when the candidate target dataset is missing', async () => {
    const { svc, datasets } = makeService();
    datasets.findById.mockResolvedValueOnce({ id: DATASET_ID, name: candidateName });
    datasets.findByName.mockResolvedValueOnce(null);
    const err = await catchErr(
      svc.promoteCandidateCase({
        orgId: ORG,
        datasetId: DATASET_ID,
        caseId: CASE_ID,
        actor: 'owner-1',
      }),
    );
    expect(err.code).toBe('conflict');
  });

  it('rejects a candidate case and audits', async () => {
    const { svc, datasets, auditCalls } = makeService();
    datasets.findById.mockResolvedValueOnce({ id: DATASET_ID, name: candidateName });
    const out = await svc.rejectCandidateCase({
      orgId: ORG,
      datasetId: DATASET_ID,
      caseId: CASE_ID,
      actor: 'owner-1',
    });
    expect(out).toEqual({ ok: true });
    expect(datasets.deleteCase).toHaveBeenCalledWith(ORG, DATASET_ID, CASE_ID);
    expect(auditCalls.some((c) => c.action === 'eval.case_rejected')).toBe(true);
  });

  it('refuses reject from a non-candidate dataset', async () => {
    const { svc, datasets } = makeService();
    datasets.findById.mockResolvedValueOnce({ id: DATASET_ID, name: 'plain-dataset' });
    const err = await catchErr(
      svc.rejectCandidateCase({
        orgId: ORG,
        datasetId: DATASET_ID,
        caseId: CASE_ID,
        actor: 'owner-1',
      }),
    );
    expect(err.code).toBe('validation_failed');
    expect(datasets.deleteCase).not.toHaveBeenCalled();
  });
});

describe('EvalService.startShadowEval dedup', () => {
  beforeEach(() => vi.clearAllMocks());

  const input = {
    orgId: ORG,
    assistantId: ASSISTANT_ID,
    versionId: VERSION_ID,
    drifted: [{ alias: 'openai/gpt-4o' }],
  };

  it('dedupes when a shadow run exists in the last 24h', async () => {
    const { svc, runs } = makeService({ hasRecentShadow: true });
    const out = await svc.startShadowEval(input);
    expect(out).toEqual({ status: 'deduped' });
    expect(runs.createWithOutboxEvent).not.toHaveBeenCalled();
  });

  it('returns no_dataset when no template dataset exists', async () => {
    const { svc, runs } = makeService({ hasRecentShadow: false });
    // No template install → resolveTemplateDataset returns null.
    const out = await svc.startShadowEval(input);
    expect(out).toEqual({ status: 'no_dataset' });
    expect(runs.createWithOutboxEvent).not.toHaveBeenCalled();
  });

  it('starts a shadow run when due', async () => {
    const { svc, runs, datasets } = makeService({
      hasRecentShadow: false,
      policy: {}, // any install so resolveTemplateDataset proceeds
    });
    datasets.findByName.mockResolvedValueOnce({ id: DATASET_ID });
    const out = await svc.startShadowEval(input);
    expect(out.status).toBe('started');
    expect(runs.createWithOutboxEvent).toHaveBeenCalledTimes(1);
    const call = runs.createWithOutboxEvent.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(call[1].isShadow).toBe(true);
  });
});
