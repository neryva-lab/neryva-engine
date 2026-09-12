import { IsIn, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { CHANNEL_PLATFORMS } from './schema';

export class CreateChannelDto {
  @IsIn(CHANNEL_PLATFORMS)
  platform!: string;

  @IsString()
  @MaxLength(128)
  display_name!: string;

  /**
   * Platform credentials (sealed at rest immediately, never returned again):
   *  whatsapp: { app_secret, access_token, phone_number_id }
   *  messenger: { app_secret, access_token }
   *  telegram: { bot_token }
   *  web: {} (public key generated server-side)
   */
  @IsObject()
  credentials!: Record<string, unknown>;

  @IsObject()
  @IsOptional()
  config?: Record<string, unknown>;
}

export class UpdateChannelDto {
  @IsObject()
  @IsOptional()
  config?: Record<string, unknown>;

  @IsIn(['active', 'suspended'])
  @IsOptional()
  status?: 'active' | 'suspended';

  @IsString()
  @IsOptional()
  @MaxLength(128)
  display_name?: string;
}

export class RotateCredentialsDto {
  @IsObject()
  credentials!: Record<string, unknown>;
}

export interface WhatsAppCredentials {
  app_secret: string;
  access_token: string;
  phone_number_id: string;
}

export interface MessengerCredentials {
  app_secret: string;
  access_token: string;
}

export interface TelegramCredentials {
  bot_token: string;
  webhook_secret: string; // generated server-side, sealed
}

export type SealedCredentialsMap = Record<string, string>;

export function assertCredentialsShape(platform: string, credentials: Record<string, unknown>): void {
  const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length >= 8;
  switch (platform) {
    case 'whatsapp':
      if (!nonEmpty(credentials.app_secret) || !/^[0-9a-f]{64}$/i.test(String(credentials.app_secret))) {
        throw new Error('whatsapp credentials require app_secret (64 hex chars)');
      }
      if (!nonEmpty(credentials.access_token) || !nonEmpty(credentials.phone_number_id)) {
        throw new Error('whatsapp credentials require access_token and phone_number_id');
      }
      return;
    case 'messenger':
      if (!nonEmpty(credentials.app_secret) || !/^[0-9a-f]{64}$/i.test(String(credentials.app_secret))) {
        throw new Error('messenger credentials require app_secret (64 hex chars)');
      }
      if (!nonEmpty(credentials.access_token)) {
        throw new Error('messenger credentials require access_token');
      }
      return;
    case 'telegram':
      if (!nonEmpty(credentials.bot_token) || !/^\d+:[\w-]+$/.test(String(credentials.bot_token))) {
        throw new Error('telegram credentials require bot_token in the 123456:token format');
      }
      return;
    case 'web':
      return; // no credentials — the public key is generated server-side
    default:
      throw new Error(`unsupported channel platform ${platform}`);
  }
}

export function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

/** Widget origin allowlist entry — scheme + host, no path, no wildcard port games. */
export function assertAllowedDomainFormat(domain: string): void {
  if (!/^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$/i.test(domain)) {
    throw new Error(`allowed_domains entry must be scheme://host[:port], got ${domain}`);
  }
}

export const WIDGET_SESSION_HEADER = 'x-neryva-session';
export const NK_KEY_PREFIX = 'nk_live_';
export const META_GRAPH_VERSION = 'v21.0';
