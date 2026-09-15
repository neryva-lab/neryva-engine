import { IsArray, IsBoolean, IsNotEmpty, IsNumber, IsObject, IsOptional, IsString, Length, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class TemplateRefDto {
  @IsString()
  @Length(1, 64)
  slug!: string;

  @IsOptional()
  @IsString()
  @Length(1, 32)
  version?: string;
}

export class CreateAssistantDto {
  @IsString()
  @Length(2, 128)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  description?: string;

  /**
   * TPL-2.1 — governed install: clone a registry template into a fresh
   * assistant + DRAFT version (copy, never a live link). Mutually exclusive
   * with `definition`.
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => TemplateRefDto)
  template?: TemplateRefDto;

  /**
   * TPL-2.1 — full Engine-subset definition in one step (assistant + DRAFT
   * version, atomically). Validated by validateAssistantPayload; template-only
   * extensions are rejected with a 422 listing them (service-side diff —
   * the global pipe already 400s unknown top-level DTO keys).
   */
  @IsOptional()
  @IsObject()
  definition?: Record<string, unknown>;
}

export class ModelPolicyDto {
  @IsArray()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  allowed_models!: string[];

  @IsOptional()
  @IsBoolean()
  fallback_enabled?: boolean;
}

export class ContextPolicyDto {
  @IsOptional()
  @IsString()
  history_limit?: number;

  @IsOptional()
  @IsBoolean()
  summary_enabled?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  knowledge_sources?: string[];

  @IsOptional()
  @IsString()
  memory_scope?: string;
}

export class ToolDescriptorDto {
  @IsString()
  @Length(1, 64)
  name!: string;

  @IsString()
  access!: string;

  @IsOptional()
  @IsString()
  approval?: string;
}

export class ToolPolicyDto {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ToolDescriptorDto)
  tools?: ToolDescriptorDto[];
}

export class GuardrailPolicyDto {
  @IsOptional()
  @IsString()
  input_policy?: string;

  @IsOptional()
  @IsString()
  output_policy?: string;

  @IsOptional()
  @IsBoolean()
  pii_redaction?: boolean;
}

export class CreateVersionDto {
  @ValidateNested()
  @Type(() => ModelPolicyDto)
  model_policy!: ModelPolicyDto;

  @ValidateNested()
  @Type(() => ContextPolicyDto)
  context_policy!: ContextPolicyDto;

  @ValidateNested()
  @Type(() => ToolPolicyDto)
  tool_policy!: ToolPolicyDto;

  @IsOptional()
  knowledge_policy?: unknown;

  @ValidateNested()
  @Type(() => GuardrailPolicyDto)
  guardrail_policy!: GuardrailPolicyDto;
}

export class RollbackDto {
  @IsString()
  @Length(36, 36)
  to_version_id!: string;

  /**
   * Audited degraded-knowledge bypass (same semantics as publish): restoring
   * a version whose pins no longer resolve ships it anyway, explicitly.
   */
  @IsOptional()
  @IsBoolean()
  acknowledge_degraded_knowledge?: boolean;
}

/** Wire shape of an exported assistant version envelope (service verifies the hash). */
export class ImportVersionDto {
  @IsNumber()
  schema_version!: number;

  @IsObject()
  model_policy!: Record<string, unknown>;

  @IsObject()
  context_policy!: Record<string, unknown>;

  @IsObject()
  tool_policy!: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  knowledge_policy?: Record<string, unknown>;

  @IsObject()
  guardrail_policy!: Record<string, unknown>;

  @IsString()
  @Length(64, 64)
  hash!: string;
}
