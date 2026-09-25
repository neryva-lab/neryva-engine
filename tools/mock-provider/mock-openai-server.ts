/**
 * mock-openai-server.ts — Neryva Engine Mock Provider
 *
 * A faithful LOCAL mock of the OpenAI chat-completions API (streaming SSE + non-streaming).
 * For testing and development when no real provider API key is available.
 *
 * The runtime-worker is started with a fetch-redirect preload (redirect-openai.mjs)
 * that sends https://api.openai.com/* here. The AI SDK's OpenAI provider (used by the
 * Studio OpenAI adapter in real mode) then streams from this mock.
 *
 * AUTH: expects `Authorization: Bearer <MOCK_OPENAI_KEY>` (env). Compared
 * timing-safe. Logs ONLY auth=ok|mismatch|missing — the key value is NEVER
 * logged, and this file must never be committed with a real key.
 *
 * SCRIPT (stateless, keyed on the request's message history):
 *  - eval lexical cases: user text contains 'france' -> "The answer is paris."
 *    'primary color' -> "The answer is red." ; "'hello'" -> "The answer is hello."
 *  - golden path turn 1 (user asks about tickets, no tool_calls yet in history)
 *      -> tool_call search_tickets {"query":"smoke"} (arguments split over 2
 *         SSE chunks in streaming mode to prove streaming reassembly)
 *  - golden path turn 2 (history has a search_tickets tool_call as
 *    OpenAI-native message.tool_calls)
 *      -> tool_call create_ticket {"title":"wave4 smoke", ...}
 *  - golden path turn 3 (history has a create_ticket tool_call)
 *      -> final text (split over 5 content chunks in streaming mode)
 *  - anything else -> short default text
 *
 * Every streamed response ends with finish_reason + a usage chunk
 * (prompt/completion/total tokens) + `data: [DONE]`.
 *
 * Raw SSE bytes are teed to MOCK_SSE_CAPTURE_DIR when set (evidence).
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// ============================================================================
// Types
// ============================================================================

interface ChatMessage {
  role: string;
  content?: string | Array<{ text?: string } | string>;
  tool_calls?: Array<{
    id?: string;
    function?: { name?: string; arguments?: string };
    name?: string;
  }>;
}

interface ChatCompletionsBody {
  model?: string;
  messages?: ChatMessage[];
  stream?: boolean;
}

type PlanKind =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; args: Record<string, unknown> }
  | { kind: 'final-text' }
  | { kind: 'final-text-web' };

interface TurnResult {
  planKind: string;
  chunks: number;
}

// ============================================================================
// Configuration
// ============================================================================

const PORT = Number(process.env.MOCK_OPENAI_PORT ?? process.env.FAKE_OPENAI_PORT ?? '18081');
const EXPECTED_KEY = process.env.MOCK_OPENAI_KEY ?? process.env.FAKE_OPENAI_KEY ?? '';
const CAPTURE_DIR = process.env.MOCK_SSE_CAPTURE_DIR ?? process.env.FAKE_SSE_CAPTURE_DIR ?? '';

if (!EXPECTED_KEY) {
  console.error('[mock-openai] FATAL: MOCK_OPENAI_KEY (or FAKE_OPENAI_KEY) is not set — refusing to start');
  process.exit(1);
}
if (CAPTURE_DIR) fs.mkdirSync(CAPTURE_DIR, { recursive: true });

// ============================================================================
// Auth
// ============================================================================

function authStatus(req: http.IncomingMessage): 'ok' | 'mismatch' | 'missing' {
  const h = req.headers.authorization ?? '';
  const m = /^Bearer (.+)$/.exec(h);
  if (!m?.[1]) return 'missing';
  const a = Buffer.from(m[1]);
  const b = Buffer.from(EXPECTED_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? 'ok' : 'mismatch';
}

// ============================================================================
// Request parsing
// ============================================================================

function readBody(req: http.IncomingMessage): Promise<ChatCompletionsBody> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function textOf(c: ChatMessage['content']): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : (p.text ?? ''))).join(' ');
  return '';
}

// ============================================================================
// Turn planning (stateless, keyed on message history)
// ============================================================================

/** Decide the scripted turn from the message history. */
function planTurn(messages: ChatMessage[]): PlanKind {
  const toolCallNames: string[] = [];
  let lastUserText = '';

  for (const m of messages) {
    if (m.role === 'user') lastUserText = textOf(m.content);
    const tcs = m.tool_calls ?? [];
    for (const tc of tcs) {
      const n = tc.function?.name ?? tc.name ?? '';
      if (n) toolCallNames.push(n);
    }
    // The Studio workflow records assistant tool proposals as AI SDK
    // tool-call parts, which the SDK serializes to OpenAI-native
    // message.tool_calls (handled above). A legacy JSON-string assistant
    // message '[{"id":"call_1","name":"search_tickets","args":{...}}]' is
    // still scanned as a fallback so the script advances on either
    // representation.
    if (m.role === 'assistant' && typeof m.content === 'string') {
      const trimmed = m.content.trim();
      if (trimmed.startsWith('[')) {
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) {
            for (const e of parsed) {
              const n = e?.name ?? e?.function?.name ?? '';
              if (typeof n === 'string' && n) toolCallNames.push(n);
            }
          }
        } catch {
          // Not JSON — ignore; falls through to the text rules below.
        }
      }
    }
  }

  const lower = lastUserText.toLowerCase();

  // Golden path: web_search flow
  // If web_search was already called, return the final summary
  if (toolCallNames.includes('web_search')) {
    return { kind: 'final-text-web' };
  }

  // Wave 4 script: search -> create -> final (kept for backwards compatibility)
  if (toolCallNames.includes('create_ticket')) return { kind: 'final-text' };
  if (toolCallNames.includes('search_tickets')) {
    return {
      kind: 'tool',
      name: 'create_ticket',
      args: { title: 'wave4 smoke', description: 'created by the wave4 happy-path smoke run' },
    };
  }

  // Eval lexical cases
  if (lower.includes('capital of france')) return { kind: 'text', text: 'The answer is paris.' };
  if (lower.includes('primary color')) return { kind: 'text', text: 'The answer is red.' };
  if (lower.includes('word hello')) return { kind: 'text', text: 'The answer is hello.' };

  // Golden path trigger: user wants web search
  if (lower.includes('search the web') || lower.includes('latest news') || lower.includes('web for') || (lower.includes('latest') && lower.includes('news')) || lower.includes('ai news')) {
    // Extract a query from the user text, or use a default
    const query = lastUserText.slice(0, 200);
    return { kind: 'tool', name: 'web_search', args: { query } };
  }

  // Wave 4 trigger (backwards compatibility)
  if (lower.includes('ticket')) {
    return { kind: 'tool', name: 'search_tickets', args: { query: 'smoke' } };
  }

  return { kind: 'text', text: 'Mock provider default reply.' };
}

