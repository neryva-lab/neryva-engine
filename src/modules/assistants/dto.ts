import { IsArray, IsBoolean, IsNotEmpty, IsNumber, IsObject, IsOptional, IsString, Length, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateAssistantDto {
  @IsString()
  @Length(2, 128)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  description?: string;
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
