/**
 * redirect-openai.mjs — Neryva Engine Mock Provider (fetch redirect)
 *
 * Node preload module (`node --import ./redirect-openai.mjs`): patches
 * globalThis.fetch BEFORE any SDK code loads so that requests to
 * https://api.openai.com/* are served by the local mock provider
 * (mock-openai-server.ts) at 127.0.0.1:${MOCK_OPENAI_PORT}.
 *
 * The OpenAI Studio adapter builds its client with `createOpenAI({ apiKey,
 * compatibility: 'strict' })` and exposes no base-URL override, so the only
 * faithful interception point without touching product code is the fetch
 * layer. Everything else — the AI SDK request/response contract, SSE parsing,
 * tool-call reassembly — is the REAL provider path.
 *
 * For testing/development only. A real provider run requires real credentials.
 */
const FAKE_PORT = process.env.MOCK_OPENAI_PORT ?? process.env.FAKE_OPENAI_PORT ?? '18081';
const PREFIX = 'https://api.openai.com/';

const origFetch = globalThis.fetch.bind(globalThis);

globalThis.fetch = (input, init) => {
  let urlStr = null;
  if (typeof input === 'string') urlStr = input;
  else if (input instanceof URL) urlStr = input.href;
  else if (input && typeof input.url === 'string') urlStr = input.url;

  if (urlStr && urlStr.startsWith(PREFIX)) {
    const rest = urlStr.slice(PREFIX.length);
    const target = `http://127.0.0.1:${FAKE_PORT}/${rest}`;
    if (typeof input === 'string') {
      return origFetch(target, init);
    }
    // Request instance — rebuild against the local target, preserving
    // method/headers/body/signal.
    const rebuilt = new Request(target, input);
    return origFetch(rebuilt, init);
  }
  return origFetch(input, init);
};

// Also cover undici's direct dispatcher use inside the AI SDK: nothing else
// to patch — the SDK goes through globalThis.fetch in this runtime.
