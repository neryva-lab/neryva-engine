import { IsNumber, IsObject, IsOptional, IsString, Length, MaxLength } from 'class-validator';

export class CreateConversationDto {
  @IsString()
  @Length(36, 36)
  assistant_id!: string;

  @IsOptional()
  @IsObject()
  channel_binding?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  participant_scope?: string;
}

export class AcceptMessageDto {
  @IsObject()
  content!: Record<string, unknown>;

  @IsOptional()
  @IsNumber()
  expected_conversation_version?: number;

  /** Durable DB-tier idempotency key (the @Idempotent() HTTP decorator is only the Redis lease). */
  @IsOptional()
  @IsString()
  @Length(8, 255)
  idempotency_key?: string;
}

export class CommitResultDto {
  @IsObject()
  content!: Record<string, unknown>;
}

export class CancelRunDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  reason?: string;
}

export class UpdateConversationStatusDto {
  @IsString()
  status!: 'active' | 'archived';

  @IsOptional()
  @IsNumber()
  expected_version?: number;
}
