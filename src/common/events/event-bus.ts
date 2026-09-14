import { Injectable, Logger } from '@nestjs/common';

/**
 * Minimal typed event bus (kernel facility). Used for cross-module,
 * in-process signals (account.created → personal-org autocreation; session
 * revoked → deny-list push). Handlers are isolated: one failing handler
 * never breaks the others, and errors are logged with the event name.
 *
 * Not a message queue: durable/async work belongs to BullMQ namespaces.
 *
 * Phase 6.8 seam (ledger): the EventBus is NOT a business delivery path.
 * Every durable business fact gains an `outbox_events` row in the same
 * transaction that writes the fact, and async delivery goes through the
 * outbox dispatcher + inbox dedup (src/common/infra/outbox/*). The EventBus
 * remains only for best-effort in-process hints (cache invalidation,
 * projection nudges) where losing a signal is acceptable.
 */
type Handler<T> = (event: T) => void | Promise<void>;

@Injectable()
export class EventBus {
  private readonly logger = new Logger(EventBus.name);
  private readonly handlers = new Map<string, Array<Handler<never>>>();

  on<T>(event: string, handler: Handler<T>): () => void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler as Handler<never>);
    this.handlers.set(event, list);
    return () => {
      const current = this.handlers.get(event) ?? [];
      this.handlers.set(event, current.filter((h) => h !== handler));
    };
  }

  async emit<T>(event: string, payload: T): Promise<void> {
    const list = this.handlers.get(event) ?? [];
    await Promise.allSettled(
      list.map(async (handler) => {
        try {
          await (handler as Handler<T>)(payload);
        } catch (err) {
          this.logger.error(`event handler failed for "${event}": ${(err as Error).message}`, (err as Error).stack);
        }
      }),
    );
  }
}

/** Engine event vocabulary (typed payloads). */
export interface AccountCreatedEvent {
  accountId: string;
  email: string;
}

export interface SessionRevokedEvent {
  sid: string | null;
  accountId: string;
  revokeAllSessionsOfAccount?: boolean;
}

/** Refresh-token reuse tripwire fired (family already revoked by the adapter). */
export interface TokenRefreshReuseEvent {
  accountId: string;
  familyId: string;
  sessionId: string | null;
}

export const EngineEvents = {
  AccountCreated: 'account.created',
  AccountEmailChanged: 'account.email_changed',
  AccountDeletionRequested: 'account.deletion_requested',
  AccountDeletionCancelled: 'account.deletion_cancelled',
  AccountPurged: 'account.purged',
  SessionRevoked: 'session.revoked',
  /** Refresh reuse detected — the presenting family was revoked (doc-06 §10.4). */
  TokenRefreshReuse: 'token.refresh_reuse',
  LoginSuccess: 'login.success',
  LoginFailure: 'login.failure',
  EntitlementTransitioned: 'entitlement.transitioned',
  /** Trial-window expiry sweep moved an entitlement past its period (H-3). */
  EntitlementExpired: 'entitlement.expired',
  /** A plan change (upgrade/downgrade) landed on an entitlement (H-4). */
  BillingPlanChanged: 'billing.plan_changed',
  /** A payment provider (Stripe) settled an invoice (H-1). */
  BillingInvoicePaid: 'billing.invoice_paid',
  ConfigPublished: 'config.published',
  /** Durable revocation-log inputs (the satellite feed subscribes to these). */
  IdentityRevocation: 'identity.revocation',
  KeyRevoked: 'keys.revoked',
  /** Org lifecycle signals (notifications subscribe). */
  OrgCreated: 'org.created',
  OrgOwnershipTransferred: 'org.ownership_transferred',
  OrgRoleChanged: 'org.role_changed',
  OrgDeletionRequested: 'org.deletion_requested',
  OrgDeletionCancelled: 'org.deletion_cancelled',
  OrgPurged: 'org.purged',
  /** Org membership + invite lifecycle (seat tooling, notifications). */
  OrgMemberAdded: 'org.member_added',
  OrgMemberSuspended: 'org.member_suspended',
  OrgMemberReactivated: 'org.member_reactivated',
  OrgMemberRemoved: 'org.member_removed',
  OrgInviteCreated: 'org.invite_created',
  OrgInviteAccepted: 'org.invite_accepted',
  OrgInviteRevoked: 'org.invite_revoked',
  /** Org settings/groups/service-account signals. */
  OrgSettingsUpdated: 'org.settings_updated',
  ServiceAccountTokenRotated: 'org.service_account_token_rotated',
  /** Satellite lifecycle + liveness signals (status center, notifications). */
  SatelliteLivenessLost: 'satellite.liveness_lost',
  SatelliteLivenessRestored: 'satellite.liveness_restored',
  SatelliteRegistered: 'satellite.registered',
  SatelliteQuarantined: 'satellite.quarantined',
  SatelliteReleased: 'satellite.released',
  SatelliteDraining: 'satellite.draining',
  SatelliteResumed: 'satellite.resumed',
  SatelliteRetired: 'satellite.retired',
  SatelliteVersionFloorViolated: 'satellite.version_floor_violated',
  SatelliteConfigDrift: 'satellite.config_drift',
  /**
   * Connection-contract activity tick (compliance evidence): internal
   * surfaces emit one per satellite request so the satellites module (when
   * enabled) can bump its per-scope counters without module coupling.
   */
  SatelliteActivity: 'satellite.activity',
  /** Deployment run signals (webhooks + notifications subscribe). */
  DeploymentCompleted: 'deployment.completed',
  DeploymentFailed: 'deployment.failed',
  DeploymentRolledBack: 'deployment.rolled_back',
  /** Webhook subsystem lifecycle. */
  WebhookDead: 'webhook.dead',
} as const;

export interface ConfigPublishedEvent {
  orgId: string;
  /** The published version's row id (webhook consumers ACK against it). */
  configId?: string;
  scope: string;
  product: string | null;
  version: number;
  /** Canonical-form payload digest (satellites verify their cache by it). */
  payloadHash?: string;
}
