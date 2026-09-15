import { and, eq } from 'drizzle-orm';
import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../common/infra/db/db.service';
import type { OutboxEvent } from '../common/infra/outbox/schema';
import { PermanentConsumerError, type OutboxConsumer } from '../common/infra/outbox/consumer';
import { assistants, assistantVersions, assistantTemplates, assistantInstalls } from '../modules/assistants/schema';
import { toolCatalog } from '../modules/assistants/tool-catalog.schema';
import { BUILT_IN_TOOLS } from '../modules/assistants/tool-catalog.service';
import { documents } from '../modules/knowledge/schema';
import { evalCases, evalDatasets } from '../modules/knowledge/eval.schema';
import { uuidv7 } from '../common/ids/uuidv7';

/**
 * Template provisioning consumer — TPL-2.3.
 *
 * Consumes `template.install_provisioning` (emitted in the install TX,
 * TPL-2.2) and performs the async half of install:
 *
 *  (a) tool-pin pre-resolution — every non-built-in entry of the installed
 *      DRAFT version's tool_policy resolves to an ENABLED tool_catalog row
 *      (built-ins resolve by name; schema_hash drift fails);
 *  (b) knowledge-seed check — every required seed matches ≥1 READY document
 *      (title equality or slug segment of the tenant-bound object key);
 *  (c) eval-dataset seeding — org-scoped `template:<slug>@<version>` dataset
 *      + cases from the template's eval_ref (marked as test data).
 *
 * Failure taxonomy (deliberate, not incidental):
 *  - retryable Error — operator-fixable state (tool row added later,
 *    documents ingested later). The dispatcher backs off and retries;
 *    sustained failure dead-letters for operator replay. Identity rows are
 *    untouched — the install stays a DRAFT until provisioning succeeds.
 *  - PermanentConsumerError — registry-authoring defects or vanished
 *    identity (retry can never fix). Dead-letters immediately.
 *
 * All writes happen in ONE withOrg TX and every seed is idempotent
 * (dataset by org+name UQ, cases by existing-sequence diff), so a crash
 * between steps or a redelivered event converges instead of duplicating.
 */
@Injectable()
export class TemplateProvisioningConsumer implements OutboxConsumer {
  private static readonly logger = new Logger(TemplateProvisioningConsumer.name);

  readonly name = 'template-provisioning';
  readonly eventTypes = ['template.install_provisioning'];

  constructor(private readonly db: DbService) {}

  async handle(event: OutboxEvent): Promise<void> {
    const payload = (event.payload ?? {}) as { install_id?: string; assistant_id?: string; template_slug?: string; template_version?: string };
    const orgId = event.organizationId;
    const installId = payload.install_id ?? event.aggregateId;
    if (!installId || !payload.assistant_id || !payload.template_slug || !payload.template_version) {
      throw new PermanentConsumerError(`template.install_provisioning payload incomplete (event ${event.eventId})`);
    }

    await this.db.withOrg(orgId, async (tx) => {
      const installRows = await tx
        .select()
        .from(assistantInstalls)
        .where(and(eq(assistantInstalls.id, installId), eq(assistantInstalls.organizationId, orgId)))
        .limit(1);
      const install = installRows[0];
      if (!install) {
        // Assistant delete cascades to the install row — nothing to provision.
        throw new PermanentConsumerError(`install ${installId} vanished before provisioning`);
      }
      const templateRows = await tx
        .select()
        .from(assistantTemplates)
        .where(and(eq(assistantTemplates.slug, install.slug), eq(assistantTemplates.version, install.templateVersion)))
        .limit(1);
      const template = templateRows[0];
      if (!template) {
        throw new PermanentConsumerError(`registry row ${install.slug}@${install.templateVersion} vanished before provisioning`);
      }
      const versionRows = await tx
        .select()
        .from(assistantVersions)
        .where(and(eq(assistantVersions.assistantId, install.assistantId), eq(assistantVersions.status, 'DRAFT')))
        .limit(1);
      const draft = versionRows[0];
      if (!draft) {
        throw new PermanentConsumerError(`install ${installId} has no DRAFT version left to provision`);
      }
      const assistantRows = await tx.select().from(assistants).where(eq(assistants.id, install.assistantId)).limit(1);
      if (assistantRows.length === 0) {
        throw new PermanentConsumerError(`assistant ${install.assistantId} vanished before provisioning`);
      }

      await this.checkToolPins(tx as Parameters<Parameters<DbService['withOrg']>[1]>[0], orgId, draft.toolPolicy);
      await this.seedEvalDataset(tx as Parameters<Parameters<DbService['withOrg']>[1]>[0], orgId, template, install);
      await this.checkKnowledgeSeeds(tx as Parameters<Parameters<DbService['withOrg']>[1]>[0], orgId, template);
    });
    TemplateProvisioningConsumer.logger.log(`provisioned install ${installId} (${payload.template_slug}@${payload.template_version})`);
  }

  // ── (a) tool pins ────────────────────────────────────────────────────

