# Mock Provider — Neryva Engine

A faithful local mock of the OpenAI chat-completions API for testing and development
when no real provider API key is available.

## Files

- **`mock-openai-server.ts`** — TypeScript mock server implementing:
  - `POST /v1/chat/completions` (streaming SSE + non-streaming JSON)
  - `GET /health` (liveness check)
  - Bearer token auth (timing-safe comparison, key never logged)
  - Deterministic scripted responses based on message history
  - Tool call support (`search_tickets`, `create_ticket`) for testing approval flows
  - Eval lexical cases (`france` → paris, `primary color` → red, etc.)

- **`redirect-openai.mjs`** — Node preload module that patches `globalThis.fetch`
  to redirect `https://api.openai.com/*` to the local mock. Use with:
  ```bash
  node --import ./redirect-openai.mjs <your-app.js>
  ```

## Usage

### 1. Start the mock server

```bash
# Set the mock API key (any value for testing; must match what the client sends)
export MOCK_OPENAI_KEY="test-mock-key-123"
export MOCK_OPENAI_PORT=18081

# Run with tsx (or compile first)
npx tsx tools/mock-provider/mock-openai-server.ts
```

The server listens on `127.0.0.1:18081` by default.

### 2. Point the runtime worker at the mock

```bash
export MOCK_OPENAI_PORT=18081
export MOCK_OPENAI_KEY="test-mock-key-123"

node --import ./tools/mock-provider/redirect-openai.mjs \
  apps/runtime-worker/dist/main.js
```

### 3. Provision a provider credential

The engine's `provider_credentials` table needs an `openai` credential for the test org.
The secret must be the same value as `MOCK_OPENAI_KEY`, sealed with the engine's
`ENGINE_ENCRYPTION_KEY` (format: `enc:v1:` + base64(iv[12] || authTag[16] || ciphertext)).

See `docs/console-marathon/phase-0-harness/` for the harness provisioning script.

## Scripted behavior

The mock is stateless — it decides each turn from the request's message history:

| History contains | Response |
|-----------------|----------|
| `create_ticket` tool call | Final text summary |
| `search_tickets` tool call | `create_ticket` tool call |
| User asks about "capital of france" | "The answer is paris." |
| User asks about "primary color" | "The answer is red." |
| User mentions "ticket" | `search_tickets` tool call |
| Anything else | Default text reply |

Streaming responses split tool-call arguments across 2 chunks and text across 5 chunks
to prove streaming reassembly works.

## Security notes

- **Never commit a real API key.** The mock key is for testing only.
- The key value is **never logged** — only `auth=ok|mismatch|missing`.
- The mock binds to `127.0.0.1` only (not externally reachable).
- For production, use real provider credentials via the engine's
  `provider_credentials` table with `source='byok'` or `'platform'`.

## Future providers

To add a mock for another provider (Anthropic, Google, etc.):
1. Create `mock-<provider>-server.ts` implementing that provider's API
2. Create a corresponding `redirect-<provider>.mjs` if the SDK lacks base-URL config
3. Document the scripted behavior in this README
