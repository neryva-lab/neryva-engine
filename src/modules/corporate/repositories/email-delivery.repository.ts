/**
 * Port for the email delivery audit log (`email_deliveries`).
 *
 * The email service records one audit row per send attempt (sent | failed |
 * skipped). Corporate tables are global (non-tenant): no `orgId`.
 */

/** Plain domain view of an `email_deliveries` row (drizzle-free). */
export interface EmailDeliveryRow {
  id: string;
  template: string;
  recipient: string;
  subject: string;
  transport: string;
  status: string;
  error: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface RecordDeliveryInput {
  template: string;
  recipient: string;
  subject: string;
  transport: string;
  status: string;
  error: string | null;
  metadata?: Record<string, unknown>;
}

export interface IEmailDeliveryRepository {
  /** Insert one delivery-audit row (fire-and-forget; the service logs failures). */
  recordDelivery(input: RecordDeliveryInput): Promise<void>;
}
