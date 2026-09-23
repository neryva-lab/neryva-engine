import { ArrayMaxSize, IsArray, IsIn, IsNumber, IsObject, IsOptional, IsString, IsUUID, Length, MaxLength } from 'class-validator';

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

  /**
   * FL-1.6 — artifact ids uploaded beforehand via the knowledge plane
   * (MESSAGE_ATTACHMENT purpose, sha256-bound presigned uploads). Each id is
   * re-validated server-side (org scope, purpose, media allowlist, byte cap)
   * before the ref is pinned onto the message.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @IsUUID(undefined, { each: true })
  attachments?: string[];
}

export class CommitResultDto {
  @IsObject()
  content!: Record<string, unknown>;

  /** FL-3.4 — bounded follow-up suggestions stored with the assistant reply. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  suggested_followups?: string[];
}

export class CancelRunDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  reason?: string;
}

export class UpdateConversationStatusDto {
  /**
   * User-facing lifecycle: 'deleted' is the soft-delete (the row is kept for
   * audit/retention; lists hide it and direct reads 404). Hard purge stays
   * with the retention-purge service.
   */
  @IsIn(['active', 'archived', 'deleted'])
  status!: 'active' | 'archived' | 'deleted';

  @IsOptional()
  @IsNumber()
  expected_version?: number;
}

/** FL-3.3 — regenerate an assistant reply (default: the latest one). */
export class RegenerateMessageDto {
  @IsOptional()
  @IsUUID()
  message_id?: string;

  @IsOptional()
  @IsNumber()
  expected_conversation_version?: number;

  @IsOptional()
  @IsString()
  @Length(8, 255)
  idempotency_key?: string;
}

/** FL-3.3 — edit-and-resend the latest user message. */
export class EditMessageDto {
  @IsUUID()
  message_id!: string;

  @IsObject()
  content!: Record<string, unknown>;

  @IsOptional()
  @IsNumber()
  expected_conversation_version?: number;

  @IsOptional()
  @IsString()
  @Length(8, 255)
  idempotency_key?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @IsUUID(undefined, { each: true })
  attachments?: string[];
}

/** FL-3.4 — create a public share link. */
export class CreateShareDto {
  @IsOptional()
  @IsNumber()
  ttl_seconds?: number;
}
