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

  @ApiPropertyOptional({ description: 'Target audience filter', enum: ['all', 'active', 'kahade_plus', 'verified'] })
  @IsOptional()
  @IsIn(['all', 'active', 'kahade_plus', 'verified'])
  targetAudience?: string;
}
