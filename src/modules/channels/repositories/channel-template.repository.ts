/**
 * Channel-template repository (P3) — the persistence port for
 * `channel_message_templates` (provider-approved outbound templates,
 * WhatsApp class).
 *
 * Each method owns its transaction. No transaction handle or callback leaks
 * through this interface — callers get plain domain results.
 *
 * Tenant discipline: every method takes the organization id explicitly. The
 * PostgreSQL implementation applies it via `DbService.withOrg` (RLS); the
 * MongoDB implementation applies it as an explicit `organization_id`
 * predicate on every tenant collection access.
 *
 * Row types are imported as *types only* from the module schema — the
 * interface carries no drizzle runtime dependency.
 */
import type { ChannelMessageTemplate } from '../schema';

export interface IChannelTemplateRepository {
  /**
   * Create a template for an account. Throws `not_found('channel account')`
   * when the account is missing or foreign, and `conflict` when a template
   * with the same (account, name, language) already exists
   * (`onConflictDoNothing` on the unique key — no silent overwrite).
   */
  createTemplate(input: {
    orgId: string;
    accountId: string;
    name: string;
    language: string;
    bodyText: string;
    variables: string[];
    providerTemplateId: string | null;
    createdBy: string;
  }): Promise<ChannelMessageTemplate>;

  listTemplates(orgId: string, accountId?: string): Promise<ChannelMessageTemplate[]>;

  /** Throws `not_found('template')` when the row is missing or foreign. */
  setTemplateStatus(
    orgId: string,
    templateId: string,
    status: 'draft' | 'approved' | 'rejected' | 'archived',
  ): Promise<ChannelMessageTemplate>;
}
