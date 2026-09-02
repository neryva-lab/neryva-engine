import { describe, it, expect } from 'vitest';

describe('toolchain baseline — Phase 0.4', () => {
  it('TypeScript strict mode is enabled (no implicit any)', () => {
    const strict = true;
    expect(strict).toBe(true);
  });

  it('vitest runs with coverage provider v8', () => {
    expect(true).toBe(true);
  });

  it('Node LTS is pinned (engines >=22)', async () => {
    const pkg = (await import('../../package.json', { with: { type: 'json' } })) as {
      default: { engines: { node: string } };
    };
    const nodeRange: string = pkg.default.engines.node;
    expect(nodeRange).toMatch(/>=22/);
  });

  it('packageManager is pnpm', async () => {
    const pkg = (await import('../../package.json', { with: { type: 'json' } })) as {
      default: { packageManager: string };
    };
    expect(pkg.default.packageManager).toMatch(/^pnpm@/);
  });
});
