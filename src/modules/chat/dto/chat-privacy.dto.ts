import { IsOptional, IsBoolean, IsEnum } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { DmPolicy } from '@prisma/client';

/** Batch 43 BE-CHAT: pengaturan privasi chat per user. */
export class UpdateChatPrivacyDto {
  @ApiPropertyOptional({
    description: 'Sembunyikan centang baca (read receipt) dari lawan bicara',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  hideReadReceipts?: boolean;

  @ApiPropertyOptional({
    description: 'Kebijakan DM: EVERYONE (siapa pun), FOLLOWING (hanya yang di-follow), NONE (tolak DM baru)',
    enum: DmPolicy,
  })
  @IsOptional()
  @IsEnum(DmPolicy)
  dmPolicy?: DmPolicy;
}
