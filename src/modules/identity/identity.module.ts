import { FactoryProvider, Inject, Injectable, Logger, Module, OnModuleInit } from '@nestjs/common';
import type Provider from 'oidc-provider';
import { env } from '../../common/config/env';
import { DbService } from '../../common/infra/db/db.service';
import { MongoDbService } from '../../common/infra/db/mongo/mongo.service';
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
import { OnboardingService } from './onboarding.service';
import { PasswordService } from './password.service';
import { JwksCustody } from './oidc/jwks-custody';
import { OIDC_PROVIDER } from './oidc/oidc-provider.token';
import { OidcRepositoryAdapter } from './oidc/oidc-adapter';
import { OidcProviderFactory } from './oidc/oidc-provider.factory';
import { assertAppleKeyReadable } from './social/idp-verify';
import { SocialAccountService } from './social/social-account.service';
import { SocialController } from './social/social.controller';
import { SocialLoginService } from './social/social-login.service';
import { socialProviders } from './social/social.config';
import { envelopeEncrypt } from '../../common/infra/crypto/envelope';
import {
  ACCOUNT_ACTION_TOKEN_REPOSITORY,
  ACCOUNT_REPOSITORY,
  CREDENTIAL_REPOSITORY,
  EMAIL_CODE_REPOSITORY,
  GRANT_CODE_REPOSITORY,
  IDENTITY_LINK_REPOSITORY,
  MFA_REPOSITORY,
  OAUTH_CLIENT_REPOSITORY,
  OIDC_PAYLOAD_REPOSITORY,
  ONBOARDING_REPOSITORY,
  REFRESH_TOKEN_REPOSITORY,
  SESSION_REPOSITORY,
} from './repositories/repository-tokens';
import { PgAccountRepository } from './repositories/pg-account.repository';
import { MongoAccountRepository } from './repositories/mongo-account.repository';
import { PgCredentialRepository } from './repositories/pg-credential.repository';
import { MongoCredentialRepository } from './repositories/mongo-credential.repository';
import { PgMfaRepository } from './repositories/pg-mfa.repository';
import { MongoMfaRepository } from './repositories/mongo-mfa.repository';
import { PgEmailCodeRepository } from './repositories/pg-email-code.repository';
import { MongoEmailCodeRepository } from './repositories/mongo-email-code.repository';
import { PgAccountActionTokenRepository } from './repositories/pg-account-action-token.repository';
import { MongoAccountActionTokenRepository } from './repositories/mongo-account-action-token.repository';
import { PgSessionRepository } from './repositories/pg-session.repository';
import { MongoSessionRepository } from './repositories/mongo-session.repository';
import { PgRefreshTokenRepository } from './repositories/pg-refresh-token.repository';
import { MongoRefreshTokenRepository } from './repositories/mongo-refresh-token.repository';
import { PgOidcPayloadRepository } from './repositories/pg-oidc-payload.repository';
import { MongoOidcPayloadRepository } from './repositories/mongo-oidc-payload.repository';
import { PgGrantCodeRepository } from './repositories/pg-grant-code.repository';
import { MongoGrantCodeRepository } from './repositories/mongo-grant-code.repository';
import { PgOauthClientRepository } from './repositories/pg-client.repository';
import { MongoClientRepository } from './repositories/mongo-client.repository';
import { PgOnboardingRepository } from './repositories/pg-onboarding.repository';
import { MongoOnboardingRepository } from './repositories/mongo-onboarding.repository';
import { PgIdentityLinkRepository } from './repositories/pg-identity-link.repository';
import { MongoIdentityLinkRepository } from './repositories/mongo-identity-link.repository';
import type { IOauthClientRepository } from './repositories/client.repository';

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
    private readonly adapter: OidcRepositoryAdapter,
    private readonly jwksGuard: JwksService,
    private readonly db: DbService,
    private readonly mongo: MongoDbService,
    @Inject(OAUTH_CLIENT_REPOSITORY) private readonly clients: IOauthClientRepository,
    private readonly publicService: IdentityPublicService,
    private readonly holder: OidcProviderHolder,
    healthRegistry: HealthRegistry,
  ) {
    // Provider-aware liveness: probe the lane that actually serves reads.
    // MongoDbService.check resolves void on success (throws on failure),
    // so normalize it to the boolean shape the registry expects
    // (mirrors the organizations module's health registration).
    healthRegistry.register('identity', async () => {
      if (isMongo()) {
        await this.mongo.check();
        return true;
      }
      return this.db.check();
    });
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
      await this.clients.seedClients([
        {
          clientId: seed.clientId,
          kind: seed.kind,
          name: seed.name,
          redirectUris: seed.redirectUris,
          scopes: seed.scopes,
          grantTypes: seed.grantTypes,
          ...(secretEnvelope ? { secretEnvelope } : {}),
        },
      ]);
    }
  }
}

