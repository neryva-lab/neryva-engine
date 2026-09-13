import { index, integer, jsonb, numeric, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { assistantVersions } from '../assistants/schema';

/**
 * Eval harness (FL-2.21, drizzle/0040). Engine is the system of record;
 * Studio's eval-worker executes and writes results back.
 */
export const evalDatasets = pgTable(
  'eval_datasets',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    name: varchar('name', { length: 128 }).notNull(),
    description: varchar('description', { length: 2048 }),
    createdBy: varchar('created_by', { length: 128 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('uq_eval_datasets_org_name').on(t.organizationId, t.name)],
);

export const evalCases = pgTable(
  'eval_cases',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    datasetId: uuid('dataset_id')
      .notNull()
      .references(() => evalDatasets.id, { onDelete: 'cascade' }),
    input: jsonb('input').notNull(),
    expected: jsonb('expected').notNull(),
    rubric: jsonb('rubric'),
    sequence: integer('sequence').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [index('ix_eval_cases_dataset').on(t.organizationId, t.datasetId, t.sequence)],
);

export const evalRuns = pgTable(
  'eval_runs',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    datasetId: uuid('dataset_id')
      .notNull()
      .references(() => evalDatasets.id),
    assistantVersionId: uuid('assistant_version_id')
      .notNull()
      .references(() => assistantVersions.id),
    /** pending | running | completed | failed */
    state: varchar('state', { length: 32 }).notNull().default('pending'),
    attemptsPerCase: integer('attempts_per_case').notNull().default(1),
    results: jsonb('results'),
    score: numeric('score', { precision: 5, scale: 4 }),
    startedBy: varchar('started_by', { length: 128 }).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'string' }),
    /**
     * TPL-7.4 — EvaluationRun provenance: template slug@version + definition
     * hash, dataset content hash, evaluator versions, model + catalog refs,
     * tool-catalog snapshot hash, knowledge pins, guardrail ref, compiler
     * version, environment, seed, attempts_per_case, decision inputs.
     * Score-only provenance is a bug — this column is the fix.
     */
    provenance: jsonb('provenance'),
    /** TPL-6.1/7.3 — PASS | WARN | BLOCK (null = undecided, e.g. legacy runs). */
    decision: varchar('decision', { length: 16 }),
    /** Release policy version the decision was computed under (null when ad-hoc). */
    releasePolicyVersion: integer('release_policy_version'),
  },
  (t) => [index('ix_eval_runs_org_dataset').on(t.organizationId, t.datasetId, t.startedAt)],
);

/**
 * FL-3.13 — online LLM-as-judge verdicts on sampled production runs. One row
 * per run (unique anchor: a re-judged run updates nothing — judgments are
 * append-only records; a re-drive creates a NEW run). Scores/verdicts only:
 * transcript content is re-read through the claim-check path at display time
 * and never copied into the judgment row.
 */
export const runJudgments = pgTable(
  'run_judgments',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id').notNull(),
    assistantVersionId: uuid('assistant_version_id').notNull(),
    judgeModel: varchar('judge_model', { length: 128 }).notNull().default(''),
    rubric: varchar('rubric', { length: 2048 }).notNull().default(''),
    score: numeric('score', { precision: 5, scale: 4 }).notNull(),
    verdict: jsonb('verdict'),
    /** completed | failed */
    state: varchar('state', { length: 16 }).notNull().default('completed'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_run_judgments_run').on(t.runId),
    index('ix_run_judgments_org_created').on(t.organizationId, t.createdAt),
  ],
);

export type RunJudgment = typeof runJudgments.$inferSelect;

// avoids a circular import at module top (runs lives in conversations/schema)
import { runs } from '../conversations/schema';
