import { IsString, IsNotEmpty, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ConfirmAvatarDto {
  @ApiProperty({ description: 'S3 key of the uploaded avatar' })
  @IsString()
  @IsNotEmpty({ message: 'avatarKey is required' })
  @Matches(/^avatars\/[a-zA-Z0-9_-]+\.(jpg|jpeg|png|webp)$/i, {
    message: 'avatarKey must be a valid avatar path (avatars/<id>.<ext>)',
  })
  avatarKey!: string;
}
