/**
 * `IOauthClientRepository` — the persistence port for `oauth_clients`.
 * Envelope encryption/decryption of the client secret stays with the
 * caller (crypto, not persistence); this port carries the opaque envelope.
 *
 * Behavioral truth: `src/modules/identity/oidc/oidc-adapter.ts`
 * (`findClient`) and `src/modules/identity/identity.module.ts`
 * (`seedFirstPartyClients`).
 */
export interface OauthClient {
  clientId: string;
  kind: string;
  name: string;
  redirectUris: string[];
  scopes: string[];
  grantTypes: string[];
  secretEnvelope: string | null;
  tokenTtlSeconds: number | null;
  disabled: boolean;
}

export interface ClientSeed {
  clientId: string;
  kind: string;
  name: string;
  redirectUris: string[];
  scopes: string[];
  grantTypes: string[];
  /** Envelope-encrypted secret; absent ⇒ the row keeps its existing envelope. */
  secretEnvelope?: string;
}

export interface IOauthClientRepository {
  findClientRow(clientId: string): Promise<OauthClient | null>;
  /**
   * First-party client seeding: insert-or-update each seed (the secret
   * envelope is only overwritten when the seed carries one — never
   * clobbered to unusable).
   */
  seedClients(clients: ClientSeed[]): Promise<void>;
  /** The `svc-*` service-client allowlist check for client_credentials. */
  isServiceClientActive(clientId: string): Promise<boolean>;
}
