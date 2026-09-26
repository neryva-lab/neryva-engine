/**
 * eng-0001: provision all 133 engine collections on the MongoDB lane.
 *
 * Derived mechanically from `drizzle/*.sql` (migrations 0001-0074) on
 * 2026-09-26. Every `CREATE TABLE` becomes one collection; every
 * `CREATE [UNIQUE] INDEX` becomes a Mongo index; every pg `CHECK (col IN
 * (...))` becomes a JSON-schema `enum`; tenant keys (`organization_id` /
 * `org_id`) are `required` on the ~75 RLS tables (plan D6(b)).
 *
 * Deliberate deviations from a literal port (see plan D4/D6/D8):
 * - Collection names are the pg table names, snake_case preserved. The 10
 *   schema-qualified tables (`billing.*`, `product_deployment.*`) are joined
 *   with an underscore (`billing_spend_events`, ...) because dots in MongoDB
 *   collection names are legal but operationally painful. The exact pg name
 *   is kept in `pgTable` on every spec for traceability.
 * - PostgreSQL primary keys are provisioned as unique indexes on the same
 *   columns (named `pk_<collection>`). The document `_id` strategy (map the
 *   single-`id` PKs onto `_id` vs keep the surrogate ObjectId) is decided by
 *   the repository-port layer, not here; the unique index preserves the
 *   constraint either way.
 * - `vector(1536)` columns (`embeddings.embedding`, `memory_items.embedding`)
 *   are stored as arrays of numbers. NO ANN index is created: `$vectorSearch`
 *   is Atlas-only and the D8 vector-deployment decision is still open. The
 *   pg HNSW index on `memory_items.embedding` has no self-hosted equivalent.
 * - `chunks.fts` is a pg GENERATED tsvector column with a GIN index. MongoDB
 *   has no generated columns; a placeholder text index on the source column
 *   `chunks.text` is created instead. Whether the Mongo lane uses Atlas
 *   Search, self-hosted text indexes, or a sidecar is the open D8 decision —
 *   this index is explicitly a placeholder, not the final retrieval story.
 * - `citext` (`accounts.email`) becomes a unique index with collation
 *   `{ locale: 'en', strength: 2 }` (plan D7). The email-change swap's race
 *   atomicity must still be re-proven by the parity suite (P1 gate).
 * - `run_events.engine_sequence bigserial` becomes a plain number field;
 *   global ordering moves to atomic `$inc` counter documents (plan D7,
 *   `mongo/concurrency/counters.ts`).
 * - Timestamps stay ISO-8601 strings where the pg lane keeps them as such
 *   (the audit hash chain needs microsecond-exact strings; BSON Date is
 *   millisecond precision — plan pg-specific-features §16).
 * - Two conditional CHECKs are NOT translated to validators and stay
 *   application-enforced: `escalations` state/claimed_at coherence
 *   (chk_escalations_claimed) and `channel_accounts` public_key/platform
 *   coherence. They are transition invariants already serialized by locked
 *   state-machine code; JSON-schema `if/then` encodings would be brittle
 *   against the null-vs-missing distinction.
 * - JSONB columns become subdocuments (no validator constraints beyond
 *   `messages.content`'s object check); dot-notation replaces `->>`.
 *
 * Idempotence: `up()` is convergent — missing collections are created with
 * their validator, existing collections get `collMod` to converge the
 * validator, and `createIndex` is a no-op when name+spec already match (a
 * conflicting spec fails closed with IndexOptionsConflict). The migration
 * ledger (`mongo_migrations`) still guarantees exactly-once application.
 */

import type { Db, Document, IndexDescription } from 'mongodb';
import type { MongoMigration } from '../mongo-migrator';
import { sha256Hex, stableStringify } from '../migration-checksum';

/** One provisioned collection: pg table -> Mongo collection mapping. */
export interface CollectionSpec {
  /** MongoDB collection name (dots from pg schemas joined with `_`). */
  readonly name: string;
  /** Exact pg table name, schema-qualified where applicable. */
  readonly pgTable: string;
  /** `$jsonSchema` validator, if any. */
  readonly validator?: Document;
  /** Indexes to converge (PK unique index first, then pg indexes). */
  readonly indexes: IndexDescription[];
}

/**
 * All 133 engine collections. Sorted by pg table name; `pgTable` preserves
 * the exact (possibly schema-qualified) pg name for traceability.
 */
