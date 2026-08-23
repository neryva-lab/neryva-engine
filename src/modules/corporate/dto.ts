import { IsEmail, IsOptional, IsString, Length, MaxLength, Matches, IsUrl } from 'class-validator';

/**
 * Public-form DTOs — the ONLY unauthenticated input surfaces on the engine,
 * so every field is constrained (length, shape) and validated by the global
 * pipe (whitelist + forbidNonWhitelisted: unknown fields are rejected).
 *
 * Honeypot: `company_url` is the hidden field humans never see. It is NOT
 * declared on the DTO, so a bot filling it is dropped by the whitelist
 * BEFORE reaching a handler — the controller still returns success to
 * avoid tipping bots off (silent tarpit, standard practice).
 */
export class ContactDto {
  @IsString()
  @Length(2, 256)
  name!: string;

  @IsEmail({}, { message: 'a valid email address is required' })
  @MaxLength(320)
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  company?: string;

  @IsString()
  @Length(10, 8000)
  message!: string;
}

export class NewsletterDto {
  @IsEmail({}, { message: 'a valid email address is required' })
  @MaxLength(320)
  email!: string;
}

export class CareerDto {
  @IsString()
  @Length(2, 256)
  name!: string;

  @IsEmail({}, { message: 'a valid email address is required' })
  @MaxLength(320)
  email!: string;

  @IsString()
  @Length(2, 256)
  position!: string;

  @IsOptional()
  @IsUrl({ require_tld: true }, { message: 'portfolio must be a valid URL' })
  @MaxLength(1024)
  portfolio_url?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  cover_note?: string;

  /** Object-storage reference (presigned upload result) — a path, never a blob. */
  @IsOptional()
  @Matches(/^[\w./-]{4,1024}$/, { message: 'file_ref must be a storage path' })
  file_ref?: string;
}

export class ContentPostDto {
  @IsString()
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { message: 'slug: lowercase kebab-case' })
  @MaxLength(256)
  slug!: string;

  @IsString()
  @Length(2, 512)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1024)
  summary?: string;

  @IsString()
  @Length(1, 200_000)
  body_md!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200_000)
  tags?: string; // comma-separated; parsed server-side into the jsonb array
}
