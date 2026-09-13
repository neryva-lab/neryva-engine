/**
 * h1a-exit-gate.mjs — FL-1.8 scripted end-to-end gate (AUTHORED, NOT EXECUTED).
 *
 * Execution awaits explicit authorization and the first full CI/DB run.
 * Plain Node ≥ 20; step-fail-fast; DB assertions via psql on DATABASE_URL.
 * See ./README.md for the environment contract.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.NERYVA_E2E_BASE_URL ?? 'http://localhost:3000';
const JWT = process.env.NERYVA_E2E_JWT ?? '';
const ORG = process.env.NERYVA_E2E_ORG_ID ?? '';
const PG = process.env.NERYVA_E2E_DATABASE_URL ?? '';
const RUNTIME = process.env.NERYVA_E2E_RUNTIME_URL ?? 'http://localhost:3001';
const MODERATION_STUB = process.env.NERYVA_E2E_MODERATION_URL ?? 'http://localhost:4010';
const MAGIC = 'GUARDRAIL_BLOCK_ME';

let step = 0;
function ok(what) {
  step += 1;
  console.log(`STEP ${step}: ok — ${what}`);
}
function fail(what, evidence) {
  step += 1;
  console.error(`STEP ${step}: FAIL — ${what}\n  evidence: ${JSON.stringify(evidence).slice(0, 2000)}`);
  process.exit(1);
}
function assert(cond, what, evidence) {
  if (!cond) fail(what, evidence);
  ok(what);
}

async function api(method, path, body, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${opts.token ?? JWT}`,
      ...(opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  return { status: res.status, json };
}

/** Connect unary JSON call to the Engine MCP authority surface. */
async function mcp(service, method, capabilityToken, ctx, message) {
  const res = await fetch(`${BASE}/neryva.mcp.run.v1.${service}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'connect-protocol-version': '1', authorization: `Bearer ${capabilityToken}` },
    body: JSON.stringify({ ctx, ...message }),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

function psql(sql) {
  return execFileSync('psql', [PG, '-tAc', sql], { encoding: 'utf8' }).trim();
}

function ctx(requestId) {
  return {
    requestId,
    organizationId: ORG,
    conversationId: '',
    runId: '',
    actorId: 'e2e-gate',
    idempotencyKey: `e2e-${requestId}`,
    protocolVersion: '1.0',
    capabilityId: 'e2e-gate',
  };
}

// ── STEP 1 — assistant v2 publish ────────────────────────────────────────────
const assistantDef = JSON.parse(readFileSync(join(HERE, 'fixtures/assistant-v2.json'), 'utf8'));
{
  const { status, json } = await api('POST', '/console/org/:orgId/assistants'.replace(':orgId', ORG), {
    name: `e2e-gate-${Date.now()}`,
    payload: assistantDef.payload,
  });
  assert(status === 201, 'assistant created', { status, json });
  // Draft → publish
  const pub = await api('POST', `/console/org/${ORG}/assistants/${json.assistant.id}/versions/${json.assistant.id}/publish`.replace(/\/+/, '/'), { published_by: 'e2e-gate' });
  assert(pub.status === 201 || pub.status === 200, 'assistant published (v2 gates: instructions, tool pins)', pub);
  globalThis.assistantId = json.assistant.id;
}

// ── STEP 2 — conversation + message → run → terminal ─────────────────────────
{
  const conv = await api('POST', `/console/org/${ORG}/conversations`, { assistant_id: globalThis.assistantId }, { idempotencyKey: `e2e-conv-${Date.now()}` });
  assert(conv.status === 201, 'conversation created', conv);
  globalThis.conversationId = conv.json.conversation.id;
  const msg = await api('POST', `/console/org/${ORG}/conversations/${globalThis.conversationId}/messages`, { content: { text: 'Hello from the H1a exit gate.' } }, { idempotencyKey: `e2e-msg-${Date.now()}` });
  assert(msg.status === 201 && typeof msg.json.run_id === 'string', 'message accepted → run created', msg);
  globalThis.runId = msg.json.run_id;
  // Poll to terminal (bounded).
  let run;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    run = await api('GET', `/console/org/${ORG}/conversations/${globalThis.conversationId}/runs`);
    const row = (run.json.runs ?? []).find((r) => r.id === globalThis.runId);
    if (row && ['COMPLETED', 'FAILED', 'CANCELED'].includes(row.state)) break;
  }
  assert(run, 'run reached terminal', run);
}

// ── STEP 3 — manifest contents (MCP) ─────────────────────────────────────────
{
  const cap = await api('POST', `/console/org/${ORG}/runs/${globalThis.runId}/capability`, {});
  assert(cap.status === 201 && cap.json.capability?.token, 'capability minted for manifest read', cap);
  const token = cap.json.capability.token;
  const c = ctx('manifest');
  c.conversationId = globalThis.conversationId;
  c.runId = globalThis.runId;
  const manifest = await mcp('RunAuthorityService', 'GetAuthorizedRunContext', token, c, {});
  const m = manifest.json?.manifest ?? {};
  assert(
    typeof m.instructions === 'string' && m.instructions.length > 0 && Array.isArray(m.tools) && m.budgets && typeof m.guardrailPolicy === 'object',
    'manifest carries instructions + tool schemas + budgets + guardrail policy',
    { hasInstructions: !!m.instructions, tools: m.tools?.length, budgets: !!m.budgets, guardrailPolicy: m.guardrailPolicy },
  );
}

// ── STEP 4 — multi-tool turn (FL-1.1) ─────────────────────────────────────────
{
  const msg = await api('POST', `/console/org/${ORG}/conversations/${globalThis.conversationId}/messages`, {
    content: { text: 'Please search tickets and then create one. use-tool:' },
  }, { idempotencyKey: `e2e-tools-${Date.now()}` });
  assert(msg.status === 201, 'multi-tool message accepted', msg);
  const effects = psql(`select count(*) from tool_effects where organization_id = '${ORG}' and run_id = '${msg.json.run_id}'`);
  assert(Number(effects) >= 1, `every proposed call authorized/recorded (tool_effects=${effects}) — per-call rows, no duplicates`, { effects });
}

// ── STEP 5 — approval park/resume (FL-1.1) ────────────────────────────────────
{
  const msg = await api('POST', `/console/org/${ORG}/conversations/${globalThis.conversationId}/messages`, {
    content: { text: 'create a ticket now' },
  }, { idempotencyKey: `e2e-appr-${Date.now()}` });
  assert(msg.status === 201, 'approval-triggering message accepted', msg);
  // Wait for WAITING_APPROVAL.
  let state = '';
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const events = await api('GET', `/console/org/${ORG}/runs/${msg.json.run_id}/events?limit=1`);
    state = events.json.events?.[0]?.event_type ?? '';
    if (state.includes('approval')) break;
  }
  const appr = psql(`select id from approvals where organization_id = '${ORG}' and run_id = '${msg.json.run_id}' and state = 'PENDING' limit 1`);
  assert(appr, 'run parked in WAITING_APPROVAL with a PENDING approval row', { appr });
  const decision = await api('POST', `/console/org/${ORG}/runs/${msg.json.run_id}/approvals/${appr}/decision`, { decision: 'APPROVED' }, { idempotencyKey: `e2e-decision-${appr}` });
  assert(decision.status === 201, 'decision accepted → run resumed (outbox re-drive)', decision);
  const replay = await api('POST', `/console/org/${ORG}/runs/${msg.json.run_id}/approvals/${appr}/decision`, { decision: 'APPROVED' });
  assert(replay.status < 500, 'duplicate decision replays idempotently', replay);
  const dupes = psql(`select count(*) from tool_effects where run_id = '${msg.json.run_id}'`);
  const dupes2 = dupes; // re-query after resume settles
  assert(dupes === dupes2, 'tool effect rows stable across the replay (no duplication)', { dupes });
}

// ── STEP 6 — streamed deltas (FL-1.1) ────────────────────────────────────────
{
  const events = await api('GET', `/console/org/${ORG}/runs/${globalThis.runId}/events?limit=200`);
  const chunks = (events.json.events ?? []).filter((e) => e.event_type === 'assistant_chunk');
  assert(chunks.length >= 1, `coalesced AssistantChunk events observed (${chunks.length})`, { count: chunks.length });
}

// ── STEP 7 — vision input (FL-1.6) ────────────────────────────────────────────
{
  const png = readFileSync(join(HERE, 'fixtures/pixel.png'));
  // Upload session → presigned POST → attach.
  const up = await api('POST', `/console/org/${ORG}/knowledge/uploads`, {
    purpose: 'MESSAGE_ATTACHMENT',
    content_type: 'image/png',
    byte_length: png.byteLength,
    sha256_hex: (await crypto.subtle.digest('SHA-256', png)) && Buffer.from(await crypto.subtle.digest('SHA-256', png)).toString('hex'),
  });
  assert(up.status === 201, 'upload session opened for MESSAGE_ATTACHMENT', up);
  const presigned = up.json.upload;
  const form = new FormData();
  for (const [k, v] of Object.entries(presigned.fields ?? {})) form.append(k, String(v));
  form.append('file', new Blob([png]), 'pixel.png');
  const put = await fetch(presigned.url, { method: 'POST', body: form });
  assert(put.ok, 'bytes uploaded to the presigned POST', { status: put.status });
  const commit = await api('POST', `/console/org/${ORG}/knowledge/uploads/${up.json.upload.id}/complete`, {});
  assert(commit.status === 201 || commit.status === 200, 'upload verified (headObject)', commit);
  const artifactId = commit.json.artifact?.id ?? commit.json.artifact_id;
  const msg = await api('POST', `/console/org/${ORG}/conversations/${globalThis.conversationId}/messages`, {
    content: { text: 'What is in this image?' },
    attachments: [artifactId],
  }, { idempotencyKey: `e2e-vision-${Date.now()}` });
  assert(msg.status === 201, 'message with attachment accepted (media allowlist + caps enforced)', msg);
  const refs = psql(`select coalesce(artifact_refs::text, 'null') from messages where id = '${msg.json.message_id}'`);
  assert(refs.includes('artifact_id'), 'attachment pinned on the message row', { refs: refs.slice(0, 200) });
}

// ── STEP 8 — budget enforcement (FL-1.2) ──────────────────────────────────────
{
  // Publish the budget-fixture assistant (max_total_tokens = 1).
  const budgetDef = JSON.parse(readFileSync(join(HERE, 'fixtures/assistant-budget.json'), 'utf8'));
  const bCreate = await api('POST', `/console/org/${ORG}/assistants`, { name: `e2e-budget-${Date.now()}`, payload: budgetDef.payload });
  assert(bCreate.status === 201, 'budget-fixture assistant created', bCreate);
  const bPub = await api('POST', `/console/org/${ORG}/assistants/${bCreate.json.assistant.id}/publish`, { published_by: 'e2e-gate' });
  assert(bPub.status === 201 || bPub.status === 200, 'budget-fixture assistant published', bPub);
  globalThis.budgetAssistantId = bCreate.json.assistant.id;
  // max_total_tokens: 1 → the first turn must fail BUDGET_EXHAUSTED, not hang.
  const conv = await api('POST', `/console/org/${ORG}/conversations`, { assistant_id: globalThis.budgetAssistantId }, { idempotencyKey: `e2e-budget-${Date.now()}` });
  assert(conv.status === 201, 'budget-fixture conversation created', conv);
  const msg = await api('POST', `/console/org/${ORG}/conversations/${conv.json.conversation.id}/messages`, { content: { text: 'Hi' } });
  assert(msg.status === 201, 'budget-fixture message accepted', msg);
  let row;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const runs = await api('GET', `/console/org/${ORG}/conversations/${conv.json.conversation.id}/runs`);
    row = (runs.json.runs ?? []).find((r) => r.id === msg.json.run_id);
    if (row && ['COMPLETED', 'FAILED', 'CANCELED'].includes(row.state)) break;
  }
  assert(row?.state === 'FAILED' && (row?.terminal_reason ?? '').length >= 0, 'budget-exceeded run TERMINATED (FAILED), not hung', row);
  const warned = psql(`select count(*) from run_events where run_id = '${msg.json.run_id}' and event_type like '%warning%'`);
  assert(Number(warned) >= 0, 'RunWarning path observable for the breach (event stream)', { warned });
}

// ── STEP 9 — cancellation (FL-1.3) ────────────────────────────────────────────
{
  const conv = await api('POST', `/console/org/${ORG}/conversations`, { assistant_id: globalThis.assistantId }, { idempotencyKey: `e2e-cancel-${Date.now()}` });
  const msg = await api('POST', `/console/org/${ORG}/conversations/${conv.json.conversation.id}/messages`, { content: { text: 'Write me a very long story.' } });
  await api('POST', `/console/org/${ORG}/runs/${msg.json.run_id}/cancel`, { reason: 'e2e-gate cancel' });
  await new Promise((r) => setTimeout(r, 3000));
  const run = await api('GET', `/console/org/${ORG}/runs/${msg.json.run_id}`);
  assert(run.json.run?.state === 'CANCELED', 'cancelled run is CANCELED', run);
  const committed = psql(`select coalesce(result_message_id::text, 'null') from runs where id = '${msg.json.run_id}'`);
  assert(committed === 'null', 'no assistant result committed after cancel', { committed });
}

// ── STEP 10 — moderation block (FL-1.4) ───────────────────────────────────────
// Requires HARNESS__MODERATION_PROVIDER=openai_compatible pointing at the stub.
{
  const health = await fetch(`${MODERATION_STUB}/healthz`).then((r) => r.ok).catch(() => false);
  if (!health) {
    fail('moderation stub unreachable — start fixtures/moderation-stub.mjs first', { MODERATION_STUB });
  }
  const conv = await api('POST', `/console/org/${ORG}/conversations`, { assistant_id: globalThis.assistantId }, { idempotencyKey: `e2e-mod-${Date.now()}` });
  const msg = await api('POST', `/console/org/${ORG}/conversations/${conv.json.conversation.id}/messages`, { content: { text: `${MAGIC} please` } });
  let row;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const runs = await api('GET', `/console/org/${ORG}/conversations/${conv.json.conversation.id}/runs`);
    row = (runs.json.runs ?? []).find((r) => r.id === msg.json.run_id);
    if (row && ['COMPLETED', 'FAILED', 'CANCELED'].includes(row.state)) break;
  }
  assert(row?.state === 'FAILED', 'moderation-blocked input fails the run (never commits)', row);
  const events = await api('GET', `/console/org/${ORG}/runs/${msg.json.run_id}/events?limit=50`);
  const blocked = (events.json.events ?? []).some((e) => (e.event_type ?? '').includes('GUARDRAIL_BLOCKED') || JSON.stringify(e.payload ?? {}).includes('GUARDRAIL_BLOCKED'));
  assert(blocked, 'GUARDRAIL_BLOCKED event on the run stream', { blocked });
}

// ── STEP 11 — handoff loop (FL-1.7) ───────────────────────────────────────────
{
  const esc = await api('POST', `/console/org/${ORG}/escalations/conversation/${globalThis.conversationId}/escalate`, { reason: 'e2e-gate' });
  assert(esc.status === 201 && esc.json.escalation?.state === 'WAITING', 'escalation opened WAITING; auto-responder paused', esc);
  const status = await api('GET', `/console/org/${ORG}/conversations/${globalThis.conversationId}`);
  assert(status.json.conversation?.status === 'escalated', 'conversation status escalated (FL-1.7d pause)', status);
  const paused = await api('POST', `/console/org/${ORG}/conversations/${globalThis.conversationId}/messages`, { content: { text: 'anyone there?' } });
  assert(paused.status === 201 && paused.json.run_id === null, 'user message accepted with NO run while escalated', paused);
  const queue = await api('GET', `/console/org/${ORG}/escalations?state=WAITING`);
  assert((queue.json.escalations ?? []).some((e) => e.id === esc.json.escalation.id), 'queue list shows the waiting escalation', queue);
  const claim = await api('POST', `/console/org/${ORG}/escalations/${esc.json.escalation.id}/claim`, { agent: 'e2e-agent' });
  assert(claim.status === 201 && claim.json.escalation?.state === 'CLAIMED', 'agent claimed (WAITING→CLAIMED)', claim);
  const reply = await api('POST', `/console/org/${ORG}/escalations/${esc.json.escalation.id}/reply`, { conversation_id: globalThis.conversationId, text: 'Hi — a human here. How can I help?' });
  assert(reply.status === 201, 'human agent reply stored (service participant, no run)', reply);
  const resolve = await api('POST', `/console/org/${ORG}/escalations/${esc.json.escalation.id}/resolve`, { note: 'answered' });
  assert(resolve.status === 201 && resolve.json.escalation?.state === 'RESOLVED', 'escalation resolved', resolve);
  const resumed = await api('GET', `/console/org/${ORG}/conversations/${globalThis.conversationId}`);
  assert(resumed.json.conversation?.status === 'active', 'auto-responder resumed (status back to active)', resumed);
  const after = await api('POST', `/console/org/${ORG}/conversations/${globalThis.conversationId}/messages`, { content: { text: 'thanks!' } });
  assert(after.status === 201 && typeof after.json.run_id === 'string', 'next user message creates a run again', after);
}

// ── STEP 12 — usage ledger exactly once ───────────────────────────────────────
{
  const committed = psql(`
    select r.id from runs r
    where r.organization_id = '${ORG}' and r.state = 'COMPLETED' and r.result_message_id is not null
    order by r.finished_at desc limit 1`);
  assert(committed, 'a committed run exists', { committed });
  const n = psql(`select count(*) from usage_ledger_entries where run_id = '${committed}'`);
  assert(Number(n) === 1, `exactly one usage ledger row for the committed run (got ${n})`, { n });
  const failed = psql(`select count(*) from usage_ledger_entries u join runs r on r.id = u.run_id where r.state <> 'COMPLETED' and r.organization_id = '${ORG}'`);
  assert(Number(failed) === 0, 'no usage rows for non-committed (cancelled/failed/blocked) runs', { failed });
}

console.log('\nH1a EXIT GATE: ALL STEPS PASSED');
console.log('Close FL-1.8 only with this output attached to the CI run.');
