import { IsString, IsOptional, IsIn, MinLength, MaxLength, IsInt, Min, Matches } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const TICKET_STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] as const;
const TICKET_CATEGORIES = ['GENERAL', 'ORDER', 'PAYMENT', 'ACCOUNT', 'KYC', 'TECHNICAL', 'OTHER'] as const;

export class AdminTicketQueryDto {
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) limit?: number;
  @ApiPropertyOptional({ enum: TICKET_STATUSES }) @IsOptional() @IsIn(TICKET_STATUSES as unknown as string[]) status?: string;
  @ApiPropertyOptional({ enum: TICKET_CATEGORIES }) @IsOptional() @IsIn(TICKET_CATEGORIES as unknown as string[]) category?: string;
  @ApiPropertyOptional({ maxLength: 200 }) @IsOptional() @IsString() @MaxLength(200) search?: string;
}

export class AdminTicketReplyDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(4000) @Matches(/\S/, { message: 'message cannot be blank' }) message!: string;
}

export class AdminTicketStatusDto {
  @ApiProperty({ enum: TICKET_STATUSES }) @IsIn(TICKET_STATUSES as unknown as string[]) status!: string;
}
