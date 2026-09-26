/**
 * PostgreSQL email-delivery repository (P3) — `email_deliveries`.
 * Mechanical move of the `EmailService` delivery-audit writes; the
 * suppression lookup now lives behind `ISuppressionRepository` (the service
 * injects `SuppressionService` for it).
 */
import type { DbService } from '../../../common/infra/db/db.service';
import { emailDeliveries } from '../email/schema';
import type { IEmailDeliveryRepository, RecordDeliveryInput } from './email-delivery.repository';

export class PgEmailDeliveryRepository implements IEmailDeliveryRepository {
  constructor(private readonly db: DbService) {}

  async recordDelivery(input: RecordDeliveryInput): Promise<void> {
    await this.db.withBypass(async (tx) => {
      await tx.insert(emailDeliveries).values({
        template: input.template,
        recipient: input.recipient,
        subject: input.subject,
        transport: input.transport,
        status: input.status,
        error: input.error,
        metadata: input.metadata ?? {},
      });
    });
  }
}
