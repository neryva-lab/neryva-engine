import { Injectable, Logger } from '@nestjs/common';

/**
 * Minimal typed event bus (kernel facility). Used for cross-module,
 * in-process signals (account.created → personal-org autocreation; session
 * revoked → deny-list push). Handlers are isolated: one failing handler
 * never breaks the others, and errors are logged with the event name.
 *
 * Not a message queue: durable/async work belongs to BullMQ namespaces.
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

export const EngineEvents = {
  AccountCreated: 'account.created',
  SessionRevoked: 'session.revoked',
  LoginSuccess: 'login.success',
  LoginFailure: 'login.failure',
  EntitlementTransitioned: 'entitlement.transitioned',
  ConfigPublished: 'config.published',
} as const;

export interface ConfigPublishedEvent {
  orgId: string;
  scope: string;
  product: string | null;
  version: number;
}
