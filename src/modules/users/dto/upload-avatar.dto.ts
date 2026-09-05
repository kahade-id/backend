import { IsString, IsOptional, Matches } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UploadAvatarDto {
  @ApiPropertyOptional({ description: 'Content type of the image', example: 'image/jpeg' })
  @IsOptional()
  @IsString()
  @Matches(/^image\/(jpeg|png|webp)$/, { message: 'contentType must be image/jpeg, image/png, or image/webp' })
  contentType?: string;
}
