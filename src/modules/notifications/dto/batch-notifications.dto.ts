import { IsArray, IsString, ArrayMinSize, ArrayMaxSize, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class BatchNotificationIdsDto {
  @ApiProperty({ description: 'Array of notification IDs to operate on (max 50 per request)', type: [String] })
  @IsArray()
  @IsString({ each: true })
  @Matches(/^[a-zA-Z0-9_-]+$/, { each: true, message: 'Invalid notification ID format' })
  @ArrayMinSize(1)
  @ArrayMaxSize(50, { message: 'Maximum 50 notifications per batch request' })
  notifIds!: string[];
}
