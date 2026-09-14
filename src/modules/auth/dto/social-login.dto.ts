import { IsString, IsNotEmpty, IsOptional, IsEnum, IsIn } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SocialLoginDto {
  @ApiProperty({ description: 'Social provider', enum: ['google', 'apple'] })
  @IsEnum(['google', 'apple'])
  provider!: 'google' | 'apple';

  @ApiProperty({ description: 'ID token from social provider (Google ID token or Apple identityToken)' })
  @IsString()
  @IsNotEmpty()
  idToken!: string;

  @ApiPropertyOptional({ description: 'Device ID for session tracking' })
  @IsOptional()
  @IsString()
  deviceId?: string;

  @ApiPropertyOptional({ description: 'Device info (user-agent)' })
  @IsOptional()
  @IsString()
  deviceInfo?: string;

  @ApiPropertyOptional({ description: 'Access token (required for Apple to verify)' })
  @IsOptional()
  @IsString()
  accessToken?: string;
}
