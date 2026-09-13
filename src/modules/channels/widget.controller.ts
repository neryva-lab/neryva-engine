import { Body, Controller, Get, Header, HttpCode, Options, Param, Post, Query, Req, Res, Sse } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { Observable } from 'rxjs';
import { Public } from '../../common/auth/decorators';
import { ApiError } from '../../common/http/api-error';
import { ChannelsService } from './channels.service';
import { WidgetService, originAllowed } from './widget.service';
import { ConversationsService } from '../conversations/conversations.service';
import { ChannelConfig } from './schema';

/**
 * Website widget plane (Phase C4) — public routes under `/public/channels`.
 * Auth is the widget session (HttpOnly SameSite=None cookie, set at mint, or
 * the X-Neryva-Session header for API-first integrations). CORS reflects the
 * Origin ONLY against the account allowlist — never a wildcard. The embed
 * page is served same-origin by the Engine, so the default iframe flow needs
 * no CORS at all.
 */

const SESSION_COOKIE = 'nrv_channel_session';

class MintSessionDto {
  turnstile_token?: string;
}

class WidgetMessageDto {
  text!: string;
  idempotency_key?: string;
}

@Controller('public/channels')
export class WidgetController {
  constructor(
    private readonly widget: WidgetService,
    private readonly channels: ChannelsService,
    private readonly conversations: ConversationsService,
  ) {}

  // ── Session ───────────────────────────────────────────────────────────────

  @Post(':publicKey/session')
  @HttpCode(200)
  @Public()
  async mint(
    @Param('publicKey') publicKey: string,
    @Req() request: FastifyRequest & { rawBody?: string },
    @Body() body: MintSessionDto | undefined,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const account = (await this.channels.getByPublicKey(publicKey)) ?? throw404();
    const origin = request.headers.origin ?? null;
    const session = await this.widget.mintSession({
      account,
      origin,
      ipHash: hashNullable(request.ip),
      userAgentHash: hashNullable(request.headers['user-agent']),
      turnstileToken: body?.turnstile_token,
    });
    const maxAge = Math.floor((session.expiresAt.getTime() - Date.now()) / 1000);
    // Manual Set-Cookie header — SameSite=None (cross-origin iframe), Secure
    // in production, HttpOnly, scoped to the widget plane path.
    const parts = [
      `${SESSION_COOKIE}=${session.token}`,
      'Path=/public/channels',
      'HttpOnly',
      'SameSite=None',
      `Max-Age=${maxAge}`,
    ];
    if (process.env.NODE_ENV === 'production') {
      parts.push('Secure');
    }
    this.applyCors(reply, account, origin);
    reply.header('set-cookie', parts.join('; '));
    reply.send({ session_expires_at: session.expiresAt.toISOString(), greeting: session.config.greeting ?? null });
  }

  // ── Messages ─────────────────────────────────────────────────────────────

  @Post(':publicKey/messages')
  @HttpCode(200)
  @Public()
  async sendMessage(@Param('publicKey') publicKey: string, @Req() request: FastifyRequest, @Body() body: WidgetMessageDto, @Res() reply: FastifyReply): Promise<void> {
    const account = (await this.channels.getByPublicKey(publicKey)) ?? throw404();
    const ctx = await this.widget.resolveSession(account, this.sessionToken(request));
    const origin = request.headers.origin ?? null;
    this.applyCors(reply, account, origin);
    if (!body || typeof body.text !== 'string') {
      throw ApiError.validation({ text: 'must be a string' });
    }
    const idemHeader = request.headers['idempotency-key'];
    const result = await this.widget.sendMessage(ctx, {
      text: body.text,
      idempotencyKey: Array.isArray(idemHeader) ? idemHeader[0] : idemHeader,
    });
    reply.send(result);
  }

  /** FL-1.7b - end user asks for a human agent; pauses the auto-responder. */
  @Post(':publicKey/escalate')
  @HttpCode(200)
  @Public()
  async escalate(@Param('publicKey') publicKey: string, @Req() request: FastifyRequest, @Body() body: { reason?: string } | undefined, @Res() reply: FastifyReply): Promise<void> {
    const account = (await this.channels.getByPublicKey(publicKey)) ?? throw404();
    const ctx = await this.widget.resolveSession(account, this.sessionToken(request));
    const origin = request.headers.origin ?? null;
    this.applyCors(reply, account, origin);
    const result = await this.widget.escalate(ctx, typeof body?.reason === 'string' ? body.reason : undefined);
    reply.send(result);
  }

