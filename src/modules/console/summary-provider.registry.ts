import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../common/infra/redis.service';
import { cardSchema, ProductCard, SummaryProvider } from './manifest.schema';
import { ManifestRegistryService } from './manifest-registry.service';

/**
 * The summary-provider registry (C-3). Product modules register a provider
 * for their key; the console home gathers cards by calling the provider
 * IN-PROCESS (no HTTP hop), caching the validated result per (org, product)
 * for the manifest's cache_seconds. A provider that is absent, throws, or
 * returns a malformed card degrades to the empty-KPI fallback — the home
 * endpoint never fails because one product card failed (that is the
 * "fake-product cannot drift the contract" behavior, enforced at runtime).
 */
@Injectable()
export class SummaryProviderRegistry {
  private readonly logger = new Logger(SummaryProviderRegistry.name);
  private readonly providers = new Map<string, SummaryProvider>();

  constructor(
    private readonly registry: ManifestRegistryService,
    private readonly redis: RedisService,
  ) {}

  register(provider: SummaryProvider): void {
    if (!this.registry.get(provider.productKey)) {
      throw new Error(`summary provider registered for unknown product key: ${provider.productKey}`);
    }
    this.providers.set(provider.productKey, provider);
  }

  has(productKey: string): boolean {
    return this.providers.has(productKey);
  }

  /**
   * Resolve the card for (org, product) with cache + fallback. `status` is
   * injected by the caller from the entitlement state — the platform owns
   * the state machine; providers never assert status.
   */
  async cardFor(orgId: string, productKey: string): Promise<ProductCard> {
    const manifest = this.registry.get(productKey);
    if (!manifest) {
      return { product: productKey, kpis: [], alerts: [] };
    }
    const cacheKey = `console:card:${orgId}:${productKey}`;
    const ttl = manifest.summary_provider.cache_seconds;

    const cached = await this.redis.raw.get(cacheKey).catch(() => null);
    if (cached) {
      const parsed = cardSchema.safeParse(JSON.parse(cached));
      if (parsed.success) {
        return parsed.data;
      }
    }

    const provider = this.providers.get(productKey);
    let card: ProductCard = { product: productKey, kpis: [], alerts: [] };
    if (provider) {
      try {
        const raw = await provider.summarize(orgId);
        const parsed = cardSchema.safeParse(raw);
        if (parsed.success) {
          card = parsed.data;
        } else {
          this.logger.warn(`summary provider for ${productKey} returned an invalid card — falling back to empty KPIs`);
        }
      } catch (err) {
        this.logger.warn(`summary provider for ${productKey} failed: ${(err as Error).message} — falling back to empty KPIs`);
      }
    }
    await this.redis.raw.set(cacheKey, JSON.stringify(card), 'EX', ttl).catch(() => undefined);
    return card;
  }

  /** Invalidate on entitlement transitions so state-adjacent cards refresh. */
  async invalidate(orgId: string, productKey: string): Promise<void> {
    await this.redis.raw.del(`console:card:${orgId}:${productKey}`).catch(() => undefined);
  }
}
