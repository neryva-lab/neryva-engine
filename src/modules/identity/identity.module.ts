import { FactoryProvider, Injectable, Logger, Module, OnModuleInit } from '@nestjs/common';
import type Provider from 'oidc-provider';
import { env } from '../../common/config/env';
import { DbService } from '../../common/infra/db/db.service';
import { JwksService } from '../../common/auth/jwks.service';
import { HealthRegistry } from '../../common/health/health.controller';
import { SERVICE_CLIENT_PORT, SESSION_REGISTRY_PORT } from '../../common/auth/ports';
import { CorporateModule } from '../corporate/corporate.module';
import { AccountActionsService } from './account-actions.service';
import { AccountController } from './account.controller';
import { AccountDeletionService } from './account-deletion.service';
import { AccountPurgeWorker } from './account-purge.worker';
import { AccountsService } from './accounts.service';
import { CredentialsService } from './credentials.service';
import { EmailChangeService } from './email-change.service';
import { EmailCodeService } from './email-code.service';
import { IdentityPublicService } from './identity-public.service';
import { LoginInteractionController } from './login-interaction.controller';
import { MfaService } from './mfa.service';
import { OidcProviderController } from './oidc-provider.controller';
import { PasswordService } from './password.service';
import { JwksCustody } from './oidc/jwks-custody';
import { OIDC_PROVIDER } from './oidc/oidc-provider.token';
import { OidcDrizzleAdapter } from './oidc/oidc-adapter';
import { OidcProviderFactory } from './oidc/oidc-provider.factory';
import { assertAppleKeyReadable } from './social/idp-verify';
import { SocialAccountService } from './social/social-account.service';
import { SocialController } from './social/social.controller';
import { SocialLoginService } from './social/social-login.service';
import { socialProviders } from './social/social.config';
import { envelopeEncrypt } from '../../common/infra/crypto/envelope';
import { oauthClients } from './schema';

/**
 * The identity module (I-0…I-1d): accounts, the first-party OP, L1
 * sessions. Registered by the app only when MODULES__IDENTITY_ENABLED —
 * flag off ⇒ zero routes, zero behavior diff.
 */

/** Shared holder the lazy accessor reads; IdentityBoot fills it at boot. */
@Injectable()
export class OidcProviderHolder {
  private current: Provider | null = null;

  set(provider: Provider): void {
    this.current = provider;
  }

  get(): Provider {
    if (!this.current) {
      throw new Error('OP not initialized — identity onModuleInit has not completed');
    }
    return this.current;
  }
}

export const OidcProviderAccessor: FactoryProvider<() => Provider> = {
  provide: OIDC_PROVIDER,
  useFactory: (holder: OidcProviderHolder) => () => holder.get(),
  inject: [OidcProviderHolder],
};

@Injectable()
export class IdentityBoot implements OnModuleInit {
  private readonly logger = new Logger(IdentityBoot.name);

  constructor(
    private readonly factory: OidcProviderFactory,
    private readonly custody: JwksCustody,
    private readonly adapter: OidcDrizzleAdapter,
    private readonly jwksGuard: JwksService,
    private readonly db: DbService,
    private readonly publicService: IdentityPublicService,
    private readonly holder: OidcProviderHolder,
    healthRegistry: HealthRegistry,
  ) {
    healthRegistry.register('identity', () => this.db.check());
  }

  async onModuleInit(): Promise<void> {
    // Local keys first: the L1 guard must never make an HTTP call to itself.
    const keys = this.custody.load();
    this.jwksGuard.registerLocalKeys(keys.publicKeys);
    this.adapter.helpers = { pushSidDeny: (sid) => this.publicService.pushSidDeny(sid) };
    await this.seedFirstPartyClients();
    // A configured-but-unreadable Apple p8 key is a boot failure, never a
    // login-time 500 (social.config enables Apple only when fully set).
    assertAppleKeyReadable();
    const enabled = socialProviders().map((p) => p.key);
    if (enabled.length > 0) {
      this.logger.log(`social login enabled: ${enabled.join(', ')}`);
    }

    this.holder.set(await this.factory.create());
    this.logger.log(`identity module online: issuer=${env.IDENTITY_ISSUER}`);
  }

  /** The client registry is rows we INSERT — console, website, and the agent-runtime satellite — idempotently. */
  private async seedFirstPartyClients(): Promise<void> {
    const base = env.ENGINE_BASE_URL.replace(/\/$/, '');
    const seeds = [
      {
        clientId: 'neryva-console',
        kind: 'public',
        name: 'Neryva Console (web app /platform)',
        redirectUris: [`${base}/platform/auth/callback`, 'http://localhost:5173/platform/auth/callback', 'http://localhost:3000/platform/auth/callback'],
        scopes: ['openid', 'email', 'profile', 'offline_access'],
        grantTypes: ['authorization_code', 'refresh_token'],
        clientSecret: null as string | null,
      },
      {
        clientId: 'neryva-website',
        kind: 'public',
        name: 'neryva.com website',
        redirectUris: [`${base}/auth/callback`],
        scopes: ['openid', 'email', 'profile'],
        grantTypes: ['authorization_code'],
        clientSecret: null as string | null,
      },
      {
        // ADR-006 D2 connection contract #1: the satellite's service identity.
        clientId: 'svc-agent-runtime',
        kind: 'service',
        name: 'agent-runtime satellite',
        redirectUris: [] as string[],
        scopes: ['engine:ingest', 'engine:keys:validate', 'engine:config:pull', 'engine:heartbeat', 'engine:revocations'],
        grantTypes: ['client_credentials'],
        // Deploy-injected; envelope-encrypted below. Absent ⇒ the row keeps
        // its existing envelope (never clobbered to unusable).
        clientSecret: env.IDENTITY_AGENT_RUNTIME_SECRET ?? null,
      },
    ];
    for (const seed of seeds) {
      const secretEnvelope = seed.clientSecret ? envelopeEncrypt(seed.clientSecret) : null;
      await this.db.root
        .insert(oauthClients)
        .values({
          clientId: seed.clientId,
          kind: seed.kind,
          name: seed.name,
          redirectUris: seed.redirectUris,
          scopes: seed.scopes,
          grantTypes: seed.grantTypes,
          ...(secretEnvelope ? { secretEnvelope } : {}),
        })
        .onConflictDoUpdate({
          target: oauthClients.clientId,
          set: {
            name: seed.name,
            redirectUris: seed.redirectUris,
            scopes: seed.scopes,
            grantTypes: seed.grantTypes,
            ...(secretEnvelope ? { secretEnvelope } : {}),
          },
        });
    }
  }
}

@Module({
  imports: [CorporateModule],
  controllers: [OidcProviderController, LoginInteractionController, AccountController, SocialController],
  providers: [
    AccountActionsService,
    AccountDeletionService,
    AccountPurgeWorker,
    AccountsService,
    CredentialsService,
    EmailChangeService,
    EmailCodeService,
    IdentityPublicService,
    JwksCustody,
    MfaService,
    OidcDrizzleAdapter,
    OidcProviderFactory,
    OidcProviderHolder,
    PasswordService,
    SocialAccountService,
    SocialLoginService,
    IdentityBoot,
    OidcProviderAccessor,
    { provide: SESSION_REGISTRY_PORT, useExisting: IdentityPublicService },
    { provide: SERVICE_CLIENT_PORT, useExisting: IdentityPublicService },
  ],
  exports: [AccountsService, OIDC_PROVIDER, SESSION_REGISTRY_PORT, SERVICE_CLIENT_PORT, JwksCustody, PasswordService, MfaService, SocialAccountService],})
export class IdentityModule {}
