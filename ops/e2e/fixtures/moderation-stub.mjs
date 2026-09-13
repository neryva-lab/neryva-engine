/**
 * moderation-stub.mjs - OpenAI-compatible /v1/moderations stub for the H1a gate.
 * Flags any input containing the magic token (see README). Start on :4010:
 *   node fixtures/moderation-stub.mjs
 */
import { createServer } from 'node:http';

createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method !== 'POST' || !req.url.endsWith('/moderations')) {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let input = '';
    try { input = String(JSON.parse(body).input ?? ''); } catch {}
    const flagged = input.toUpperCase().includes('GUARDRAIL_BLOCK_ME');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'modr_e2e',
      model: 'omni-moderation-latest',
      results: [{ flagged, categories: flagged ? { self_harm: true } : {}, category_scores: {} }],
    }));
  });
}).listen(Number(process.env.PORT ?? 4010), () => console.log('[moderation-stub] on :' + (process.env.PORT ?? 4010)));
