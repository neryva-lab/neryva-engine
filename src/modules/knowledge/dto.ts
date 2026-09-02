import { IsInt, IsString, Length } from 'class-validator';

/** Shared upload media fields (client-declared; verified at completion). */
export class MediaDto {
  @IsString()
  media_type!: string;

  @IsInt()
  byte_length!: number;

  @IsString()
  @Length(64, 64)
  sha256!: string;
}