// ============================================================================
// SSE helpers
// ============================================================================

function sseChunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

const FINAL_TEXT =
  'Done. I searched the ticket system for "smoke" and created the ticket "wave4 smoke". Mock provider run complete.';

const FINAL_TEXT_WEB =
  'Based on my web search, here are the latest developments in AI agents this week:\n\n' +
  '1. **Enterprise adoption accelerating** — More companies are deploying AI agents for customer support and internal workflows.\n' +
  '2. **Multi-agent frameworks maturing** — New tools for orchestrating agent teams are gaining traction.\n' +
  '3. **Safety and governance focus** — The industry is prioritizing approval workflows and audit trails for agent actions.\n\n' +
  'This summary was generated from web search results via the mock provider.';

// ============================================================================
// Chat completions handler
// ============================================================================

function handleChatCompletions(
  body: ChatCompletionsBody,
  res: http.ServerResponse,
  capture: string[] | null,
): TurnResult {
  const model = body.model ?? 'gpt-4o-mini';
  const created = Math.floor(Date.now() / 1000);
  const id = `chatcmpl-mock-${crypto.randomBytes(6).toString('hex')}`;
  const plan = planTurn(body.messages ?? []);
  const stream = body.stream === true;

  const write = (s: string): void => {
    res.write(s);
    if (capture) capture.push(s);
  };

  const finishStream = (promptTokens: number, completionTokens: number): void => {
    const total = promptTokens + completionTokens;
    write(
      sseChunk({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: total,
        },
      }),
    );
    write('data: [DONE]\n\n');
    res.end();
  };

  // --------------------------------------------------------------------------
  // Non-streaming branch
  // --------------------------------------------------------------------------
  if (!stream) {
    const promptTokens = 40;
    const completionTokens = 12;

    if (plan.kind === 'tool') {
      const callId = `call_${crypto.randomBytes(8).toString('hex')}`;
      const payload = {
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: callId,
                  type: 'function',
                  function: { name: plan.name, arguments: JSON.stringify(plan.args) },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
      return { planKind: `tool:${plan.name}`, chunks: 0 };
    }

    const text =
      plan.kind === 'final-text'
        ? FINAL_TEXT
        : plan.kind === 'final-text-web'
          ? FINAL_TEXT_WEB
          : plan.kind === 'text'
            ? plan.text
            : '';
    const payload = {
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
    return { planKind: plan.kind, chunks: 0 };
  }

  // --------------------------------------------------------------------------
  // Streaming branch (SSE)
  // --------------------------------------------------------------------------
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  const base = { id, object: 'chat.completion.chunk', created, model };
  const promptTokens = 48;
  let chunkCount = 0;

  if (plan.kind === 'tool') {
    const callId = `call_${crypto.randomBytes(8).toString('hex')}`;
    const argsStr = JSON.stringify(plan.args);
    // Split the arguments across two chunks to prove streaming reassembly.
    const mid = Math.ceil(argsStr.length / 2);
    write(
      sseChunk({
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  index: 0,
                  id: callId,
                  type: 'function',
                  function: { name: plan.name, arguments: argsStr.slice(0, mid) },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
    );
    chunkCount++;
    write(
      sseChunk({
        ...base,
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: argsStr.slice(mid) } }] },
            finish_reason: null,
          },
        ],
      }),
    );
    chunkCount++;
    write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
    chunkCount++;
    finishStream(promptTokens, 18);
    return { planKind: `tool:${plan.name}`, chunks: chunkCount };
  }

  const text =
    plan.kind === 'final-text'
      ? FINAL_TEXT
      : plan.kind === 'final-text-web'
        ? FINAL_TEXT_WEB
        : plan.kind === 'text'
          ? plan.text
          : '';
  // Split text into 5 content chunks to prove multi-chunk streaming.
  const n = 5;
  const size = Math.max(1, Math.ceil(text.length / n));
  for (let i = 0; i < text.length; i += size) {
    const delta = text.slice(i, i + size);
    const d: { role?: string; content: string } = { content: delta };
    if (i === 0) d.role = 'assistant';
    write(sseChunk({ ...base, choices: [{ index: 0, delta: d, finish_reason: null }] }));
    chunkCount++;
  }
  write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
  chunkCount++;
  finishStream(promptTokens, Math.ceil(text.length / 4));
  return { planKind: plan.kind, chunks: chunkCount };
}

