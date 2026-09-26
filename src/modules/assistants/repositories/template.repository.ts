/**
 * Template repository (P3) — the persistence port for the agent-template
 * plane (`TemplatesService`: registry listing, install, provisioning).
 *
 * Each method owns its transaction: the implementation opens the unit of
 * work, runs all reads/writes inside it, and commits or rolls back as one.
 * No transaction handle or callback leaks through this interface — callers
 * get plain domain results. `installTemplateCopy` is the one wide write:
 * the org template-block verdict, the assistants insert, the DRAFT version
 * insert, the assistant_installs insert, and the
 * `template.install_provisioning` outbox event all commit in the SAME
 * transaction (outbox invariant: the event is written with the fact it
 * announces).
 *
 * Tenant discipline: the registry tables (`assistant_templates`,
 * template platform blocks) are GLOBAL — root posture on pg, unscoped
 * collections on mongo — so `listRegistryTemplates` and
 * `findActivePlatformBlock` take no orgId; the service filters
 * `family='test'` rows out in code. Every install-side method takes the
 * organization id explicitly (first parameter or inside `input`).
 * `orgHasReadyDocuments` is a cross-domain probe on
 * `knowledge.documents` (a foreign-owned table): ownership migrates to
 * the knowledge module's port later and this method is then deleted —
 * it is here only because the template install path needs the check today.
 *
 * Row types are imported as *types only* from the module schema — the
 * interface carries no drizzle runtime dependency. Both implementations
 * return objects matching these shapes (the MongoDB implementation maps BSON
 * documents, including Binary subtype-4 UUIDs, back to them).
 *
 * What stays OUT of the repository (still the service's job):
 * - input validation (`assertUuid`, slug/version format, limit clamps)
 * - tracing spans (`withSpan`)
 * - audit writes (replayed by the service from inputs + results)
 * - registry sync (`templates:sync` release-job upserts stay in the job)
 * - template compatibility reasons (computed by the service from rows)
 */
import type {
  Assistant,
  AssistantInstall,
  AssistantTemplate,
  AssistantVersion,
} from '../schema';

/**
 * The normalized definition copied into the installed assistant's DRAFT
 * version: already-resolved normalized values, never a live reference to
 * the registry row.
 */
export interface InstallCopyDefinition {
  modelPolicy: unknown;
  contextPolicy: unknown;
  toolPolicy: unknown;
  knowledgePolicy: unknown | null;
  guardrailPolicy: unknown;
  instructions: string | null;
  modelParams: unknown | null;
  budgetPolicy: unknown | null;
}

export interface InstallTemplateCopyInput {
  orgId: string;
  name: string;
  description: string | null;
  templateSlug: string;
  templateVersion: string;
  template: AssistantTemplate;
  definition: InstallCopyDefinition;
  definitionHash: string;
  actorId: string;
}

export interface ITemplateRepository {
  /**
   * Global registry mirror (root posture on pg; unscoped collection on
   * mongo). The service filters `family='test'` rows in code.
   */
  listRegistryTemplates(): Promise<AssistantTemplate[]>;

  getTemplateBySlugAndVersion(
    slug: string,
    version: string,
  ): Promise<AssistantTemplate | null>;

  listTemplateRowsBySlug(slug: string, limit: number): Promise<AssistantTemplate[]>;

  /** Global table: the platform-wide block for a template slug, if active. */
  findActivePlatformBlock(slug: string): Promise<{ id: string; reason: string } | null>;

  listInstalls(orgId: string, limit: number): Promise<AssistantInstall[]>;

  getInstallByAssistantId(
    orgId: string,
    assistantId: string,
  ): Promise<AssistantInstall | null>;

  /**
   * One-TX install: org template-block verdict + assistants insert +
   * DRAFT version insert + assistant_installs insert +
   * `template.install_provisioning` outbox event in the SAME transaction.
   * Domain errors: `code: 'duplicate_assistant_name'` on an org-unique
   * name conflict; `code: 'template_blocked'` on the TPL-6.3 check.
   */
  installTemplateCopy(input: InstallTemplateCopyInput): Promise<{
    assistant: Assistant;
    version: AssistantVersion;
    install: AssistantInstall;
  }>;

  /**
   * Cross-domain probe on knowledge.documents (foreign-owned table).
   * Ownership migrates to the knowledge module's port later; this method
   * is deleted at that point.
   */
  orgHasReadyDocuments(orgId: string): Promise<boolean>;
}
