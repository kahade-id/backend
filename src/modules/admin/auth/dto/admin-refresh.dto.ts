import { IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AdminRefreshDto {
  @ApiProperty({ description: 'Refresh token' })
  @IsString()
  refreshToken!: string;
}
