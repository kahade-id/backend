import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsEnum, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, ArrayMaxSize, MinLength } from 'class-validator';
import { IsValidId } from '../../../common/decorators/is-valid-id.decorator';

export enum TicketCategory {
  GENERAL = 'GENERAL',
  ORDER = 'ORDER',
  PAYMENT = 'PAYMENT',
  ACCOUNT = 'ACCOUNT',
  KYC = 'KYC',
  TECHNICAL = 'TECHNICAL',
  OTHER = 'OTHER',
}

export class CreateTicketDto {
  @IsString() @IsNotEmpty() @MinLength(1) @MaxLength(200) @Matches(/\S/, { message: 'subject cannot be blank' })
  subject!: string;

  @IsString() @IsNotEmpty() @MinLength(1) @MaxLength(5000) @Matches(/\S/, { message: 'message cannot be blank' })
  message!: string;

  @IsOptional() @IsEnum(TicketCategory)
  category?: TicketCategory;

  @IsOptional() @IsValidId()
  orderId?: string;

  @ApiPropertyOptional({ description: 'Attachment file keys (max 5)', type: [String] })
  @IsOptional() @IsArray() @ArrayMaxSize(5, { message: 'Maximum 5 attachments per support ticket' }) @IsString({ each: true }) @MaxLength(512, { each: true }) @Matches(/^uploads\/[a-z-]+\/[A-Za-z0-9_-]+\/[\w.-]+$/, { each: true, message: 'Invalid attachment file key' })
  attachments?: string[];
}

export class ReplyTicketDto {
  @IsString() @IsNotEmpty() @MinLength(1) @MaxLength(5000) @Matches(/\S/, { message: 'message cannot be blank' })
  message!: string;
}