  private async checkToolPins(tx: Tx, orgId: string, toolPolicy: unknown): Promise<void> {
    const tools = (toolPolicy as { tools?: Array<{ name?: string; schema_hash?: string }> } | null)?.tools ?? [];
    const pinned = tools.map((t) => t?.name).filter((n): n is string => typeof n === 'string' && n.length > 0);
    const catalogNames = pinned.filter((n) => !BUILT_IN_TOOLS.has(n));
    if (catalogNames.length === 0) {
      return;
    }
    const rows = await tx
      .select({ name: toolCatalog.name, hash: toolCatalog.hash, enabled: toolCatalog.enabled })
      .from(toolCatalog)
      .where(eq(toolCatalog.organizationId, orgId));
    const byName = new Map(rows.map((r) => [r.name, r]));
    const problems: string[] = [];
    for (const entry of tools) {
      if (!entry?.name || BUILT_IN_TOOLS.has(entry.name)) {
        continue;
      }
      const row = byName.get(entry.name);
      if (!row || !row.enabled) {
        problems.push(`${entry.name}: no ENABLED tool_catalog row at this org`);
        continue;
      }
      if (entry.schema_hash !== undefined && entry.schema_hash !== row.hash) {
        problems.push(`${entry.name}: schema_hash drift — catalog changed after install`);
      }
    }
    if (problems.length > 0) {
      // Retryable: an operator adding/enabling the catalog row unblocks the
      // next delivery without touching identity rows.
      throw new Error(`template tool pins unresolved: ${problems.join('; ')}`);
    }
  }

  // ── (c) eval seeding ─────────────────────────────────────────────────
  //
  // eval_ref contract (assembled by the TPL-3.1 release job from
  // eval/cases.jsonl + evaluators.yaml + rubric.md — bounded small JSON,
  // safe as a row value, never a claim-check):
  //   { evaluators: [...], rubric: {...}, cases: [{ input, context_refs,
  //     expected_behavior, must_cite, must_not, tools_expected }] }

  private async seedEvalDataset(tx: Tx, orgId: string, template: { slug: string; version: string; evalRef: unknown }, install: { id: string }): Promise<void> {
    const ref = (template.evalRef ?? {}) as {
      evaluators?: unknown;
      rubric?: unknown;
      cases?: Array<{ input?: string; context_refs?: string[]; expected_behavior?: string; must_cite?: string[]; must_not?: string[]; tools_expected?: string[] }>;
    };
    const cases = Array.isArray(ref.cases) ? ref.cases : [];
    if (cases.length === 0) {
      // Authoring defect (template lint requires ≥10 cases) — retry cannot fix.
      throw new PermanentConsumerError(`template ${template.slug}@${template.version} carries no eval cases in eval_ref`);
    }
    const datasetName = `template:${template.slug}@${template.version}`;
    await tx
      .insert(evalDatasets)
      .values({
        id: uuidv7(),
        organizationId: orgId,
        name: datasetName,
        description: `Template seed ${datasetName} (install ${install.id}) — test data, never production truth.`,
        createdBy: 'template-provisioning',
      })
      .onConflictDoNothing();
    const datasetRows = await tx
      .select({ id: evalDatasets.id })
      .from(evalDatasets)
      .where(and(eq(evalDatasets.organizationId, orgId), eq(evalDatasets.name, datasetName)))
      .limit(1);
    const datasetId = datasetRows[0]?.id;
    if (!datasetId) {
      throw new Error(`eval dataset ${datasetName} did not persist`);
    }
    const existing = await tx
      .select({ sequence: evalCases.sequence })
      .from(evalCases)
      .where(and(eq(evalCases.organizationId, orgId), eq(evalCases.datasetId, datasetId)));
    const have = new Set(existing.map((r) => r.sequence));
    let sequence = 0;
    for (const templateCase of cases) {
      sequence += 1;
      if (have.has(sequence)) {
        continue; // redelivery / retried provisioning converges
      }
      if (typeof templateCase?.input !== 'string' || templateCase.input.length === 0) {
        throw new PermanentConsumerError(`template ${template.slug}@${template.version} eval case #${sequence} has no input`);
      }
      await tx.insert(evalCases).values({
        id: uuidv7(),
        organizationId: orgId,
        datasetId,
        input: { text: templateCase.input, context_refs: templateCase.context_refs ?? [] },
        expected: {
          behavior: templateCase.expected_behavior ?? '',
          must_cite: templateCase.must_cite ?? [],
          must_not: templateCase.must_not ?? [],
          tools_expected: templateCase.tools_expected ?? [],
        },
        rubric: (ref.rubric ?? null) as Record<string, unknown> | null,
        sequence,
      });
    }
  }

  // ── (b) knowledge seeds ──────────────────────────────────────────────
  //
  // E-2: a required seed matches a ready document by exact source_slug
  // (org-unique pin address). documents.state is lowercase 'ready'
  // (chk_documents_state) — the UPPER literals belong to upload_sessions.
  // Missing seeds are retryable: ingesting+mapping the document unblocks the
  // next delivery; sustained absence dead-letters for replay.

  private async checkKnowledgeSeeds(tx: Tx, orgId: string, template: { slug: string; version: string; bindings: unknown }): Promise<void> {
    const bindings = (template.bindings ?? {}) as {
      knowledge?: { required?: Array<string | { slug?: string }>; seeds?: Array<string | { slug?: string }> };
    };
    const raw = [...(bindings?.knowledge?.required ?? []), ...(bindings?.knowledge?.seeds ?? [])];
    const seeds = raw.map((s) => (typeof s === 'string' ? s : s?.slug)).filter((s): s is string => typeof s === 'string' && s.length > 0);
    if (seeds.length === 0) {
      return;
    }
    const docs = await tx
      .select({ sourceSlug: documents.sourceSlug })
      .from(documents)
      .where(and(eq(documents.organizationId, orgId), eq(documents.state, 'ready')));
    const have = new Set(docs.map((d) => d.sourceSlug));
    const missing = seeds.filter((seed) => !have.has(seed));
    if (missing.length > 0) {
      throw new Error(`template knowledge seeds without ready documents: ${missing.join(', ')}`);
    }
  }
}

/** Drizzle transaction handle as passed by DbService.withOrg. */
type Tx = Parameters<Parameters<DbService['withOrg']>[1]>[0];
