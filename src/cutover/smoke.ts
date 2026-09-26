#!/usr/bin/env tsx
/**
 * Post-flip HTTP smoke test for the MongoDB cutover.
 *
 * Proves a flipped engine (DB_PROVIDER=mongodb) serves real traffic end to
 * end: health → real OIDC/PKCE email-code login → create org → create +
 * publish assistant → create conversation → send message → run reaches
 * COMPLETED → knowledge search answers (proves the resolved vector search
 * backend works).
 *
 * Each step prints PASS/FAIL. The script exits non-zero on the FIRST
 * failure (fail-fast), so CI/red-green is unambiguous.
 *
 * Configuration (environment):
 *   SMOKE_ENGINE       Engine base URL. Default: http://localhost:3001
 *   SMOKE_EMAIL        (required) Login email. The account must exist; in
 *                      dev/staging the 8-digit code is read from the local
 *                      file outbox (SMOKE_OUTBOX_DIR), exactly like the
 *                      console-marathon harness api-auth.mjs flow.
 *   SMOKE_OUTBOX_DIR   File-outbox directory for the email code.
 *                      Default: <repo>/var/outbox
 *   SMOKE_RUN_TIMEOUT_MS  How long to poll a run for terminal status.
 *                      Default: 120000
 *
 * Honest limitations (not hidden):
 * - The run only reaches COMPLETED when the Agent Studio runtime is up and
 *   the engine's outbox dispatcher can deliver StartRun (NERYVA_RUNTIME_BASE_URL
 *   set). Otherwise the run stays ACCEPTED and the script FAILs the step
 *   with the last observed status — that is a real signal, not a script bug.
 * - Knowledge: a full document ingest needs object storage + the ingestion
 *   worker; the smoke proves the search path instead (the resolved backend
 *   answers without error). Ingest-one-then-query is a manual follow-up.
 * - No credentials are invented: SMOKE_EMAIL must be a real account, and
 *   the script reuses the production OIDC login flow, not a backdoor.
 *
 * Run:  npx tsx src/cutover/smoke.ts
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ENGINE = (process.env.SMOKE_ENGINE ?? 'http://localhost:3001').replace(/\/+$/, '');
const EMAIL = process.env.SMOKE_EMAIL ?? '';
const OUTBOX_DIR =
  process.env.SMOKE_OUTBOX_DIR ?? path.join(__dirname, '..', '..', 'var', 'outbox');
const RUN_TIMEOUT_MS = Number(process.env.SMOKE_RUN_TIMEOUT_MS ?? '120000');
const REDIRECT_URI = 'http://localhost:3000/platform/auth/callback';

if (!EMAIL) {
  console.error('FAIL config: SMOKE_EMAIL is required (no credentials are invented by this script)');
  process.exit(2);
}

interface ApiResult {
  status: number;
  json: unknown;
  text: string;
}

let failures = 0;

function step(name: string): void {
  process.stdout.write(`[....] ${name} ... `);
}
function pass(detail = ''): void {
  console.log(`PASS${detail ? ` (${detail})` : ''}`);
}
function fail(detail: string): never {
  failures += 1;
  console.log(`FAIL (${detail})`);
  process.exit(1);
}

async function api(
  method: string,
  p: string,
  token: string | null,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<ApiResult> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(extraHeaders ?? {}),
  };
  const res = await fetch(`${ENGINE}${p}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, json, text };
}

const b64url = (b: Buffer): string => b.toString('base64url');
const idem = (suffix: string): string =>
  `smoke-${Date.now().toString(36)}-${suffix}`.slice(0, 64);

/** Real OIDC/PKCE email-code login (same flow as the marathon harness api-auth.mjs). */
async function login(email: string): Promise<string> {
  const jar = new Map<string, string>();
  const store = (res: Response): void => {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      jar.set(pair.slice(0, i).trim(), pair.slice(i + 1));
    }
  };
  const cookie = (): string =>
    [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  let r = await fetch(
    `${ENGINE}/auth/auth?` +
      new URLSearchParams({
        client_id: 'neryva-console',
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        scope: 'openid email profile offline_access',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: b64url(crypto.randomBytes(16)),
      }),
    { redirect: 'manual' },
  );
  store(r);
  const location = r.headers.get('location');
  if (!location) throw new Error(`authorize did not redirect (status ${r.status})`);
  const uid = new URL(location, ENGINE).pathname.split('/').pop() ?? '';

  r = await fetch(new URL(location, ENGINE).href, { redirect: 'manual' });
  store(r);
  r = await fetch(`${ENGINE}/login/${uid}/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookie() },
    body: new URLSearchParams({ email }),
    redirect: 'manual',
  });
  store(r);
  if (r.status !== 200) throw new Error(`email submit returned ${r.status}: ${await r.text().catch(() => '')}`);

  let code: string | null = null;
  for (let i = 0; i < 30 && !code; i++) {
    await new Promise((rr) => setTimeout(rr, 1000));
    let files: string[] = [];
    try {
      files = fs.readdirSync(OUTBOX_DIR).sort().reverse();
    } catch {
      /* outbox dir missing — keep polling */
    }
    for (const f of files) {
      const body = fs.readFileSync(path.join(OUTBOX_DIR, f), 'utf8');
      if (body.toLowerCase().includes(email.toLowerCase())) {
        const m = body.match(/\b(\d{8})\b/);
        if (m) {
          code = m[1];
          break;
        }
      }
    }
  }
  if (!code) throw new Error(`no email code observed for ${email} in ${OUTBOX_DIR}`);

  r = await fetch(`${ENGINE}/login/${uid}/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookie() },
    body: new URLSearchParams({ email, code }),
    redirect: 'manual',
  });
  store(r);
  let next = r.headers.get('location');
  if (!next) throw new Error(`verify did not redirect (status ${r.status})`);
  let authCode: string | null = null;
  for (let i = 0; i < 10 && !authCode; i++) {
    const u = new URL(next, ENGINE);
    if (next.startsWith(REDIRECT_URI)) {
      authCode = u.searchParams.get('code');
      break;
    }
    r = await fetch(u.href, { redirect: 'manual', headers: { cookie: cookie() } });
    store(r);
    const loc = r.headers.get('location');
    if (!loc) throw new Error(`login redirect chain broke (status ${r.status})`);
    next = new URL(loc, ENGINE).href;
  }
  if (!authCode) throw new Error('no authorization code after verify');

  r = await fetch(`${ENGINE}/auth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authCode,
      redirect_uri: REDIRECT_URI,
      client_id: 'neryva-console',
      code_verifier: verifier,
    }),
  });
  const tok = (await r.json()) as { refresh_token?: string; access_token?: string };
  const refresh = tok.refresh_token;
  if (!refresh) throw new Error(`no refresh_token: ${JSON.stringify(tok).slice(0, 200)}`);

  r = await fetch(`${ENGINE}/auth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: 'neryva-console',
    }),
  });
  const tok2 = (await r.json()) as { access_token?: string };
  if (!tok2.access_token) throw new Error(`no access_token: ${JSON.stringify(tok2).slice(0, 200)}`);
  return tok2.access_token;
}