export const ENGINE_CORE_COLLECTIONS: CollectionSpec[] = [
  { // pg: account_action_tokens (drizzle/0010_identity_lifecycle.sql)
    name: "account_action_tokens",
    pgTable: "account_action_tokens",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id" ]
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_account_action_tokens",
        unique: true
      },
      {
        key: {
          token_hash: 1
        },
        name: "uq_account_action_tokens_hash",
        unique: true
      },
      {
        key: {
          account_id: 1,
          kind: 1
        },
        name: "ix_account_action_tokens_account_kind"
      },
    ],
  },
  { // pg: account_credentials (drizzle/0001_engine_core.sql)
    name: "account_credentials",
    pgTable: "account_credentials",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id" ]
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_account_credentials",
        unique: true
      },
      {
        key: {
          account_id: 1,
          kind: 1
        },
        name: "uq_account_credentials_account_kind",
        unique: true,
        // pg: WHERE kind <> 'webauthn' (drizzle/0046). $ne is NOT supported in
        // partialFilterExpression on mongod — enumerate the known non-webauthn
        // kinds instead. kind is an open varchar: if a new kind is added, add
        // it here or the uniqueness scope silently narrows.
        partialFilterExpression: {
          kind: {
            $in: ["password", "totp", "totp_pending"]
          }
        }
      },
      {
        key: {
          credential_id: 1
        },
        name: "uq_account_credentials_credential_id",
        unique: true,
        // pg: WHERE credential_id IS NOT NULL. $ne is not supported in
        // partialFilterExpression — $type: 'string' is the exact equivalent
        // for a varchar column (excludes missing and null, like IS NOT NULL).
        partialFilterExpression: {
          credential_id: {
            $type: "string"
          }
        }
      },
    ],
  },
  { // pg: account_identities (drizzle/0001_engine_core.sql)
    name: "account_identities",
    pgTable: "account_identities",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id" ]
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_account_identities",
        unique: true
      },
      {
        key: {
          provider: 1,
          subject: 1
        },
        name: "uq_account_identities_provider_subject",
        unique: true
      },
    ],
  },
  { // pg: account_onboarding (drizzle/0061_account_onboarding.sql)
    name: "account_onboarding",
    pgTable: "account_onboarding",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "account_id" ]
      }
    },
    indexes: [
      {
        key: {
          account_id: 1
        },
        name: "pk_account_onboarding",
        unique: true
      },
    ],
  },
  { // pg: account_recovery_codes (drizzle/0001_engine_core.sql)
    name: "account_recovery_codes",
    pgTable: "account_recovery_codes",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id" ]
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_account_recovery_codes",
        unique: true
      },
      {
        key: {
          account_id: 1
        },
        name: "ix_recovery_codes_account"
      },
    ],
  },
  { // pg: accounts (drizzle/0001_engine_core.sql)
    name: "accounts",
    pgTable: "accounts",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id" ]
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_accounts",
        unique: true
      },
      {
        key: {
          email: 1
        },
        name: "uq_accounts_email",
        unique: true,
        collation: {
          locale: "en",
          strength: 2
        }
      },
      {
        key: {
          deleted_at: 1
        },
        name: "ix_accounts_deleted_at",
        // pg: WHERE deleted_at IS NOT NULL — $type: 'date' is the exact
        // equivalent for a timestamptz column ($ne is unsupported here).
        partialFilterExpression: {
          deleted_at: {
            $type: "date"
          }
        }
      },
    ],
  },
  { // pg: analytics_rollups (drizzle/0040_parity_tables.sql)
    name: "analytics_rollups",
    pgTable: "analytics_rollups",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_analytics_rollups",
        unique: true
      },
      {
        key: {
          organization_id: 1,
          kind: 1,
          period_start: 1
        },
        name: "ix_analytics_rollups_org_kind"
      },
    ],
  },
  { // pg: api_keys (drizzle/0059_legacy_standalone.sql)
    name: "api_keys",
    pgTable: "api_keys",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id" ]
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_api_keys",
        unique: true
      },
      {
        key: {
          key_hash: 1
        },
        name: "uq_api_keys_key_hash",
        unique: true
      },
    ],
  },
  { // pg: approvals (drizzle/0024_mcp_authority.sql)
    name: "approvals",
    pgTable: "approvals",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          },
          state: {
            bsonType: "string",
            enum: [ "PENDING", "APPROVED", "DENIED", "EXPIRED" ],
            description: "pg CHECK state IN (PENDING, APPROVED, DENIED, EXPIRED)"
          },
          required_approvals: {
            bsonType: "int",
            minimum: 1,
            maximum: 5,
            description: "pg CHECK required_approvals BETWEEN 1 AND 5"
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_approvals",
        unique: true
      },
      {
        key: {
          run_id: 1,
          state: 1
        },
        name: "ix_approvals_run_state"
      },
      {
        key: {
          organization_id: 1,
          state: 1
        },
        name: "ix_approvals_pending_multi",
        partialFilterExpression: {
          state: "PENDING",
          required_approvals: {
            $gt: 1
          }
        }
      },
    ],
  },
  { // pg: artifacts (drizzle/0026_knowledge.sql)
    name: "artifacts",
    pgTable: "artifacts",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          },
          purpose: {
            bsonType: "string",
            enum: [ "SOURCE_DOCUMENT", "EXPORT", "CHECKPOINT", "TOOL_RESULT", "TRANSCRIPT", "COVER", "MESSAGE_ATTACHMENT", "GENERATED_MEDIA" ],
            description: "pg CHECK purpose IN (SOURCE_DOCUMENT, EXPORT, CHECKPOINT, TOOL_RESULT, TRANSCRIPT, COVER, MESSAGE_ATTACHMENT, GENERATED_MEDIA)"
          },
          scan_status: {
            bsonType: "string",
            enum: [ "pending", "clean", "infected", "skipped" ],
            description: "pg CHECK scan_status IN (pending, clean, infected, skipped)"
          },
          state: {
            bsonType: "string",
            enum: [ "active", "retiring", "purged" ],
            description: "pg CHECK state IN (active, retiring, purged)"
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_artifacts",
        unique: true
      },
      {
        key: {
          object_key: 1
        },
        name: "uq_artifacts_object_key",
        unique: true
      },
      {
        key: {
          organization_id: 1,
          purpose: 1,
          created_at: -1
        },
        name: "ix_artifacts_org_purpose"
      },
    ],
  },
  { // pg: assistant_installs (drizzle/0048_assistant_templates.sql)
    name: "assistant_installs",
    pgTable: "assistant_installs",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_assistant_installs",
        unique: true
      },
      {
        key: {
          assistant_id: 1
        },
        name: "uq_assistant_installs_assistant",
        unique: true
      },
      {
        key: {
          organization_id: 1,
          slug: 1,
          template_version: 1
        },
        name: "ix_assistant_installs_org_slug"
      },
    ],
  },
  { // pg: assistant_rollouts (drizzle/0042_fl3_frontier.sql)
    name: "assistant_rollouts",
    pgTable: "assistant_rollouts",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          },
          state: {
            bsonType: "string",
            enum: [ "active", "paused" ],
            description: "pg CHECK state IN (active, paused)"
          },
          versions: {
            bsonType: "array",
            minItems: 1,
            maxItems: 10,
            description: "pg CHECK jsonb_typeof(versions)='array' AND length 1..10"
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_assistant_rollouts",
        unique: true
      },
      {
        key: {
          organization_id: 1,
          assistant_id: 1
        },
        name: "ix_rollouts_org_assistant"
      },
      {
        key: {
          assistant_id: 1,
          environment: 1,
          channel: 1
        },
        name: "uq_rollouts_active_per_assistant_env_channel",
        unique: true,
        partialFilterExpression: {
          state: "active"
        }
      },
      {
        key: {
          organization_id: 1,
          assistant_id: 1,
          environment: 1,
          channel: 1
        },
        name: "ix_rollouts_org_assistant_env"
      },
    ],
  },
  { // pg: assistant_templates (drizzle/0048_assistant_templates.sql)
    name: "assistant_templates",
    pgTable: "assistant_templates",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "slug", "version" ],
        properties: {
          status: {
            bsonType: "string",
            enum: [ "stable", "beta", "deprecated" ],
            description: "pg CHECK status IN (stable, beta, deprecated)"
          }
        }
      }
    },
    indexes: [
      {
        key: {
          slug: 1,
          version: 1
        },
        name: "pk_assistant_templates",
        unique: true
      },
      {
        key: {
          status: 1
        },
        name: "ix_assistant_templates_status"
      },
      {
        key: {
          family: 1
        },
        name: "ix_assistant_templates_family"
      },
    ],
  },
  { // pg: assistant_versions (drizzle/0020_assistants.sql)
    name: "assistant_versions",
    pgTable: "assistant_versions",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          },
          status: {
            bsonType: "string",
            enum: [ "DRAFT", "VALIDATING", "VALID", "PUBLISHED", "RETIRED", "ROLLED_BACK" ],
            description: "pg CHECK status IN (DRAFT, VALIDATING, VALID, PUBLISHED, RETIRED, ROLLED_BACK)"
          },
          instructions: {
            bsonType: "string",
            maxLength: 32768,
            description: "pg CHECK char_length(instructions) <= 32768"
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_assistant_versions",
        unique: true
      },
      {
        key: {
          assistant_id: 1,
          version: 1
        },
        name: "uq_assistant_versions_assistant_version",
        unique: true
      },
      {
        key: {
          id: 1,
          organization_id: 1
        },
        name: "uq_assistant_versions_id_org",
        unique: true
      },
      {
        key: {
          organization_id: 1,
          assistant_id: 1,
          version: 1
        },
        name: "ix_assistant_versions_org_assistant"
      },
      {
        key: {
          organization_id: 1,
          status: 1
        },
        name: "ix_assistant_versions_org_status"
      },
    ],
  },
  { // pg: assistants (drizzle/0020_assistants.sql)
    name: "assistants",
    pgTable: "assistants",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_assistants",
        unique: true
      },
      {
        key: {
          organization_id: 1,
          name: 1
        },
        name: "uq_assistants_org_name",
        unique: true
      },
      {
        key: {
          organization_id: 1,
          updated_at: 1
        },
        name: "ix_assistants_org"
      },
    ],
  },
  { // pg: audit_events (drizzle/0059_legacy_standalone.sql)
    name: "audit_events",
    pgTable: "audit_events",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id" ]
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_audit_events",
        unique: true
      },
      {
        key: {
          tenant_id: 1,
          created_at: 1
        },
        name: "ix_audit_tenant_created"
      },
    ],
  },
  { // pg: billing_adjustments (drizzle/0014_billing_money.sql)
    name: "billing_adjustments",
    pgTable: "billing_adjustments",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "org_id" ],
        properties: {
          org_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_billing_adjustments",
        unique: true
      },
      {
        key: {
          org_id: 1,
          product: 1
        },
        name: "ix_billing_adjustments_org_product"
      },
      {
        key: {
          applied_invoice_id: 1
        },
        name: "uq_billing_adjustments_applied",
        unique: true,
        // pg: WHERE applied_invoice_id IS NOT NULL — $type: 'binData' is the
        // exact equivalent for a UUID-as-Binary column ($ne is unsupported).
        partialFilterExpression: {
          applied_invoice_id: {
            $type: "binData"
          }
        }
      },
    ],
  },
  { // pg: billing_budgets (drizzle/0014_billing_money.sql)
    name: "billing_budgets",
    pgTable: "billing_budgets",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "org_id" ],
        properties: {
          org_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_billing_budgets",
        unique: true
      },
      {
        key: {
          org_id: 1
        },
        name: "ix_billing_budgets_org"
      },
    ],
  },
  { // pg: billing_credit_applications (drizzle/0014_billing_money.sql)
    name: "billing_credit_applications",
    pgTable: "billing_credit_applications",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "org_id" ],
        properties: {
          org_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_billing_credit_applications",
        unique: true
      },
      {
        key: {
          invoice_id: 1
        },
        name: "ix_billing_credit_apps_invoice"
      },
    ],
  },
  { // pg: billing_credits (drizzle/0014_billing_money.sql)
    name: "billing_credits",
    pgTable: "billing_credits",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "org_id" ],
        properties: {
          org_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_billing_credits",
        unique: true
      },
      {
        key: {
          org_id: 1,
          expires_at: 1
        },
        name: "ix_billing_credits_org"
      },
    ],
  },
  { // pg: billing_invoice_lines (drizzle/0014_billing_money.sql)
    name: "billing_invoice_lines",
    pgTable: "billing_invoice_lines",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "org_id" ],
        properties: {
          org_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_billing_invoice_lines",
        unique: true
      },
      {
        key: {
          invoice_id: 1
        },
        name: "ix_billing_invoice_lines_invoice"
      },
    ],
  },
  { // pg: billing.billing_invoices (drizzle/0004_billing_metering.sql)
    name: "billing_billing_invoices",
    pgTable: "billing.billing_invoices",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id" ]
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_billing_billing_invoices",
        unique: true
      },
      {
        key: {
          org_id: 1,
          product: 1,
          period_start: 1
        },
        name: "uq_billing_invoices_org_product_period",
        unique: true
      },
      {
        key: {
          org_id: 1,
          status: 1
        },
        name: "ix_billing_invoices_org_status"
      },
    ],
  },
  { // pg: billing_webhook_inbox (drizzle/0027_billing_ledger.sql)
    name: "billing_webhook_inbox",
    pgTable: "billing_webhook_inbox",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id" ],
        properties: {
          reconciliation_status: {
            bsonType: "string",
            enum: [ "none", "required", "completed" ],
            description: "pg CHECK reconciliation_status IN (none, required, completed)"
          },
          state: {
            bsonType: "string",
            enum: [ "received", "signature_validated", "deduplicated", "processed", "rejected", "reconciliation_required" ],
            description: "pg CHECK state IN (received, signature_validated, deduplicated, processed, rejected, reconciliation_required)"
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_billing_webhook_inbox",
        unique: true
      },
    ],
  },
  { // pg: career_applications (drizzle/0003_corporate_public.sql)
    name: "career_applications",
    pgTable: "career_applications",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id" ]
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_career_applications",
        unique: true
      },
      {
        key: {
          created_at: 1
        },
        name: "ix_career_applications_created"
      },
      {
        key: {
          status: 1,
          created_at: 1
        },
        name: "ix_career_applications_status"
      },
    ],
  },
  { // pg: career_jobs (drizzle/0013_corporate_depth.sql)
    name: "career_jobs",
    pgTable: "career_jobs",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id" ]
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_career_jobs",
        unique: true
      },
      {
        key: {
          slug: 1
        },
        name: "uq_career_jobs_slug",
        unique: true
      },
      {
        key: {
          status: 1
        },
        name: "ix_career_jobs_status"
      },
    ],
  },
  { // pg: channel_accounts (drizzle/0030_channels.sql)
    name: "channel_accounts",
    pgTable: "channel_accounts",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          },
          platform: {
            bsonType: "string",
            enum: [ "whatsapp", "messenger", "telegram", "web", "instagram", "x", "email" ],
            description: "pg CHECK platform IN (whatsapp, messenger, telegram, web, instagram, x, email)"
          },
          status: {
            bsonType: "string",
            enum: [ "pending", "active", "suspended" ],
            description: "pg CHECK status IN (pending, active, suspended)"
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_channel_accounts",
        unique: true
      },
      {
        key: {
          organization_id: 1,
          platform: 1,
          display_name: 1
        },
        name: "uq_channel_accounts_org_platform_ref",
        unique: true
      },
      {
        key: {
          organization_id: 1,
          platform: 1,
          status: 1
        },
        name: "ix_channel_accounts_org"
      },
    ],
  },
  { // pg: channel_events (drizzle/0030_channels.sql)
    name: "channel_events",
    pgTable: "channel_events",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          },
          status: {
            bsonType: "string",
            enum: [ "received", "processed", "quarantined" ],
            description: "pg CHECK status IN (received, processed, quarantined)"
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_channel_events",
        unique: true
      },
      {
        key: {
          channel_account_id: 1,
          external_event_id: 1
        },
        name: "uq_channel_events_account_event",
        unique: true
      },
      {
        key: {
          channel_account_id: 1,
          status: 1,
          received_at: -1
        },
        name: "ix_channel_events_account_status"
      },
    ],
  },
  { // pg: channel_identities (drizzle/0030_channels.sql)
    name: "channel_identities",
    pgTable: "channel_identities",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_channel_identities",
        unique: true
      },
      {
        key: {
          channel_account_id: 1,
          external_user_id: 1
        },
        name: "uq_channel_identities_account_user",
        unique: true
      },
      {
        key: {
          organization_id: 1,
          channel_account_id: 1,
          last_inbound_at: -1
        },
        name: "ix_channel_identities_org"
      },
    ],
  },
  { // pg: channel_message_links (drizzle/0030_channels.sql)
    name: "channel_message_links",
    pgTable: "channel_message_links",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          },
          delivery_state: {
            bsonType: "string",
            enum: [ "pending", "sent", "delivered", "read", "failed", "skipped" ],
            description: "pg CHECK delivery_state IN (pending, sent, delivered, read, failed, skipped)"
          },
          direction: {
            bsonType: "string",
            enum: [ "inbound", "outbound" ],
            description: "pg CHECK direction IN (inbound, outbound)"
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_channel_message_links",
        unique: true
      },
      {
        key: {
          channel_account_id: 1,
          external_message_id: 1
        },
        name: "uq_channel_links_account_external",
        unique: true,
        // pg: WHERE external_message_id IS NOT NULL — $type: 'string' is the
        // exact equivalent for a varchar column ($ne is unsupported).
        partialFilterExpression: {
          external_message_id: {
            $type: "string"
          }
        }
      },
      {
        key: {
          message_id: 1
        },
        name: "uq_channel_links_outbound_message",
        unique: true,
        partialFilterExpression: {
          direction: "outbound"
        }
      },
      {
        key: {
          organization_id: 1,
          conversation_id: 1,
          created_at: 1
        },
        name: "ix_channel_links_org_conversation"
      },
      {
        key: {
          channel_account_id: 1,
          delivery_state: 1
        },
        name: "ix_channel_links_delivery",
        partialFilterExpression: {
          direction: "outbound"
        }
      },
    ],
  },
  { // pg: channel_message_templates (drizzle/0042_fl3_frontier.sql)
    name: "channel_message_templates",
    pgTable: "channel_message_templates",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          },
          status: {
            bsonType: "string",
            enum: [ "draft", "approved", "rejected", "archived" ],
            description: "pg CHECK status IN (draft, approved, rejected, archived)"
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_channel_message_templates",
        unique: true
      },
      {
        key: {
          channel_account_id: 1,
          name: 1,
          language: 1
        },
        name: "uq_channel_templates_account_name",
        unique: true
      },
      {
        key: {
          organization_id: 1,
          channel_account_id: 1
        },
        name: "ix_channel_templates_org"
      },
    ],
  },
  { // pg: channel_sessions (drizzle/0030_channels.sql)
    name: "channel_sessions",
    pgTable: "channel_sessions",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          },
          status: {
            bsonType: "string",
            enum: [ "active", "expired", "revoked" ],
            description: "pg CHECK status IN (active, expired, revoked)"
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_channel_sessions",
        unique: true
      },
      {
        key: {
          token_hash: 1
        },
        name: "uq_channel_sessions_token",
        unique: true
      },
      {
        key: {
          channel_account_id: 1,
          status: 1,
          expires_at: 1
        },
        name: "ix_channel_sessions_account_active"
      },
    ],
  },
  { // pg: checkpoints (drizzle/0024_mcp_authority.sql)
    name: "checkpoints",
    pgTable: "checkpoints",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_checkpoints",
        unique: true
      },
    ],
  },
  { // pg: chunks (drizzle/0026_knowledge.sql)
    name: "chunks",
    pgTable: "chunks",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_chunks",
        unique: true
      },
      {
        key: {
          text: "text"
        },
        name: "ix_chunks_fts"
      },
      {
        key: {
          organization_id: 1,
          document_version_id: 1
        },
        name: "ix_chunks_org_version"
      },
    ],
  },
  { // pg: config_drafts (drizzle/0016_config_publish_depth.sql)
    name: "config_drafts",
    pgTable: "config_drafts",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id" ]
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_config_drafts",
        unique: true
      },
      {
        key: {
          org_id: 1,
          scope: 1,
          product: 1
        },
        name: "uq_config_drafts_key",
        unique: true
      },
      {
        key: {
          org_id: 1,
          updated_at: 1
        },
        name: "ix_config_drafts_org"
      },
    ],
  },
  { // pg: config_notifications (drizzle/0007_satellite_surfaces.sql)
    name: "config_notifications",
    pgTable: "config_notifications",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "config_id", "satellite_key" ]
      }
    },
    indexes: [
      {
        key: {
          config_id: 1,
          satellite_key: 1
        },
        name: "pk_config_notifications",
        unique: true
      },
      {
        key: {
          satellite_key: 1,
          acked_at: 1
        },
        name: "ix_config_notifications_satellite_acked"
      },
    ],
  },
  { // pg: connector_accounts (drizzle/0039_connectors.sql)
    name: "connector_accounts",
    pgTable: "connector_accounts",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          },
          provider: {
            bsonType: "string",
            enum: [ "sitemap", "google_drive", "notion", "confluence" ],
            description: "pg CHECK provider IN (sitemap, google_drive, notion, confluence)"
          },
          state: {
            bsonType: "string",
            enum: [ "active", "paused", "error" ],
            description: "pg CHECK state IN (active, paused, error)"
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_connector_accounts",
        unique: true
      },
      {
        key: {
          organization_id: 1,
          state: 1,
          last_synced_at: 1
        },
        name: "ix_connector_accounts_org_state"
      },
    ],
  },
  { // pg: connector_documents (drizzle/0057_enterprise_knowledge_p0.sql)
    name: "connector_documents",
    pgTable: "connector_documents",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_connector_documents",
        unique: true
      },
      {
        key: {
          document_id: 1
        },
        name: "ix_connector_documents_document"
      },
    ],
  },
  { // pg: connector_oauth_apps (drizzle/0057_enterprise_knowledge_p0.sql)
    name: "connector_oauth_apps",
    pgTable: "connector_oauth_apps",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_connector_oauth_apps",
        unique: true
      },
    ],
  },
  { // pg: console_announcements (drizzle/0019_console_surface.sql)
    name: "console_announcements",
    pgTable: "console_announcements",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id" ]
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_console_announcements",
        unique: true
      },
      {
        key: {
          active_from: 1,
          active_until: 1
        },
        name: "ix_console_announcements_window"
      },
    ],
  },
  { // pg: contact_submissions (drizzle/0003_corporate_public.sql)
    name: "contact_submissions",
    pgTable: "contact_submissions",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id" ]
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_contact_submissions",
        unique: true
      },
      {
        key: {
          created_at: 1
        },
        name: "ix_contact_submissions_created"
      },
      {
        key: {
          status: 1,
          created_at: 1
        },
        name: "ix_contact_submissions_status"
      },
    ],
  },
  { // pg: content_posts (drizzle/0003_corporate_public.sql)
    name: "content_posts",
    pgTable: "content_posts",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id" ]
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_content_posts",
        unique: true
      },
      {
        key: {
          slug: 1
        },
        name: "uq_content_posts_slug",
        unique: true
      },
      {
        key: {
          status: 1,
          published_at: 1
        },
        name: "ix_content_posts_status_published"
      },
    ],
  },
  { // pg: content_revisions (drizzle/0013_corporate_depth.sql)
    name: "content_revisions",
    pgTable: "content_revisions",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id" ]
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_content_revisions",
        unique: true
      },
      {
        key: {
          post_id: 1,
          version: 1
        },
        name: "uq_content_revisions_post_version",
        unique: true
      },
    ],
  },
  { // pg: control_blocks (drizzle/0049_release_governance.sql)
    name: "control_blocks",
    pgTable: "control_blocks",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          },
          target_type: {
            bsonType: "string",
            enum: [ "assistant", "version", "tool", "template", "capability" ],
            description: "pg CHECK target_type IN (assistant, version, tool, template, capability)"
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_control_blocks",
        unique: true
      },
      {
        key: {
          organization_id: 1,
          target_type: 1,
          target_name: 1
        },
        name: "ix_control_blocks_org_target"
      },
    ],
  },
  { // pg: conversation_participants (drizzle/0022_conversations.sql)
    name: "conversation_participants",
    pgTable: "conversation_participants",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          },
          participant_type: {
            bsonType: "string",
            enum: [ "account", "service", "channel" ],
            description: "pg CHECK participant_type IN (account, service, channel)"
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_conversation_participants",
        unique: true
      },
      {
        key: {
          conversation_id: 1,
          account_id: 1
        },
        name: "uq_participants_conversation_account",
        unique: true,
        // pg: WHERE account_id IS NOT NULL — $type: 'binData' is the exact
        // equivalent for a UUID-as-Binary column ($ne is unsupported).
        partialFilterExpression: {
          account_id: {
            $type: "binData"
          }
        }
      },
      {
        key: {
          conversation_id: 1,
          external_ref: 1
        },
        name: "uq_participants_conversation_extref",
        unique: true,
        // pg: WHERE external_ref IS NOT NULL — $type: 'string' is the exact
        // equivalent for a varchar column ($ne is unsupported).
        partialFilterExpression: {
          external_ref: {
            $type: "string"
          }
        }
      },
      {
        key: {
          organization_id: 1,
          conversation_id: 1
        },
        name: "ix_participants_org_conversation"
      },
    ],
  },
  { // pg: conversation_shares (drizzle/0042_fl3_frontier.sql)
    name: "conversation_shares",
    pgTable: "conversation_shares",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_conversation_shares",
        unique: true
      },
      {
        key: {
          organization_id: 1,
          conversation_id: 1
        },
        name: "ix_conversation_shares_org_conv"
      },
    ],
  },
  { // pg: conversation_summaries (drizzle/0033_conversation_summaries.sql)
    name: "conversation_summaries",
    pgTable: "conversation_summaries",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          },
          summary: {
            bsonType: "string",
            maxLength: 8192,
            description: "pg CHECK char_length(summary) <= 8192"
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_conversation_summaries",
        unique: true
      },
      {
        key: {
          organization_id: 1,
          conversation_id: 1,
          source_sequence: -1
        },
        name: "ix_conversation_summaries_org_conv"
      },
    ],
  },
  { // pg: conversations (drizzle/0022_conversations.sql)
    name: "conversations",
    pgTable: "conversations",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          },
          status: {
            bsonType: "string",
            enum: [ "active", "archived", "deleted", "escalated" ],
            description: "pg CHECK status IN (active, archived, deleted, escalated)"
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_conversations",
        unique: true
      },
      {
        key: {
          organization_id: 1,
          updated_at: -1
        },
        name: "ix_conversations_org_updated"
      },
      {
        key: {
          organization_id: 1,
          assistant_id: 1
        },
        name: "ix_conversations_org_assistant"
      },
    ],
  },
  { // pg: corporate_content_staff (drizzle/0003_corporate_public.sql)
    name: "corporate_content_staff",
    pgTable: "corporate_content_staff",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "account_id" ]
      }
    },
    indexes: [
      {
        key: {
          account_id: 1
        },
        name: "pk_corporate_content_staff",
        unique: true
      },
    ],
  },
  { // pg: data_access_records (drizzle/0028_lifecycle.sql)
    name: "data_access_records",
    pgTable: "data_access_records",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id" ],
        properties: {
          access_type: {
            bsonType: "string",
            enum: [ "export_download", "sensitive_read", "support_access", "policy_change", "impersonation" ],
            description: "pg CHECK access_type IN (export_download, sensitive_read, support_access, policy_change, impersonation)"
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_data_access_records",
        unique: true
      },
      {
        key: {
          created_at: -1
        },
        name: "ix_dar_created"
      },
    ],
  },
  { // pg: product_deployment.deployment_events (drizzle/0005_product_deployment.sql)
    name: "product_deployment_deployment_events",
    pgTable: "product_deployment.deployment_events",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id" ]
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_product_deployment_deployment_events",
        unique: true
      },
      {
        key: {
          deployment_id: 1,
          created_at: 1
        },
        name: "ix_deployment_events_deployment_time"
      },
      {
        key: {
          org_id: 1,
          created_at: 1
        },
        name: "ix_deployment_events_org"
      },
    ],
  },
  { // pg: product_deployment.deployment_settings (drizzle/0017_deployment_dense.sql)
    name: "product_deployment_deployment_settings",
    pgTable: "product_deployment.deployment_settings",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "org_id" ]
      }
    },
    indexes: [
      {
        key: {
          org_id: 1
        },
        name: "pk_product_deployment_deployment_settings",
        unique: true
      },
    ],
  },
  { // pg: product_deployment.deployments (drizzle/0005_product_deployment.sql)
    name: "product_deployment_deployments",
    pgTable: "product_deployment.deployments",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id" ]
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_product_deployment_deployments",
        unique: true
      },
      {
        key: {
          org_id: 1,
          created_at: 1
        },
        name: "ix_deployment_deployments_org_created"
      },
      {
        key: {
          pipeline_id: 1
        },
        name: "ix_deployment_deployments_pipeline"
      },
      {
        key: {
          org_id: 1,
          status: 1
        },
        name: "ix_deployment_deployments_status"
      },
      {
        key: {
          org_id: 1,
          environment_id: 1
        },
        name: "ix_deployment_deployments_env"
      },
    ],
  },
  { // pg: document_source_acls (drizzle/0057_enterprise_knowledge_p0.sql)
    name: "document_source_acls",
    pgTable: "document_source_acls",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_document_source_acls",
        unique: true
      },
      {
        key: {
          organization_id: 1,
          document_id: 1
        },
        name: "ix_document_source_acls_org_doc"
      },
    ],
  },
  { // pg: document_versions (drizzle/0026_knowledge.sql)
    name: "document_versions",
    pgTable: "document_versions",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_document_versions",
        unique: true
      },
      {
        key: {
          document_id: 1,
          version: 1
        },
        name: "uq_document_versions_doc_version",
        unique: true
      },
    ],
  },
  { // pg: documents (drizzle/0026_knowledge.sql)
    name: "documents",
    pgTable: "documents",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          },
          state: {
            bsonType: "string",
            enum: [ "processing", "ready", "failed", "retired" ],
            description: "pg CHECK state IN (processing, ready, failed, retired)"
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_documents",
        unique: true
      },
      {
        key: {
          organization_id: 1,
          state: 1
        },
        name: "ix_documents_org_state"
      },
      {
        key: {
          organization_id: 1,
          source_slug: 1
        },
        name: "uq_documents_org_slug",
        unique: true
      },
    ],
  },
  { // pg: email_deliveries (drizzle/0001_engine_core.sql)
    name: "email_deliveries",
    pgTable: "email_deliveries",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id" ]
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_email_deliveries",
        unique: true
      },
      {
        key: {
          recipient: 1,
          created_at: 1
        },
        name: "ix_email_deliveries_recipient_created"
      },
    ],
  },
  { // pg: email_login_codes (drizzle/0001_engine_core.sql)
    name: "email_login_codes",
    pgTable: "email_login_codes",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id" ]
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_email_login_codes",
        unique: true
      },
      {
        key: {
          account_id: 1
        },
        name: "ix_email_codes_account"
      },
    ],
  },
  { // pg: email_suppressions (drizzle/0013_corporate_depth.sql)
    name: "email_suppressions",
    pgTable: "email_suppressions",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id" ]
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_email_suppressions",
        unique: true
      },
      {
        key: {
          email: 1
        },
        name: "uq_email_suppressions_email",
        unique: true
      },
    ],
  },
  { // pg: embeddings (drizzle/0026_knowledge.sql)
    name: "embeddings",
    pgTable: "embeddings",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          },
          embedding: {
            bsonType: [ "array", "null" ],
            description: "pg vector(1536): stored as an array of numbers. No ANN index in 0001 (D8 vector decision open)."
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_embeddings",
        unique: true
      },
    ],
  },
  { // pg: product_deployment.environments (drizzle/0005_product_deployment.sql)
    name: "product_deployment_environments",
    pgTable: "product_deployment.environments",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id" ]
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_product_deployment_environments",
        unique: true
      },
      {
        key: {
          org_id: 1,
          name: 1
        },
        name: "uq_deployment_environments_org_name",
        unique: true
      },
    ],
  },
  { // pg: escalations (drizzle/0037_escalations.sql)
    name: "escalations",
    pgTable: "escalations",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          },
          state: {
            bsonType: "string",
            enum: [ "WAITING", "CLAIMED", "RESOLVED" ],
            description: "pg CHECK state IN (WAITING, CLAIMED, RESOLVED)"
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_escalations",
        unique: true
      },
      {
        key: {
          organization_id: 1,
          state: 1,
          requested_at: 1
        },
        name: "ix_escalations_org_state"
      },
      {
        key: {
          organization_id: 1,
          conversation_id: 1
        },
        name: "ix_escalations_conversation"
      },
    ],
  },
  { // pg: eval_case_executions (drizzle/0052_eval_executions_and_run_kind.sql)
    name: "eval_case_executions",
    pgTable: "eval_case_executions",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          },
          state: {
            bsonType: "string",
            enum: [ "pending", "passed", "failed" ],
            description: "pg CHECK state IN (pending, passed, failed)"
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_eval_case_executions",
        unique: true
      },
      {
        key: {
          eval_run_id: 1,
          case_id: 1,
          attempt: 1
        },
        name: "uq_eval_case_executions_case_attempt",
        unique: true
      },
      {
        key: {
          organization_id: 1,
          eval_run_id: 1
        },
        name: "ix_eval_case_executions_org_run"
      },
      {
        key: {
          run_id: 1
        },
        name: "ix_eval_case_executions_run_id"
      },
    ],
  },
  { // pg: eval_cases (drizzle/0040_parity_tables.sql)
    name: "eval_cases",
    pgTable: "eval_cases",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_eval_cases",
        unique: true
      },
      {
        key: {
          organization_id: 1,
          dataset_id: 1,
          sequence: 1
        },
        name: "ix_eval_cases_dataset"
      },
    ],
  },
  { // pg: eval_datasets (drizzle/0040_parity_tables.sql)
    name: "eval_datasets",
    pgTable: "eval_datasets",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_eval_datasets",
        unique: true
      },
    ],
  },
  { // pg: eval_runs (drizzle/0040_parity_tables.sql)
    name: "eval_runs",
    pgTable: "eval_runs",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          },
          decision: {
            bsonType: [ "string", "null" ],
            enum: [ "PASS", "WARN", "BLOCK", "FAIL", null ],
            description: "pg CHECK decision IN (PASS, WARN, BLOCK, FAIL); null = undecided"
          },
          state: {
            bsonType: "string",
            enum: [ "pending", "running", "completed", "failed" ],
            description: "pg CHECK state IN (pending, running, completed, failed)"
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_eval_runs",
        unique: true
      },
      {
        key: {
          organization_id: 1,
          dataset_id: 1,
          started_at: 1
        },
        name: "ix_eval_runs_org_dataset"
      },
    ],
  },
  { // pg: export_requests (drizzle/0028_lifecycle.sql)
    name: "export_requests",
    pgTable: "export_requests",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          },
          state: {
            bsonType: "string",
            enum: [ "pending", "generating", "ready", "expired", "failed" ],
            description: "pg CHECK state IN (pending, generating, ready, expired, failed)"
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_export_requests",
        unique: true
      },
    ],
  },
  { // pg: external_identity_links (drizzle/0057_enterprise_knowledge_p0.sql)
    name: "external_identity_links",
    pgTable: "external_identity_links",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_external_identity_links",
        unique: true
      },
      {
        key: {
          organization_id: 1,
          account_id: 1
        },
        name: "ix_external_identity_links_account"
      },
    ],
  },
  { // pg: external_principals (drizzle/0057_enterprise_knowledge_p0.sql)
    name: "external_principals",
    pgTable: "external_principals",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          },
          kind: {
            bsonType: "string",
            enum: [ "user", "group", "domain" ],
            description: "pg CHECK kind IN (user, group, domain)"
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_external_principals",
        unique: true
      },
      {
        key: {
          organization_id: 1,
          email: 1
        },
        name: "ix_external_principals_org_email"
      },
    ],
  },
  { // pg: idempotency_records (drizzle/0023_async_foundation.sql)
    name: "idempotency_records",
    pgTable: "idempotency_records",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "organization_id", "principal_id", "endpoint_family", "idempotency_key" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          },
          status: {
            bsonType: "string",
            enum: [ "IN_PROGRESS", "SUCCEEDED", "FAILED_RETRYABLE", "FAILED_FINAL" ],
            description: "pg CHECK status IN (IN_PROGRESS, SUCCEEDED, FAILED_RETRYABLE, FAILED_FINAL)"
          }
        }
      }
    },
    indexes: [
      {
        key: {
          organization_id: 1,
          principal_id: 1,
          endpoint_family: 1,
          idempotency_key: 1
        },
        name: "pk_idempotency_records",
        unique: true
      },
      {
        key: {
          expires_at: 1
        },
        name: "ix_idempotency_expiry"
      },
    ],
  },
  { // pg: inbox_events (drizzle/0023_async_foundation.sql)
    name: "inbox_events",
    pgTable: "inbox_events",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "consumer_name", "event_id" ],
        properties: {
          status: {
            bsonType: "string",
            enum: [ "RECEIVED", "PROCESSING", "PROCESSED", "FAILED" ],
            description: "pg CHECK status IN (RECEIVED, PROCESSING, PROCESSED, FAILED)"
          }
        }
      }
    },
    indexes: [
      {
        key: {
          consumer_name: 1,
          event_id: 1
        },
        name: "pk_inbox_events",
        unique: true
      },
    ],
  },
  { // pg: legal_holds (drizzle/0028_lifecycle.sql)
    name: "legal_holds",
    pgTable: "legal_holds",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          },
          scope_type: {
            bsonType: "string",
            enum: [ "organization", "user", "conversation", "assistant" ],
            description: "pg CHECK scope_type IN (organization, user, conversation, assistant)"
          },
          status: {
            bsonType: "string",
            enum: [ "active", "released" ],
            description: "pg CHECK status IN (active, released)"
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_legal_holds",
        unique: true
      },
      {
        key: {
          organization_id: 1,
          scope_type: 1,
          scope_id: 1,
          status: 1
        },
        name: "ix_legal_holds_scope"
      },
    ],
  },
  { // pg: memory_items (drizzle/0026_knowledge.sql)
    name: "memory_items",
    pgTable: "memory_items",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          },
          scope_type: {
            bsonType: "string",
            enum: [ "organization", "conversation", "assistant", "user" ],
            description: "pg CHECK scope_type IN (organization, conversation, assistant, user)"
          },
          visibility: {
            bsonType: "string",
            enum: [ "organization", "private" ],
            description: "pg CHECK visibility IN (organization, private)"
          },
          embedding: {
            bsonType: [ "array", "null" ],
            description: "pg vector(1536): stored as an array of numbers. No ANN index in 0001 (D8 vector decision open)."
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_memory_items",
        unique: true
      },
      {
        key: {
          organization_id: 1,
          scope_type: 1,
          scope_id: 1
        },
        name: "ix_memory_items_scope"
      },
      {
        key: {
          organization_id: 1,
          valid_from: 1,
          invalid_at: 1
        },
        name: "ix_memory_items_validity"
      },
      {
        key: {
          organization_id: 1,
          embedding_model: 1
        },
        name: "ix_memory_items_org_model"
      },
    ],
  },
  { // pg: memory_proposals (drizzle/0024_mcp_authority.sql)
    name: "memory_proposals",
    pgTable: "memory_proposals",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          },
          decision: {
            bsonType: "string",
            enum: [ "PENDING", "APPROVED", "REJECTED" ],
            description: "pg CHECK decision IN (PENDING, APPROVED, REJECTED)"
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_memory_proposals",
        unique: true
      },
      {
        key: {
          run_id: 1,
          decision: 1
        },
        name: "ix_memory_proposals_run"
      },
    ],
  },
  { // pg: message_feedback (drizzle/0034_message_feedback.sql)
    name: "message_feedback",
    pgTable: "message_feedback",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          },
          rating: {
            bsonType: "string",
            enum: [ "up", "down" ],
            description: "pg CHECK rating IN (up, down)"
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_message_feedback",
        unique: true
      },
      {
        key: {
          organization_id: 1,
          created_at: -1
        },
        name: "ix_message_feedback_org_created"
      },
    ],
  },
  { // pg: message_receipts (drizzle/0042_fl3_frontier.sql)
    name: "message_receipts",
    pgTable: "message_receipts",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          },
          state: {
            bsonType: "string",
            enum: [ "delivered", "read" ],
            description: "pg CHECK state IN (delivered, read)"
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_message_receipts",
        unique: true
      },
      {
        key: {
          message_id: 1,
          channel_account_id: 1,
          state: 1
        },
        name: "uq_message_receipts_message_account_state",
        unique: true
      },
      {
        key: {
          organization_id: 1,
          conversation_id: 1
        },
        name: "ix_message_receipts_org_conversation"
      },
    ],
  },
  { // pg: messages (drizzle/0022_conversations.sql)
    name: "messages",
    pgTable: "messages",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          },
          role: {
            bsonType: "string",
            enum: [ "user", "assistant", "tool", "system" ],
            description: "pg CHECK role IN (user, assistant, tool, system)"
          },
          content: {
            bsonType: "object",
            description: "pg CHECK jsonb_typeof(content) = 'object'"
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_messages",
        unique: true
      },
      {
        key: {
          conversation_id: 1,
          sequence: 1
        },
        name: "uq_messages_conversation_sequence",
        unique: true
      },
      {
        key: {
          organization_id: 1,
          conversation_id: 1,
          sequence: -1
        },
        name: "ix_messages_org_conversation_seq"
      },
      {
        key: {
          conversation_id: 1,
          sequence: 1
        },
        name: "ix_messages_conversation_active",
        partialFilterExpression: {
          superseded_by: null
        }
      },
      {
        key: {
          conversation_id: 1,
          pinned_at: 1
        },
        name: "ix_messages_conversation_pinned",
        // pg: WHERE pinned_at IS NOT NULL — $type: 'date' is the exact
        // equivalent for a timestamptz column ($ne is unsupported).
        partialFilterExpression: {
          pinned_at: {
            $type: "date"
          }
        }
      },
    ],
  },
  { // pg: model_catalog_entries (drizzle/0051_model_catalog.sql)
    name: "model_catalog_entries",
    pgTable: "model_catalog_entries",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id" ],
        properties: {
          status: {
            bsonType: "string",
            enum: [ "active", "retired" ],
            description: "pg CHECK status IN (active, retired)"
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_model_catalog_entries",
        unique: true
      },
      {
        key: {
          provider: 1,
          model_id: 1
        },
        name: "uq_model_catalog_provider_model",
        unique: true
      },
      {
        key: {
          status: 1,
          provider: 1
        },
        name: "ix_model_catalog_status"
      },
    ],
  },
  { // pg: model_cost_entries (drizzle/0053_model_cost_catalog.sql)
    name: "model_cost_entries",
    pgTable: "model_cost_entries",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id" ],
        properties: {
          cost_micros_per_1k_input: {
            minimum: 0,
            description: "pg CHECK cost_micros_per_1k_input >= 0"
          },
          cost_micros_per_1k_output: {
            minimum: 0,
            description: "pg CHECK cost_micros_per_1k_output >= 0"
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_model_cost_entries",
        unique: true
      },
      {
        key: {
          provider: 1,
          model: 1,
          effective_from: 1
        },
        name: "uq_model_cost_provider_model_effective",
        unique: true
      },
      {
        key: {
          provider: 1,
          model: 1,
          effective_from: -1
        },
        name: "ix_model_cost_lookup"
      },
    ],
  },
  { // pg: newsletter_campaign_sends (drizzle/0013_corporate_depth.sql)
    name: "newsletter_campaign_sends",
    pgTable: "newsletter_campaign_sends",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id" ]
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_newsletter_campaign_sends",
        unique: true
      },
      {
        key: {
          campaign_id: 1,
          subscriber_id: 1
        },
        name: "uq_campaign_sends",
        unique: true
      },
      {
        key: {
          campaign_id: 1,
          status: 1
        },
        name: "ix_campaign_sends_pending"
      },
    ],
  },
  { // pg: newsletter_campaigns (drizzle/0013_corporate_depth.sql)
    name: "newsletter_campaigns",
    pgTable: "newsletter_campaigns",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id" ]
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_newsletter_campaigns",
        unique: true
      },
      {
        key: {
          status: 1,
          scheduled_at: 1
        },
        name: "ix_newsletter_campaigns_status"
      },
    ],
  },
  { // pg: newsletter_subs (drizzle/0003_corporate_public.sql)
    name: "newsletter_subs",
    pgTable: "newsletter_subs",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id" ]
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_newsletter_subs",
        unique: true
      },
      {
        key: {
          email: 1
        },
        name: "uq_newsletter_subs_email",
        unique: true
      },
      {
        key: {
          status: 1
        },
        name: "ix_newsletter_subs_status"
      },
    ],
  },
  { // pg: notifications (drizzle/0011_platform_services.sql)
    name: "notifications",
    pgTable: "notifications",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id" ]
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_notifications",
        unique: true
      },
      {
        key: {
          account_id: 1,
          created_at: 1
        },
        name: "ix_notifications_account_created"
      },
      {
        key: {
          org_id: 1,
          created_at: 1
        },
        name: "ix_notifications_org"
      },
    ],
  },
  { // pg: oauth_clients (drizzle/0001_engine_core.sql)
    name: "oauth_clients",
    pgTable: "oauth_clients",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "client_id" ]
      }
    },
    indexes: [
      {
        key: {
          client_id: 1
        },
        name: "pk_oauth_clients",
        unique: true
      },
    ],
  },
  { // pg: oauth_grants (drizzle/0001_engine_core.sql)
    name: "oauth_grants",
    pgTable: "oauth_grants",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "code_hash" ]
      }
    },
    indexes: [
      {
        key: {
          code_hash: 1
        },
        name: "pk_oauth_grants",
        unique: true
      },
    ],
  },
  { // pg: oauth_refresh_tokens (drizzle/0001_engine_core.sql)
    name: "oauth_refresh_tokens",
    pgTable: "oauth_refresh_tokens",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "jti" ]
      }
    },
    indexes: [
      {
        key: {
          jti: 1
        },
        name: "pk_oauth_refresh_tokens",
        unique: true
      },
      {
        key: {
          family_id: 1
        },
        name: "ix_refresh_tokens_family"
      },
    ],
  },
  { // pg: oauth_sessions (drizzle/0001_engine_core.sql)
    name: "oauth_sessions",
    pgTable: "oauth_sessions",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "sid" ]
      }
    },
    indexes: [
      {
        key: {
          sid: 1
        },
        name: "pk_oauth_sessions",
        unique: true
      },
      {
        key: {
          account_id: 1
        },
        name: "ix_oauth_sessions_account"
      },
      {
        key: {
          session_uid: 1
        },
        name: "ix_oauth_sessions_uid"
      },
    ],
  },
  { // pg: oidc_payloads (drizzle/0001_engine_core.sql)
    name: "oidc_payloads",
    pgTable: "oidc_payloads",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "model", "id" ]
      }
    },
    indexes: [
      {
        key: {
          model: 1,
          id: 1
        },
        name: "pk_oidc_payloads",
        unique: true
      },
    ],
  },
  { // pg: org_deletions (drizzle/0012_org_lifecycle.sql)
    name: "org_deletions",
    pgTable: "org_deletions",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "org_id" ]
      }
    },
    indexes: [
      {
        key: {
          org_id: 1
        },
        name: "pk_org_deletions",
        unique: true
      },
      {
        key: {
          status: 1,
          scheduled_purge_at: 1
        },
        name: "ix_org_deletions_status_purge"
      },
    ],
  },
  { // pg: org_group_members (drizzle/0009_org_furniture_dense.sql)
    name: "org_group_members",
    pgTable: "org_group_members",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "group_id", "account_id", "org_id" ],
        properties: {
          org_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          }
        }
      }
    },
    indexes: [
      {
        key: {
          group_id: 1,
          account_id: 1
        },
        name: "pk_org_group_members",
        unique: true
      },
      {
        key: {
          org_id: 1
        },
        name: "ix_org_group_members_org"
      },
      {
        key: {
          account_id: 1
        },
        name: "ix_org_group_members_account"
      },
    ],
  },
  { // pg: org_groups (drizzle/0009_org_furniture_dense.sql)
    name: "org_groups",
    pgTable: "org_groups",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "org_id" ],
        properties: {
          org_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_org_groups",
        unique: true
      },
      {
        key: {
          org_id: 1,
          name: 1
        },
        name: "uq_org_groups_org_name",
        unique: true
      },
    ],
  },
  { // pg: org_invites (drizzle/0002_org_furniture.sql)
    name: "org_invites",
    pgTable: "org_invites",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "org_id" ],
        properties: {
          org_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_org_invites",
        unique: true
      },
      {
        key: {
          org_id: 1
        },
        name: "ix_org_invites_org"
      },
      {
        key: {
          org_id: 1,
          email: 1
        },
        name: "ix_org_invites_org_email"
      },
    ],
  },
  { // pg: org_memberships (drizzle/0002_org_furniture.sql)
    name: "org_memberships",
    pgTable: "org_memberships",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "org_id" ],
        properties: {
          org_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_org_memberships",
        unique: true
      },
      {
        key: {
          account_id: 1,
          org_id: 1
        },
        name: "uq_org_memberships_account_org",
        unique: true
      },
      {
        key: {
          org_id: 1
        },
        name: "ix_org_memberships_org"
      },
      {
        key: {
          org_id: 1,
          status: 1
        },
        name: "ix_org_memberships_org_status"
      },
      {
        key: {
          org_id: 1
        },
        name: "uq_one_active_owner_per_org",
        unique: true,
        partialFilterExpression: {
          role: "owner",
          status: "active"
        }
      },
    ],
  },
  { // pg: org_service_accounts (drizzle/0009_org_furniture_dense.sql)
    name: "org_service_accounts",
    pgTable: "org_service_accounts",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "org_id" ],
        properties: {
          org_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_org_service_accounts",
        unique: true
      },
      {
        key: {
          token_hash: 1
        },
        name: "uq_org_service_accounts_token_hash",
        unique: true
      },
      {
        key: {
          org_id: 1
        },
        name: "ix_org_service_accounts_org"
      },
    ],
  },
  { // pg: org_settings (drizzle/0009_org_furniture_dense.sql)
    name: "org_settings",
    pgTable: "org_settings",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "org_id" ],
        properties: {
          org_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          },
          kind: {
            bsonType: "string",
            enum: [ "personal", "team" ],
            description: "pg CHECK kind IN (personal, team)"
          }
        }
      }
    },
    indexes: [
      {
        key: {
          org_id: 1
        },
        name: "pk_org_settings",
        unique: true
      },
    ],
  },
  { // pg: outbox_events (drizzle/0023_async_foundation.sql)
    name: "outbox_events",
    pgTable: "outbox_events",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "event_id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          },
          status: {
            bsonType: "string",
            enum: [ "PENDING", "CLAIMED", "PUBLISHED", "RETRY_WAIT", "DEAD_LETTER" ],
            description: "pg CHECK status IN (PENDING, CLAIMED, PUBLISHED, RETRY_WAIT, DEAD_LETTER)"
          }
        }
      }
    },
    indexes: [
      {
        key: {
          event_id: 1
        },
        name: "pk_outbox_events",
        unique: true
      },
      {
        key: {
          status: 1,
          next_attempt_at: 1
        },
        name: "ix_outbox_dispatch",
        partialFilterExpression: {
          status: {
            $in: [ "PENDING", "RETRY_WAIT" ]
          }
        }
      },
      {
        key: {
          organization_id: 1,
          created_at: 1
        },
        name: "ix_outbox_org_created"
      },
    ],
  },
  { // pg: product_deployment.pipeline_stages (drizzle/0005_product_deployment.sql)
    name: "product_deployment_pipeline_stages",
    pgTable: "product_deployment.pipeline_stages",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id" ]
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_product_deployment_pipeline_stages",
        unique: true
      },
      {
        key: {
          pipeline_id: 1,
          position: 1
        },
        name: "uq_deployment_stages_pipeline_position",
        unique: true
      },
      {
        key: {
          org_id: 1
        },
        name: "ix_deployment_stages_org"
      },
      {
        key: {
          org_id: 1,
          environment_id: 1
        },
        name: "ix_deployment_stages_env"
      },
    ],
  },
  { // pg: product_deployment.pipelines (drizzle/0005_product_deployment.sql)
    name: "product_deployment_pipelines",
    pgTable: "product_deployment.pipelines",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id" ]
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_product_deployment_pipelines",
        unique: true
      },
      {
        key: {
          org_id: 1,
          name: 1
        },
        name: "uq_deployment_pipelines_org_name",
        unique: true
      },
      {
        key: {
          org_id: 1
        },
        name: "ix_deployment_pipelines_org"
      },
    ],
  },
  { // pg: platform_staff (drizzle/0043_platform_staff.sql)
    name: "platform_staff",
    pgTable: "platform_staff",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "account_id" ],
        properties: {
          role: {
            bsonType: "string",
            enum: [ "super_admin", "tenant_admin", "operator", "auditor" ],
            description: "pg CHECK role IN (super_admin, tenant_admin, operator, auditor)"
          }
        }
      }
    },
    indexes: [
      {
        key: {
          account_id: 1
        },
        name: "pk_platform_staff",
        unique: true
      },
      {
        key: {
          role: 1
        },
        name: "ix_platform_staff_role_active",
        partialFilterExpression: {
          revoked_at: null
        }
      },
    ],
  },
  { // pg: policy_snapshots (drizzle/0021_policy_snapshots.sql)
    name: "policy_snapshots",
    pgTable: "policy_snapshots",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          },
          instructions: {
            bsonType: "string",
            maxLength: 32768,
            description: "pg CHECK char_length(instructions) <= 32768"
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_policy_snapshots",
        unique: true
      },
      {
        key: {
          organization_id: 1,
          created_at: 1
        },
        name: "ix_policy_snapshots_org_created"
      },
      {
        key: {
          assistant_version_id: 1,
          hash: 1
        },
        name: "uq_policy_snapshots_version_hash",
        unique: true
      },
    ],
  },
  { // pg: billing.price_catalog (drizzle/0011_platform_services.sql)
    name: "billing_price_catalog",
    pgTable: "billing.price_catalog",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id" ]
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_billing_price_catalog",
        unique: true
      },
      {
        key: {
          product: 1,
          kind: 1,
          model: 1,
          effective_from: 1
        },
        name: "uq_price_catalog_slot",
        unique: true
      },
      {
        key: {
          product: 1,
          kind: 1,
          model: 1,
          effective_from: 1
        },
        name: "ix_price_catalog_lookup"
      },
    ],
  },
  { // pg: product_entitlements (drizzle/0002_org_furniture.sql)
    name: "product_entitlements",
    pgTable: "product_entitlements",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "org_id" ],
        properties: {
          org_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_product_entitlements",
        unique: true
      },
      {
        key: {
          org_id: 1,
          product: 1
        },
        name: "uq_product_entitlements_org_product",
        unique: true
      },
    ],
  },
  { // pg: projects (drizzle/0002_org_furniture.sql)
    name: "projects",
    pgTable: "projects",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "org_id" ],
        properties: {
          org_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_projects",
        unique: true
      },
      {
        key: {
          org_id: 1,
          name: 1
        },
        name: "uq_projects_org_name",
        unique: true
      },
    ],
  },
  { // pg: provider_credentials (drizzle/0050_provider_credentials.sql)
    name: "provider_credentials",
    pgTable: "provider_credentials",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          },
          source: {
            bsonType: "string",
            enum: [ "platform", "byok" ],
            description: "pg CHECK source IN (platform, byok)"
          },
          status: {
            bsonType: "string",
            enum: [ "active", "rotating", "revoked" ],
            description: "pg CHECK status IN (active, rotating, revoked)"
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_provider_credentials",
        unique: true
      },
      {
        key: {
          organization_id: 1,
          provider: 1,
          external_ref: 1
        },
        name: "uq_provider_credentials_org_provider_ref",
        unique: true
      },
      {
        key: {
          organization_id: 1,
          provider: 1,
          status: 1
        },
        name: "ix_provider_credentials_org_provider"
      },
    ],
  },
  { // pg: provider_enablements (drizzle/0050_provider_credentials.sql)
    name: "provider_enablements",
    pgTable: "provider_enablements",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "organization_id", "provider" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          }
        }
      }
    },
    indexes: [
      {
        key: {
          organization_id: 1,
          provider: 1
        },
        name: "pk_provider_enablements",
        unique: true
      },
    ],
  },
  { // pg: provider_reconciliation_runs (drizzle/0027_billing_ledger.sql)
    name: "provider_reconciliation_runs",
    pgTable: "provider_reconciliation_runs",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          },
          state: {
            bsonType: "string",
            enum: [ "running", "completed", "failed" ],
            description: "pg CHECK state IN (running, completed, failed)"
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_provider_reconciliation_runs",
        unique: true
      },
    ],
  },
  { // pg: published_configs (drizzle/0007_satellite_surfaces.sql)
    name: "published_configs",
    pgTable: "published_configs",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id" ]
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_published_configs",
        unique: true
      },
      {
        key: {
          org_id: 1,
          scope: 1,
          product: 1,
          version: 1
        },
        name: "uq_published_configs_key_version",
        unique: true
      },
      {
        key: {
          org_id: 1,
          scope: 1,
          published_at: 1
        },
        name: "ix_published_configs_org_scope"
      },
    ],
  },
  { // pg: purge_tasks (drizzle/0028_lifecycle.sql)
    name: "purge_tasks",
    pgTable: "purge_tasks",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          },
          state: {
            bsonType: "string",
            enum: [ "pending", "in_progress", "done", "failed", "blocked" ],
            description: "pg CHECK state IN (pending, in_progress, done, failed, blocked)"
          },
          step: {
            bsonType: "string",
            enum: [ "authorize", "check_holds", "mark_unavailable", "emit_derived_deletion", "purge_objects", "purge_content", "tombstone", "done" ],
            description: "pg CHECK step IN (authorize, check_holds, mark_unavailable, emit_derived_deletion, purge_objects, purge_content, tombstone, done)"
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_purge_tasks",
        unique: true
      },
      {
        key: {
          state: 1,
          created_at: 1
        },
        name: "ix_purge_tasks_state",
        partialFilterExpression: {
          state: {
            $in: [ "pending", "in_progress" ]
          }
        }
      },
    ],
  },
  { // pg: quota_reservations (drizzle/0027_billing_ledger.sql)
    name: "quota_reservations",
    pgTable: "quota_reservations",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          },
          dimension: {
            bsonType: "string",
            enum: [ "requests", "model_tokens", "model_cost", "storage_bytes", "ingestion_work", "tool_operations", "seats", "rate" ],
            description: "pg CHECK dimension IN (requests, model_tokens, model_cost, storage_bytes, ingestion_work, tool_operations, seats, rate)"
          },
          state: {
            bsonType: "string",
            enum: [ "RESERVED", "COMMITTED", "RELEASED", "EXPIRED" ],
            description: "pg CHECK state IN (RESERVED, COMMITTED, RELEASED, EXPIRED)"
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_quota_reservations",
        unique: true
      },
      {
        key: {
          organization_id: 1,
          dimension: 1,
          state: 1
        },
        name: "ix_quota_reservations_org_dim"
      },
      {
        key: {
          expires_at: 1
        },
        name: "ix_quota_reservations_expiry",
        partialFilterExpression: {
          state: "RESERVED"
        }
      },
    ],
  },
  { // pg: retention_policies (drizzle/0028_lifecycle.sql)
    name: "retention_policies",
    pgTable: "retention_policies",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_retention_policies",
        unique: true
      },
    ],
  },
  { // pg: retrieval_acl (drizzle/0026_knowledge.sql)
    name: "retrieval_acl",
    pgTable: "retrieval_acl",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          },
          visibility: {
            bsonType: "string",
            enum: [ "organization", "private" ],
            description: "pg CHECK visibility IN (organization, private)"
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_retrieval_acl",
        unique: true
      },
      {
        key: {
          organization_id: 1,
          resource_type: 1,
          resource_id: 1
        },
        name: "ix_retrieval_acl_resource"
      },
    ],
  },
  { // pg: revocation_events (drizzle/0011_platform_services.sql)
    name: "revocation_events",
    pgTable: "revocation_events",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id" ]
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_revocation_events",
        unique: true
      },
      {
        key: {
          occurred_at: 1,
          id: 1
        },
        name: "ix_revocation_events_occurred"
      },
    ],
  },
  { // pg: run_events (drizzle/0022_conversations.sql)
    name: "run_events",
    pgTable: "run_events",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          }
        },
        anyOf: [
          {
            required: [ "payload" ]
          },
          {
            required: [ "artifact_id" ]
          }
        ]
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_run_events",
        unique: true
      },
      {
        key: {
          run_id: 1,
          engine_sequence: 1
        },
        name: "uq_run_events_run_engine_sequence",
        unique: true
      },
      {
        key: {
          organization_id: 1,
          run_id: 1,
          engine_sequence: 1
        },
        name: "ix_run_events_org_run_seq"
      },
      {
        key: {
          run_id: 1,
          event_id: 1
        },
        name: "uq_run_events_run_event_id",
        unique: true
      },
    ],
  },
  { // pg: run_idempotency (drizzle/0024_mcp_authority.sql)
    name: "run_idempotency",
    pgTable: "run_idempotency",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          },
          status: {
            bsonType: "string",
            enum: [ "IN_PROGRESS", "SUCCEEDED", "FAILED_RETRYABLE", "FAILED_FINAL" ],
            description: "pg CHECK status IN (IN_PROGRESS, SUCCEEDED, FAILED_RETRYABLE, FAILED_FINAL)"
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_run_idempotency",
        unique: true
      },
      {
        key: {
          run_id: 1,
          expires_at: 1
        },
        name: "ix_run_idempotency_run"
      },
    ],
  },
  { // pg: run_judgments (drizzle/0042_fl3_frontier.sql)
    name: "run_judgments",
    pgTable: "run_judgments",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          },
          state: {
            bsonType: "string",
            enum: [ "completed", "failed" ],
            description: "pg CHECK state IN (completed, failed)"
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_run_judgments",
        unique: true
      },
      {
        key: {
          organization_id: 1,
          created_at: 1
        },
        name: "ix_run_judgments_org_created"
      },
    ],
  },
  { // pg: run_manifests (drizzle/0049_release_governance.sql)
    name: "run_manifests",
    pgTable: "run_manifests",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "run_id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          }
        }
      }
    },
    indexes: [
      {
        key: {
          run_id: 1
        },
        name: "pk_run_manifests",
        unique: true
      },
      {
        key: {
          organization_id: 1,
          assistant_version_id: 1
        },
        name: "ix_run_manifests_org_version"
      },
    ],
  },
  { // pg: runs (drizzle/0022_conversations.sql)
    name: "runs",
    pgTable: "runs",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          },
          run_kind: {
            bsonType: "string",
            enum: [ "standard", "test", "eval" ],
            description: "pg CHECK run_kind IN (standard, test, eval)"
          },
          state: {
            bsonType: "string",
            enum: [ "ACCEPTED", "DISPATCHED", "RUNNING", "WAITING_APPROVAL", "WAITING_INPUT", "COMPLETED", "FAILED", "CANCELED", "EXPIRED" ],
            description: "pg CHECK state IN (ACCEPTED, DISPATCHED, RUNNING, WAITING_APPROVAL, WAITING_INPUT, COMPLETED, FAILED, CANCELED, EXPIRED)"
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_runs",
        unique: true
      },
      {
        key: {
          conversation_id: 1
        },
        name: "uq_runs_one_active_per_conversation",
        unique: true,
        partialFilterExpression: {
          state: {
            $in: [ "ACCEPTED", "DISPATCHED", "RUNNING", "WAITING_APPROVAL", "WAITING_INPUT" ]
          }
        }
      },
      {
        key: {
          organization_id: 1,
          conversation_id: 1,
          state: 1
        },
        name: "ix_runs_org_conversation_state"
      },
    ],
  },
  { // pg: satellite_counters (drizzle/0015_satellites_dense.sql)
    name: "satellite_counters",
    pgTable: "satellite_counters",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "satellite_key" ]
      }
    },
    indexes: [
      {
        key: {
          satellite_key: 1
        },
        name: "pk_satellite_counters",
        unique: true
      },
    ],
  },
  { // pg: satellite_heartbeats (drizzle/0015_satellites_dense.sql)
    name: "satellite_heartbeats",
    pgTable: "satellite_heartbeats",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id" ]
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_satellite_heartbeats",
        unique: true
      },
      {
        key: {
          satellite_key: 1,
          received_at: 1
        },
        name: "ix_satellite_heartbeats_key_received"
      },
    ],
  },
  { // pg: satellite_incidents (drizzle/0015_satellites_dense.sql)
    name: "satellite_incidents",
    pgTable: "satellite_incidents",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id" ]
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_satellite_incidents",
        unique: true
      },
      {
        key: {
          satellite_key: 1,
          opened_at: 1
        },
        name: "ix_satellite_incidents_key_opened"
      },
      {
        key: {
          satellite_key: 1,
          kind: 1,
          resolved_at: 1
        },
        name: "ix_satellite_incidents_unresolved"
      },
    ],
  },
  { // pg: satellites (drizzle/0007_satellite_surfaces.sql)
    name: "satellites",
    pgTable: "satellites",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "key" ]
      }
    },
    indexes: [
      {
        key: {
          key: 1
        },
        name: "pk_satellites",
        unique: true
      },
      {
        key: {
          status: 1
        },
        name: "ix_satellites_status"
      },
      {
        key: {
          liveness: 1
        },
        name: "ix_satellites_liveness"
      },
    ],
  },
  { // pg: product_deployment.secrets (drizzle/0005_product_deployment.sql)
    name: "product_deployment_secrets",
    pgTable: "product_deployment.secrets",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id" ]
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_product_deployment_secrets",
        unique: true
      },
      {
        key: {
          environment_id: 1,
          key: 1
        },
        name: "uq_deployment_secrets_env_key",
        unique: true
      },
      {
        key: {
          org_id: 1
        },
        name: "ix_deployment_secrets_org"
      },
    ],
  },
  { // pg: billing.spend_events (drizzle/0004_billing_metering.sql)
    name: "billing_spend_events",
    pgTable: "billing.spend_events",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id" ]
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_billing_spend_events",
        unique: true
      },
      {
        key: {
          source: 1,
          event_id: 1
        },
        name: "uq_billing_spend_source_event",
        unique: true
      },
      {
        key: {
          org_id: 1,
          product: 1,
          occurred_at: 1
        },
        name: "ix_billing_spend_org_product_time"
      },
      {
        key: {
          org_id: 1,
          project_id: 1
        },
        name: "ix_billing_spend_org_project"
      },
      {
        key: {
          org_id: 1,
          occurred_at: 1
        },
        name: "ix_billing_spend_org_time"
      },
    ],
  },
  { // pg: staff_impersonations (drizzle/0011_platform_services.sql)
    name: "staff_impersonations",
    pgTable: "staff_impersonations",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id" ]
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_staff_impersonations",
        unique: true
      },
      {
        key: {
          revoked_at: 1,
          expires_at: 1
        },
        name: "ix_staff_impersonations_active"
      },
      {
        key: {
          staff_account_id: 1,
          created_at: 1
        },
        name: "ix_staff_impersonations_staff"
      },
    ],
  },
  { // pg: studio_project_keys (drizzle/0006_agent_studio_keys.sql)
    name: "studio_project_keys",
    pgTable: "studio_project_keys",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id" ]
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_studio_project_keys",
        unique: true
      },
      {
        key: {
          org_id: 1,
          api_key_id: 1
        },
        name: "uq_studio_project_keys_key",
        unique: true
      },
      {
        key: {
          org_id: 1,
          project_id: 1
        },
        name: "ix_studio_project_keys_project"
      },
    ],
  },
  { // pg: template_platform_blocks (drizzle/0054_template_platform_blocks.sql)
    name: "template_platform_blocks",
    pgTable: "template_platform_blocks",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id" ]
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_template_platform_blocks",
        unique: true
      },
      {
        key: {
          slug: 1
        },
        name: "uq_template_platform_blocks_active",
        unique: true,
        partialFilterExpression: {
          lifted_at: null
        }
      },
      {
        key: {
          slug: 1,
          created_at: 1
        },
        name: "ix_template_platform_blocks_slug"
      },
    ],
  },
  { // pg: tenants (drizzle/0059_legacy_standalone.sql)
    name: "tenants",
    pgTable: "tenants",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id" ]
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_tenants",
        unique: true
      },
      {
        key: {
          slug: 1
        },
        name: "uq_tenants_slug",
        unique: true
      },
    ],
  },
  { // pg: tombstones (drizzle/0028_lifecycle.sql)
    name: "tombstones",
    pgTable: "tombstones",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id" ]
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_tombstones",
        unique: true
      },
    ],
  },
  { // pg: tool_catalog (drizzle/0032_tool_catalog.sql)
    name: "tool_catalog",
    pgTable: "tool_catalog",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          },
          approval_requirement: {
            bsonType: "string",
            enum: [ "NONE", "REQUIRED" ],
            description: "pg CHECK approval_requirement IN (NONE, REQUIRED)"
          },
          effect_class: {
            bsonType: "string",
            enum: [ "READ_ONLY", "MUTATING", "DESTRUCTIVE" ],
            description: "pg CHECK effect_class IN (READ_ONLY, MUTATING, DESTRUCTIVE)"
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_tool_catalog",
        unique: true
      },
      {
        key: {
          organization_id: 1,
          enabled: 1,
          updated_at: -1
        },
        name: "ix_tool_catalog_org_enabled"
      },
      // PARITY GAP FIX (deliberate, 2026-09-26): pg's uq_tool_catalog_org_name
      // (drizzle/0032_tool_catalog.sql:32) was missing from this spec. The
      // tool-catalog upsert conflict-mapping depends on this unique
      // (organization_id, name) key under concurrency — without it, two racing
      // upserts on the mongo lane can create duplicate rows where pg raises a
      // typed 409 conflict. Carries the pg constraint name on purpose.
      {
        key: {
          organization_id: 1,
          name: 1
        },
        name: "uq_tool_catalog_org_name",
        unique: true
      },
    ],
  },
  { // pg: tool_effects (drizzle/0024_mcp_authority.sql)
    name: "tool_effects",
    pgTable: "tool_effects",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_tool_effects",
        unique: true
      },
      {
        key: {
          run_id: 1,
          authorized_at: 1
        },
        name: "ix_tool_effects_run"
      },
    ],
  },
  { // pg: upload_sessions (drizzle/0026_knowledge.sql)
    name: "upload_sessions",
    pgTable: "upload_sessions",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          },
          state: {
            bsonType: "string",
            enum: [ "CREATED", "UPLOADING", "UPLOADED", "SCANNING", "EXTRACTING", "INDEXING", "READY", "QUARANTINED", "FAILED" ],
            description: "pg CHECK state IN (CREATED, UPLOADING, UPLOADED, SCANNING, EXTRACTING, INDEXING, READY, QUARANTINED, FAILED)"
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_upload_sessions",
        unique: true
      },
      {
        key: {
          state: 1,
          created_at: 1
        },
        name: "ix_upload_sessions_state",
        partialFilterExpression: {
          state: {
            $in: [ "UPLOADED", "SCANNING", "EXTRACTING", "INDEXING" ]
          }
        }
      },
    ],
  },
  { // pg: usage_ledger_entries (drizzle/0027_billing_ledger.sql)
    name: "usage_ledger_entries",
    pgTable: "usage_ledger_entries",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "organization_id" ],
        properties: {
          organization_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          },
          reconciliation_state: {
            bsonType: "string",
            enum: [ "pending", "matched", "discrepant", "corrected" ],
            description: "pg CHECK reconciliation_state IN (pending, matched, discrepant, corrected)"
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_usage_ledger_entries",
        unique: true
      },
      {
        key: {
          organization_id: 1,
          run_id: 1
        },
        name: "ix_usage_ledger_run"
      },
      {
        key: {
          organization_id: 1,
          created_at: -1
        },
        name: "ix_usage_ledger_created"
      },
    ],
  },
  { // pg: webhook_deliveries (drizzle/0011_platform_services.sql)
    name: "webhook_deliveries",
    pgTable: "webhook_deliveries",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "org_id" ],
        properties: {
          org_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_webhook_deliveries",
        unique: true
      },
      {
        key: {
          org_id: 1,
          created_at: 1
        },
        name: "ix_webhook_deliveries_org_created"
      },
      {
        key: {
          status: 1,
          next_attempt_at: 1
        },
        name: "ix_webhook_deliveries_pending"
      },
      {
        key: {
          webhook_id: 1,
          created_at: 1
        },
        name: "ix_webhook_deliveries_webhook"
      },
    ],
  },
  { // pg: webhooks (drizzle/0011_platform_services.sql)
    name: "webhooks",
    pgTable: "webhooks",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [ "id", "org_id" ],
        properties: {
          org_id: {
            bsonType: [ "string", "binData" ],
            description: "Tenant key (pg RLS policy column). UUIDs are stored per plan D4 (BSON binary subtype 4); strings accepted during the port transition."
          }
        }
      }
    },
    indexes: [
      {
        key: {
          id: 1
        },
        name: "pk_webhooks",
        unique: true
      },
      {
        key: {
          org_id: 1,
          status: 1
        },
        name: "ix_webhooks_org"
      },
    ],
  },
];