/** `DB_PROVIDER=mongodb` selects the MongoDB lane, anything else the PostgreSQL lane. */
const isMongo = (): boolean => env.DB_PROVIDER === 'mongodb';

function repositoryProvider(
  token: symbol,
  create: (db: DbService, mongo: MongoDbService) => unknown,
) {
  return {
    provide: token,
    useFactory: create,
    inject: [DbService, MongoDbService],
  };
}

const IDENTITY_REPOSITORY_PROVIDERS = [
  repositoryProvider(ACCOUNT_REPOSITORY, (db, mongo) => (isMongo() ? new MongoAccountRepository(mongo) : new PgAccountRepository(db))),
  repositoryProvider(CREDENTIAL_REPOSITORY, (db, mongo) => (isMongo() ? new MongoCredentialRepository(mongo) : new PgCredentialRepository(db))),
  repositoryProvider(MFA_REPOSITORY, (db, mongo) => (isMongo() ? new MongoMfaRepository(mongo) : new PgMfaRepository(db))),
  repositoryProvider(EMAIL_CODE_REPOSITORY, (db, mongo) => (isMongo() ? new MongoEmailCodeRepository(mongo) : new PgEmailCodeRepository(db))),
  repositoryProvider(ACCOUNT_ACTION_TOKEN_REPOSITORY, (db, mongo) =>
    isMongo() ? new MongoAccountActionTokenRepository(mongo) : new PgAccountActionTokenRepository(db),
  ),
  repositoryProvider(SESSION_REPOSITORY, (db, mongo) => (isMongo() ? new MongoSessionRepository(mongo) : new PgSessionRepository(db))),
  repositoryProvider(REFRESH_TOKEN_REPOSITORY, (db, mongo) =>
    isMongo() ? new MongoRefreshTokenRepository(mongo) : new PgRefreshTokenRepository(db),
  ),
  repositoryProvider(OIDC_PAYLOAD_REPOSITORY, (db, mongo) =>
    isMongo() ? new MongoOidcPayloadRepository(mongo) : new PgOidcPayloadRepository(db),
  ),
  repositoryProvider(GRANT_CODE_REPOSITORY, (db, mongo) => (isMongo() ? new MongoGrantCodeRepository(mongo) : new PgGrantCodeRepository(db))),
  repositoryProvider(OAUTH_CLIENT_REPOSITORY, (db, mongo) => (isMongo() ? new MongoClientRepository(mongo) : new PgOauthClientRepository(db))),
  repositoryProvider(ONBOARDING_REPOSITORY, (db, mongo) => (isMongo() ? new MongoOnboardingRepository(mongo) : new PgOnboardingRepository(db))),
  repositoryProvider(IDENTITY_LINK_REPOSITORY, (db, mongo) =>
    isMongo() ? new MongoIdentityLinkRepository(mongo) : new PgIdentityLinkRepository(db),
  ),
];

@Module({
  imports: [CorporateModule],
  controllers: [OidcProviderController, LoginInteractionController, AccountController, SocialController],
  providers: [
    ...IDENTITY_REPOSITORY_PROVIDERS,
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
    OidcRepositoryAdapter,
    OidcProviderFactory,
    OidcProviderHolder,
    OnboardingService,
    PasswordService,
    SocialAccountService,
    SocialLoginService,
    IdentityBoot,
    OidcProviderAccessor,
    { provide: SESSION_REGISTRY_PORT, useExisting: IdentityPublicService },
    { provide: SERVICE_CLIENT_PORT, useExisting: IdentityPublicService },
  ],
  exports: [AccountsService, OIDC_PROVIDER, SESSION_REGISTRY_PORT, SERVICE_CLIENT_PORT, JwksCustody, PasswordService, MfaService, SocialAccountService],
})
export class IdentityModule {}