  /** FL-2.8 - CSAT: thumbs feedback on a message, bound to the session. */
  @Post(':publicKey/feedback')
  @HttpCode(200)
  @Public()
  async feedback(
    @Param('publicKey') publicKey: string,
    @Req() request: FastifyRequest,
    @Body() body: { message_id?: string; rating?: string },
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const account = (await this.channels.getByPublicKey(publicKey)) ?? throw404();
    const ctx = await this.widget.resolveSession(account, this.sessionToken(request));
    const origin = request.headers.origin ?? null;
    this.applyCors(reply, account, origin);
    if (!body || typeof body.message_id !== 'string' || (body.rating !== 'up' && body.rating !== 'down')) {
      reply.code(400).send({ error: { message: 'message_id and rating (up|down) are required' } });
      return;
    }
    const conversationId = await this.widget.sessionConversationId(ctx);
    const idempotency = request.headers['idempotency-key'];
    await this.conversations.recordFeedback({
      orgId: account.organizationId,
      conversationId,
      messageId: body.message_id,
      accountId: ctx.session.id,
      rating: body.rating,
    });
    reply.send({ received: true });
  }

  /**
   * FL-3.19 — end-user typing indicator. EPHEMERAL by design (invariant 8):
   * nothing is persisted — the 204 is the signal, and console dashboards
   * surface it via their own short-poll. The session check IS the auth.
   */
  @Post(':publicKey/typing')
  @HttpCode(204)
  @Public()
  async typing(@Param('publicKey') publicKey: string, @Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const account = (await this.channels.getByPublicKey(publicKey)) ?? throw404();
    await this.widget.resolveSession(account, this.sessionToken(request));
    const origin = request.headers.origin ?? null;
    this.applyCors(reply, account, origin);
    reply.code(204).send();
  }

  /**
   * FL-3.19 — end-user read marker: the session's conversation marks recent
   * OUTBOUND assistant messages as `read` (durable receipts, one row per
   * message×state). Bounded to the last 50 messages per call.
   */
  @Post(':publicKey/read')
  @HttpCode(200)
  @Public()
  async markRead(@Param('publicKey') publicKey: string, @Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const account = (await this.channels.getByPublicKey(publicKey)) ?? throw404();
    const ctx = await this.widget.resolveSession(account, this.sessionToken(request));
    const origin = request.headers.origin ?? null;
    this.applyCors(reply, account, origin);
    const count = await this.widget.markSessionRead(ctx, account);
    reply.send({ marked_read: count });
  }

  /**
   * Session-conversation message history (cursor = message sequence).
   * The final assistant TEXT lives here, not in terminal run-event
   * payloads — the widget renders from this endpoint after each terminal
   * stream event, and on open for history.
   */
  @Get(':publicKey/messages')
  @Public()
  async listMessages(@Param('publicKey') publicKey: string, @Query('after') after: string, @Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const account = (await this.channels.getByPublicKey(publicKey)) ?? throw404();
    const ctx = await this.widget.resolveSession(account, this.sessionToken(request));
    const origin = request.headers.origin ?? null;
    this.applyCors(reply, account, origin);
    const conversationId = await this.widget.sessionConversationId(ctx);
    const page = await this.conversations.listMessages(account.organizationId, conversationId, {
      afterSequence: after ? Number(after) : undefined,
      limit: 100,
    });
    reply.send({
      messages: page.messages.map((m) => {
        const content = (m.content ?? {}) as { text?: unknown; citations?: unknown; suggested_followups?: unknown; generated_media?: unknown };
        return {
          id: m.id,
          sequence: m.sequence,
          role: m.role,
          text: typeof content.text === 'string' ? String(content.text) : '',
          pinned: m.pinnedAt !== null,
          ...(content.citations !== undefined ? { citations: content.citations } : {}),
          ...(Array.isArray(content.suggested_followups) ? { suggested_followups: content.suggested_followups.map(String).slice(0, 4) } : {}),
          ...(Array.isArray(content.generated_media) ? { generated_media: content.generated_media.slice(0, 4) } : {}),
          created_at: m.createdAt,
        };
      }),
      next_cursor: page.next_cursor,
    });
  }

  // ── Event stream (SSE) ────────────────────────────────────────────────────

