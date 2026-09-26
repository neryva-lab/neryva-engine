import { and, desc, eq } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { webhooks, type WebhookRow } from '../schema';
import type {
  CreateWebhookInput,
  IWebhookRepository,
  WebhookUpdatePatch,
} from './webhooks.repository';

/**
 * PostgreSQL implementation of `IWebhookRepository` (P3).
 *
 * Mechanical move of the `WebhooksService` webhook-row units: every method
 * owns its transaction via `DbService.withOrg` (RLS), runs all reads/writes
 * inside it, and commits or rolls back as one. No transaction handle leaks
 * through this interface.
 *
 * What stays OUT (still the service's job): URL validation (`checkWebhookUrl`),
 * event validation, the secret-hint/secret redaction, and audit writes.
 */
export class PgWebhookRepository implements IWebhookRepository {
  constructor(private readonly db: DbService) {}

  /** Insert a webhook row (one withOrg unit); returns the raw row. */
  async createWebhook(input: CreateWebhookInput): Promise<WebhookRow> {
    const inserted = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .insert(webhooks)
        .values({
          orgId: input.orgId,
          url: input.url,
          events: input.events,
          secretEnvelope: input.secretEnvelope,
          description: input.description,
          createdBy: null,
        })
        .returning(),
    );
    return inserted[0];
  }

  /** Raw row read (withOrg); the service applies the notFound mapping. */
  async getWebhook(orgId: string, webhookId: string): Promise<WebhookRow | null> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx.select().from(webhooks).where(and(eq(webhooks.id, webhookId), eq(webhooks.orgId, orgId))).limit(1),
    );
    return rows[0] ?? null;
  }

  /**
   * Bypass read by id (the worker drains the cross-org queue — the delivery
   * row is addressed by its unique id, so no tenant scope applies).
   */
  async getWebhookUnchecked(webhookId: string): Promise<WebhookRow | null> {
    const rows = await this.db.withBypass((tx) =>
      tx.select().from(webhooks).where(eq(webhooks.id, webhookId)).limit(1),
    );
    return rows[0] ?? null;
  }

  /** All webhooks of an org, newest first. */
  async listWebhooks(orgId: string): Promise<WebhookRow[]> {
    return this.db.withOrg(orgId, (tx) =>
      tx.select().from(webhooks).where(eq(webhooks.orgId, orgId)).orderBy(desc(webhooks.createdAt)),
    );
  }

  /** Subscribed + active targets for the dispatch fan-out. */
  async listActiveWebhooks(orgId: string): Promise<WebhookRow[]> {
    return this.db.withOrg(orgId, (tx) =>
      tx.select().from(webhooks).where(and(eq(webhooks.orgId, orgId), eq(webhooks.status, 'active'))),
    );
  }

  /**
   * Patch a webhook row (one withOrg unit). Returns null when the row is
   * gone (the service maps this to notFound).
   */
  async updateWebhook(orgId: string, webhookId: string, patch: WebhookUpdatePatch): Promise<WebhookRow> {
    const updated = await this.db.withOrg(orgId, (tx) =>
      tx.update(webhooks).set(patch).where(and(eq(webhooks.id, webhookId), eq(webhooks.orgId, orgId))).returning(),
    );
    // Mirrors the original `updated[0]`: undefined at runtime when the row
    // vanished between require and update (the known require/update race).
    return updated[0];
  }

  /** Delete a webhook row (cascade drops its deliveries). */
  async deleteWebhook(orgId: string, webhookId: string): Promise<void> {
    await this.db.withOrg(orgId, (tx) =>
      tx.delete(webhooks).where(and(eq(webhooks.id, webhookId), eq(webhooks.orgId, orgId))),
    );
  }

  /** Rotate the signing secret (old one dies immediately). */
  async rotateSecret(orgId: string, webhookId: string, secretEnvelope: string): Promise<void> {
    await this.db.withOrg(orgId, (tx) =>
      tx.update(webhooks).set({ secretEnvelope, updatedAt: new Date().toISOString() }).where(eq(webhooks.id, webhookId)),
    );
  }
}
