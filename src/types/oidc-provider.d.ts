/**
 * Minimal ambient declaration for 'oidc-provider' (the installed build does
 * not ship .d.ts on this version line). The engine touches a narrow slice
 * of the surface (Provider, interaction details, a few callback args) —
 * this keeps the build honest while the factory's runtime usage stays
 * constrained to those APIs. If the package later ships types, delete this
 * file and fix the resulting strictness errors at the import sites.
 */
declare module 'oidc-provider' {
  export class Provider {
    constructor(issuer: string, configuration: Record<string, unknown>);
    /** Fastify-style mount: returns the framework request handler. */
    callback(...args: unknown[]): (...args: unknown[]) => unknown;
    interactionDetails(req: unknown, res: unknown): Promise<unknown>;
    interactionResult(req: unknown, res: unknown, result: unknown, options?: unknown): Promise<unknown>;
    interactionFinished(req: unknown, res: unknown, result: unknown, options?: unknown): Promise<void>;
    on(event: string, listener: (...args: unknown[]) => void): void;
    use(fn: unknown): void;
    [key: string]: unknown;
  }
  export default Provider;
}
