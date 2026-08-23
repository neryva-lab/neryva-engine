import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { parse } from 'yaml';
import { manifestSchema, ProductManifest } from './manifest.schema';

/** Override token for tests/tools; production uses the default directory. */
export const MANIFESTS_DIR = 'MANIFESTS_DIR';

/**
 * The manifest registry (C-1): versioned YAML artifacts in
 * products_manifests/, loaded and validated once at boot. The console
 * shell, the contract-composition script, and the home endpoint all render
 * from this single in-memory source — adding a product adds a manifest,
 * never shell code.
 *
 * Boot-time checks (fail loudly):
 *  - every file parses and validates against the zod schema
 *  - keys are unique
 *  - stage=ga manifests declare a summary provider route and a base route
 *    when they have a control face
 */
@Injectable()
export class ManifestRegistryService implements OnModuleInit {
  private readonly logger = new Logger(ManifestRegistryService.name);
  private readonly manifests = new Map<string, ProductManifest>();

  constructor(@Optional() @Inject(MANIFESTS_DIR) private readonly manifestsDir?: string) {}

  private get dir(): string {
    return this.manifestsDir ?? join(process.cwd(), 'products_manifests');
  }

  onModuleInit(): void {
    this.load();
  }

  load(): void {
    this.manifests.clear();
    const files = readdirSync(this.dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
    if (files.length === 0) {
      throw new Error(`no product manifests found in ${this.dir}`);
    }
    for (const file of files.sort()) {
      const raw = readFileSync(join(this.dir, file), 'utf8');
      const parsed = manifestSchema.safeParse(parse(raw));
      if (!parsed.success) {
        throw new Error(`invalid manifest ${file}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      }
      const manifest = parsed.data;
      if (this.manifests.has(manifest.key)) {
        throw new Error(`duplicate product key "${manifest.key}" (manifest ${file})`);
      }
      if (manifest.stage === 'ga') {
        if (manifest.faces.control && !manifest.console) {
          throw new Error(`manifest ${manifest.key}: stage=ga with a control face requires console.base_route`);
        }
      }
      this.manifests.set(manifest.key, manifest);
      this.logger.log(`manifest loaded: ${manifest.key} (stage=${manifest.stage})`);
    }
  }

  get(key: string): ProductManifest | null {
    return this.manifests.get(key) ?? null;
  }

  /** Unknown key → null; the caller 404s (the C-1 gate). */
  require(key: string): ProductManifest {
    const manifest = this.manifests.get(key);
    if (!manifest) {
      throw new Error(`unknown product key: ${key}`);
    }
    return manifest;
  }

  list(options: { includeDeprecated?: boolean } = {}): ProductManifest[] {
    return [...this.manifests.values()]
      .filter((m) => options.includeDeprecated || m.stage !== 'deprecated')
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  /** Manifests whose satellite owns runtime route prefixes (for the composed contract's owner map). */
  satelliteOwners(): Array<{ key: string; prefixes: string[] }> {
    return this.list({ includeDeprecated: true })
      .filter((m) => m.faces.runtime === 'external' && m.satellite_runtime_routes.length > 0)
      .map((m) => ({ key: m.key, prefixes: m.satellite_runtime_routes }));
  }
}
