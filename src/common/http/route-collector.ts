/**
 * Route collection for the boot-time bijection check (K-5 / gap C-1).
 *
 * main.ts registers a Fastify `onRoute` hook IMMEDIATELY after app creation
 * (before Nest registers controllers during init/listen) — the hook is the
 * documented, stable way to observe every route the server will serve,
 * including prefixes and param templates.
 *
 * The collector is process-global by design: main.ts fills it, the
 * verifier (console module or bootstrap) drains it once, after which it is
 * frozen. No request-path code ever touches it.
 */
const collected: string[] = [];

export function rememberRoute(url: string): void {
  if (collected.indexOf(url) === -1) {
    collected.push(url);
  }
}

export function collectedRoutes(): readonly string[] {
  return collected;
}

/** Reset (tests only). */
export function resetCollectedRoutes(): void {
  collected.length = 0;
}