  /** Session-scoped replay of one run's events (engine_sequence cursor). */
  @Sse(':publicKey/stream')
  @Public()
  stream(
    @Param('publicKey') publicKey: string,
    @Query('run_id') runId: string,
    @Query('last_event_id') lastEventId: string,
    @Req() request: FastifyRequest,
  ): Observable<{ id?: string; event?: string; data: unknown }> {
    return new Observable((subscriber) => {
      let inner: { unsubscribe: () => void } | null = null;
      let disposed = false;
      void (async () => {
        try {
          const account = (await this.channels.getByPublicKey(publicKey)) ?? throw404();
          const ctx = await this.widget.resolveSession(account, this.sessionToken(request));
          await this.widget.assertRunInSession(ctx, String(runId ?? ''));
          if (disposed) {
            return;
          }
          const cursor = Number(lastEventId ?? '0') || 0;
          const events = this.conversations.streamRunEvents(account.organizationId, String(runId), cursor);
          inner = events.subscribe({
            next: (m) => subscriber.next(m),
            error: (e) => subscriber.error(e instanceof ApiError ? e : new Error('stream unavailable')),
            complete: () => subscriber.complete(),
          });
        } catch (err) {
          subscriber.error(err instanceof ApiError ? err : new Error('stream unavailable'));
        }
      })();
      return () => {
        disposed = true;
        inner?.unsubscribe();
      };
    });
  }

  // ── Served assets (same-origin iframe UI + loader script) ────────────────

  /** The embeddable chat UI — served same-origin so no CORS is needed. */
  @Get(':publicKey/embed')
  @Public()
  @Header('cache-control', 'no-store')
  @Header('content-security-policy', "default-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'")
  async embed(@Param('publicKey') publicKey: string, @Res() reply: FastifyReply): Promise<void> {
    const account = await this.channels.getByPublicKey(publicKey);
    if (!account || account.platform !== 'web' || account.status !== 'active') {
      throw404();
    }
    const config = (account.config ?? {}) as ChannelConfig;
    reply.type('text/html; charset=utf-8').send(embedHtml(account.publicKey ?? '', config.greeting ?? ''));
  }

  /** The one-line loader customers paste: <script src data-key="nk_live_..."> */
  @Get('widget/v1/neryva.js')
  @Public()
  @Header('cache-control', 'public, max-age=3600')
  async loader(@Res() reply: FastifyReply): Promise<void> {
    reply.type('application/javascript; charset=utf-8').send(loaderJs());
  }

  // ── CORS preflight ────────────────────────────────────────────────────────

