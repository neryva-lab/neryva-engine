import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('toolchain baseline — Phase 0.4', () => {
  it('TypeScript strict mode is enabled (no implicit any)', () => {
    const tsconfig = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'tsconfig.json'), 'utf8')) as {
      compilerOptions?: { strict?: boolean; noImplicitAny?: boolean };
    };
    expect(tsconfig.compilerOptions?.strict).toBe(true);
  });

  it('vitest runs with coverage provider v8', () => {
    const config = readFileSync(join(import.meta.dirname, '..', '..', 'vitest.config.ts'), 'utf8');
    expect(config).toMatch(/provider:\s*['"]v8['"]/);
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
