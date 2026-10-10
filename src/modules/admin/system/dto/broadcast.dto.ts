import { IsString, IsArray, IsOptional, IsIn, MaxLength, ArrayMinSize, ArrayMaxSize, ArrayUnique, IsNotEmpty, Matches, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class BroadcastDto {
  @ApiProperty({ description: 'Broadcast title', maxLength: 100 })
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @Matches(/\S/)
  @MaxLength(100)
  title!: string;

  @ApiProperty({ description: 'Broadcast body/message', maxLength: 500 })
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @Matches(/\S/)
  @MaxLength(500)
  body!: string;

  @ApiProperty({ description: 'Delivery channels. Push uses registered native FCM tokens.', enum: ['in_app', 'push'], isArray: true, example: ['in_app', 'push'] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @ArrayMaxSize(2, { message: 'At most in_app and push may be selected' })
  @IsString({ each: true })
  @IsIn(['in_app', 'push'], { each: true, message: 'Supported channels are in_app and push' })
  channels!: string[];

  // Audit 2026-10-10 (BE-22): definisi audiens didokumentasikan — admin dulu
  // tidak tahu bahwa `active` = login 30 hari terakhir.
  @ApiPropertyOptional({
    description: 'Target audience filter. all = semua akun aktif (tidak dihapus); active = login dalam 30 hari terakhir; kahade_plus = langganan Plus aktif; verified = KYC disetujui.',
    enum: ['all', 'active', 'kahade_plus', 'verified'],
    default: 'all',
  })
  @IsOptional()
  @IsIn(['all', 'active', 'kahade_plus', 'verified'])
  targetAudience?: string;
}