  @Options([':publicKey/session', ':publicKey/messages', ':publicKey/stream'])
  @Public()
  @HttpCode(204)
  async preflight(@Param('publicKey') publicKey: string, @Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const account = await this.channels.getByPublicKey(publicKey);
    if (!account) {
      reply.code(204).send();
      return;
    }
    this.applyCors(reply, account, request.headers.origin ?? null);
    reply.header('access-control-max-age', '600');
    reply.send();
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private sessionToken(request: FastifyRequest): string | undefined {
    const header = request.headers['x-neryva-session'];
    const fromHeader = Array.isArray(header) ? header[0] : header;
    if (fromHeader) {
      return fromHeader;
    }
    const cookies = (request as unknown as { cookies?: Record<string, string> }).cookies ?? {};
    return cookies[SESSION_COOKIE];
  }

  private applyCors(reply: FastifyReply, account: { config?: unknown }, origin: string | null): void {
    const config = (account.config ?? {}) as ChannelConfig;
    if (origin && originAllowed(config.allowed_domains ?? [], origin)) {
      reply.header('access-control-allow-origin', origin);
      reply.header('access-control-allow-credentials', 'true');
      reply.header('access-control-allow-headers', 'content-type, x-neryva-session, idempotency-key');
      reply.header('access-control-allow-methods', 'GET, POST, OPTIONS');
      reply.header('vary', 'Origin');
    }
  }
}

function throw404(): never {
  throw new ApiError(404, 'not_found', 'unknown widget');
}

function hashNullable(v: string | undefined | null): string | null {
  return v ? createHash('sha256').update(v).digest('hex') : null;
}

// ── served assets (inline — the widget has no build step by design) ─────────

function loaderJs(): string {
  return `(function () {
  'use strict';
  var script = document.currentScript;
  if (!script) return;
  var key = script.getAttribute('data-key');
  if (!key) return;
  var origin = new URL(script.src, window.location.href).origin;
  var btn = document.createElement('button');
  btn.setAttribute('aria-label', 'Chat with us');
  btn.style.cssText = 'position:fixed;right:20px;bottom:20px;width:56px;height:56px;border-radius:50%;border:0;background:#4f46e5;color:#fff;font-size:24px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25);z-index:2147483000;';
  btn.textContent = '\\u{1F4AC}';
  var frame = null;
  btn.addEventListener('click', function () {
    if (frame) {
      frame.remove();
      frame = null;
      return;
    }
    frame = document.createElement('iframe');
    frame.src = origin + '/public/channels/' + encodeURIComponent(key) + '/embed';
    frame.title = 'Chat';
    frame.allow = 'clipboard-write';
    frame.style.cssText = 'position:fixed;right:20px;bottom:88px;width:380px;height:560px;max-height:80vh;border:0;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.3);z-index:2147483000;background:#fff;';
    document.body.appendChild(frame);
  });
  document.body.appendChild(btn);
})();
`;
}

function embedHtml(publicKey: string, greeting: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chat</title>
<style>
  *{box-sizing:border-box} body{margin:0;font:15px/1.45 system-ui,-apple-system,sans-serif;background:#f7f7fb;color:#111}
  #log{position:absolute;inset:0 0 64px 0;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:8px}
  .m{max-width:82%;padding:9px 12px;border-radius:12px;white-space:pre-wrap;word-break:break-word}
  .user{align-self:flex-end;background:#4f46e5;color:#fff;border-bottom-right-radius:4px}
  .bot{align-self:flex-start;background:#fff;border:1px solid #e4e4ef;border-bottom-left-radius:4px}
  .err{align-self:center;background:#fee2e2;color:#991b1b;font-size:12px;border-radius:8px;padding:4px 10px}
  form{position:absolute;left:0;right:0;bottom:0;display:flex;gap:8px;padding:10px;background:#fff;border-top:1px solid #e4e4ef}
  input{flex:1;border:1px solid #d7d7e5;border-radius:8px;padding:10px;font:inherit;outline:none}
  button{border:0;background:#4f46e5;color:#fff;border-radius:8px;padding:0 16px;font:inherit;cursor:pointer}
</style>
</head>
<body>
<div id="log"></div>
<form id="f"><input id="i" autocomplete="off" placeholder="Type a message"><button>Send</button></form>
<script>
(function () {
  'use strict';
  var key = ${JSON.stringify(publicKey)};
  var log = document.getElementById('log');
  var form = document.getElementById('f');
  var input = document.getElementById('i');
  var es = null;
  var lastSeq = 0;
  var pendingRuns = 0;
  var greeting = ${JSON.stringify(greeting)};
  function add(cls, text) {
    var d = document.createElement('div');
    d.className = 'm ' + cls;
    d.textContent = text;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    return d;
  }
  // History + incremental rendering from the session-conversation messages.
  function refreshMessages() {
    return fetch('/public/channels/' + encodeURIComponent(key) + '/messages?after=' + lastSeq, {
      credentials: 'include'
    }).then(function (r) {
      if (!r.ok) return null;
      return r.json();
    }).then(function (page) {
      if (!page) return;
      (page.messages || []).forEach(function (m) {
        if (m.sequence <= lastSeq) return;
        lastSeq = m.sequence;
        if (m.role === 'user' || m.role === 'assistant') add(m.role === 'user' ? 'user' : 'bot', m.text || '');
      });
    }).catch(function () { /* transient — next fetch retries */ });
  }
  // Terminal stream events carry ids, not text — refresh from messages.
  function watch(runId) {
    if (es) es.close();
    es = new EventSource('/public/channels/' + encodeURIComponent(key) + '/stream?run_id=' + encodeURIComponent(runId));
    ['run.completed', 'run.failed', 'terminal', 'message'].forEach(function (name) {
      es.addEventListener(name, function () {
        es.close();
        es = null;
        pendingRuns = Math.max(0, pendingRuns - 1);
        if (pendingRuns === 0) refreshMessages();
      });
    });
    es.onerror = function () { es.close(); es = null; };
  }
  refreshMessages();
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    add('user', text);
    fetch('/public/channels/' + encodeURIComponent(key) + '/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ text: text })
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (b) { throw new Error((b.error && b.error.message) || ('HTTP ' + r.status)); });
      return r.json();
    }).then(function (res) {
      if (res && res.run_id) {
        pendingRuns += 1;
        watch(res.run_id);
      }
    }).catch(function (err) {
      add('err', err.message || 'Could not send the message.');
    });
  });
})();
</script>
</body>
</html>
`;
}