function asRecord(v: unknown): Record<string, unknown> {
  return (v ?? {}) as Record<string, unknown>;
}

async function main(): Promise<void> {
  // 1. Health
  step('health /health/live + /health/ready');
  {
    const live = await fetch(`${ENGINE}/health/live`);
    const ready = await fetch(`${ENGINE}/health/ready`);
    if (live.status !== 200 || ready.status !== 200) {
      fail(`live=${live.status} ready=${ready.status}`);
    }
    pass(`live=${live.status} ready=${ready.status}`);
  }

  // 2. Real auth
  step(`OIDC email-code login as ${EMAIL}`);
  let token: string;
  try {
    token = await login(EMAIL);
  } catch (err) {
    fail((err as Error).message);
  }
  pass('access token issued');

  // 3. Create org
  step('create org');
  const slug = `smoke-${Date.now().toString(36)}`;
  let orgId: string;
  {
    const res = await api('POST', '/console/org', token, { name: `Smoke ${slug}`, slug }, { 'x-idempotency-key': idem('org') });
    const org = asRecord(asRecord(res.json).org);
    if ((res.status !== 200 && res.status !== 201) || typeof org.orgId !== 'string') {
      fail(`status=${res.status} body=${res.text.slice(0, 200)}`);
    }
    orgId = org.orgId as string;
    pass(`orgId=${orgId}`);
  }

  // 4. Create assistant (proven definition shape from the marathon seed)
  step('create assistant');
  let assistantId: string;
  let versionId: string;
  {
    const definition = {
      instructions: 'You are the cutover smoke assistant. Be concise.',
      model_params: { temperature: 0.2, max_output_tokens: 1024 },
      budget_policy: { max_total_tokens: 200000, wall_clock_seconds: 180, max_tool_calls: 8, max_model_calls: 16 },
      model_policy: { allowed_models: ['openai/gpt-4o-mini'], fallback_enabled: false },
      context_policy: { history_limit: 20, summary_enabled: true, knowledge_sources: [], memory_scope: 'user' },
      tool_policy: { tools: [] },
      knowledge_policy: { retrieval_enabled: false, max_results: 5 },
      guardrail_policy: { input_policy: 'default', output_policy: 'default', pii_redaction: true },
    };
    const res = await api('POST', `/console/org/${orgId}/assistants`, token, { name: `Smoke ${slug}`, definition }, { 'x-idempotency-key': idem('asst') });
    const body = asRecord(res.json);
    const asst = asRecord(body.assistant);
    if ((res.status !== 200 && res.status !== 201) || typeof asst.id !== 'string' || typeof body.version_id !== 'string') {
      fail(`status=${res.status} body=${res.text.slice(0, 200)}`);
    }
    assistantId = asst.id as string;
    versionId = body.version_id as string;
    pass(`assistantId=${assistantId}`);
  }

  // 5. Publish
  step('publish assistant version');
  {
    const res = await api('POST', `/console/org/${orgId}/assistants/${assistantId}/versions/${versionId}/publish`, token, {}, { 'x-idempotency-key': idem('pub') });
    if (res.status !== 200 && res.status !== 201 && res.status !== 409) {
      fail(`status=${res.status} body=${res.text.slice(0, 200)}`);
    }
    pass(`status=${res.status}`);
  }

  // 6. Create conversation
  step('create conversation');
  let conversationId: string;
  {
    const res = await api('POST', `/console/org/${orgId}/conversations`, token, { assistant_id: assistantId }, { 'x-idempotency-key': idem('conv') });
    const conv = asRecord(asRecord(res.json).conversation);
    if ((res.status !== 200 && res.status !== 201) || typeof conv.id !== 'string') {
      fail(`status=${res.status} body=${res.text.slice(0, 200)}`);
    }
    conversationId = conv.id as string;
    pass(`conversationId=${conversationId}`);
  }

  // 7. Send message → run
  step('send message');
  let runId: string;
  {
    const res = await api('POST', `/console/org/${orgId}/conversations/${conversationId}/messages`, token, {
      content: { text: 'Cutover smoke probe: reply with the word SMOKE-OK.' },
      idempotency_key: idem('msg'),
    });
    const body = asRecord(res.json);
    if ((res.status !== 200 && res.status !== 201) || typeof body.run_id !== 'string') {
      fail(`status=${res.status} body=${res.text.slice(0, 200)}`);
    }
    runId = body.run_id as string;
    pass(`runId=${runId}`);
  }

  // 8. Poll run to terminal
  step(`run reaches COMPLETED (timeout ${RUN_TIMEOUT_MS}ms)`);
  {
    const terminal = new Set(['COMPLETED', 'FAILED', 'CANCELED', 'EXPIRED']);
    const deadline = Date.now() + RUN_TIMEOUT_MS;
    let status = '';
    for (;;) {
      const res = await api('GET', `/console/org/${orgId}/runs/${runId}`, token);
      const run = asRecord(asRecord(res.json).run);
      status = typeof run.status === 'string' ? run.status : '';
      if (terminal.has(status) || Date.now() > deadline) break;
      await new Promise((rr) => setTimeout(rr, 2000));
    }
    if (status === 'COMPLETED') {
      pass(`runId=${runId}`);
    } else {
      fail(`run did not complete: last status=${status || '<unknown>'}`);
    }
  }

  // 9. Knowledge search answers (proves the resolved vector search backend works)
  step('knowledge search answers');
  {
    const res = await api('GET', `/console/org/${orgId}/documents/search?${new URLSearchParams({ query: 'smoke probe', limit: '5' })}`, token);
    const hits = asRecord(res.json).hits;
    if (res.status !== 200 || !Array.isArray(hits)) {
      fail(`status=${res.status} body=${res.text.slice(0, 200)}`);
    }
    pass(`${(hits as unknown[]).length} hit(s)`);
  }

  console.log(`\nALL SMOKE STEPS PASSED (${failures} failures)`);
}

main().catch((err) => {
  console.log(`FAIL (${(err as Error).message})`);
  process.exit(1);
});