async function collectionExists(db: Db, name: string): Promise<boolean> {
  const found = await db.listCollections({ name }, { nameOnly: true }).toArray();
  return found.length > 0;
}

/**
 * eng-0001 migration: provision every engine collection with its validator
 * and indexes. Convergent (safe to re-run): missing collections are created,
 * existing ones get `collMod` to converge the validator, and `createIndexes`
 * no-ops when name+spec already match. DDL is not transactional in MongoDB,
 * so the accepted `session` is intentionally unused here — the ledger insert
 * in `runMongoMigrations` is the exactly-once point.
 */
export const migration0001EngineCore: MongoMigration = {
  version: '0001',
  tag: 'eng-0001',
  async up(db: Db): Promise<void> {
    for (const spec of ENGINE_CORE_COLLECTIONS) {
      if (!(await collectionExists(db, spec.name))) {
        await db.createCollection(spec.name, spec.validator
          ? { validator: spec.validator, validationLevel: 'strict', validationAction: 'error' }
          : {});
      } else if (spec.validator) {
        await db.command({
          collMod: spec.name,
          validator: spec.validator,
          validationLevel: 'strict',
          validationAction: 'error',
        });
      }
      if (spec.indexes.length > 0) {
        await db.collection(spec.name).createIndexes(spec.indexes);
      }
    }
  },
};

/**
 * Tamper-evidence fingerprint for this migration: sha256 over the canonical
 * (key-sorted) JSON of the collection specs above, computed at module load.
 *
 * Why the spec and not the file bytes: the same migration runs from `.ts`
 * sources under ts-node in dev/CI and from compiled `.js` in production — a
 * file-content hash would differ between the two and false-positive on every
 * cross-environment verify. The spec hash is identical in both, and it pins
 * exactly what matters: any edit to a collection, validator, or index after
 * this migration was applied changes the fingerprint, and `runMongoMigrations`
 * fails closed instead of silently skipping the altered migration.
 */
export const MIGRATION_0001_SOURCE_CHECKSUM: string = sha256Hex(stableStringify(ENGINE_CORE_COLLECTIONS));