// ============================================================================
// HTTP server
// ============================================================================

const server = http.createServer(async (req, res) => {
  const started = Date.now();

  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, mock: 'openai-server' }));
    return;
  }

  if (req.url !== '/v1/chat/completions' || req.method !== 'POST') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found (mock)', type: 'invalid_request_error' } }));
    return;
  }

  const auth = authStatus(req);
  if (auth !== 'ok') {
    // Log ONLY the status — never the presented key.
    console.log(JSON.stringify({ t: new Date().toISOString(), auth, event: 'rejected' }));
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: { message: 'Incorrect API key provided (mock)', type: 'invalid_request_error', code: 'invalid_api_key' },
      }),
    );
    return;
  }

  let body: ChatCompletionsBody;
  try {
    body = await readBody(req);
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'bad json (mock)' } }));
    return;
  }

  const capture: string[] | null = CAPTURE_DIR ? [] : null;
  let result: TurnResult;
  try {
    result = handleChatCompletions(body, res, capture);
  } catch (e) {
    console.log(
      JSON.stringify({
        t: new Date().toISOString(),
        auth,
        event: 'handler_error',
        error: String((e as Error)?.message ?? e).slice(0, 120),
      }),
    );
    if (!res.writableEnded) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'mock provider error' } }));
    }
    return;
  }

  if (capture && CAPTURE_DIR) {
    const name = `sse-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.log`;
    fs.writeFileSync(path.join(CAPTURE_DIR, name), capture.join(''));
  }

  // One log line per request: status only, no key, no prompt content.
  console.log(
    JSON.stringify({
      t: new Date().toISOString(),
      auth,
      event: 'chat.completions',
      plan: result.planKind,
      chunks: result.chunks,
      stream: body.stream === true,
      ms: Date.now() - started,
    }),
  );
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-openai] listening on 127.0.0.1:${PORT} (mock provider; auth required, key never logged)`);
});
