// GAP-F: DTOs for partner admin + partner-facing APIs.
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  ArrayMinSize,
  ArrayMaxSize,
  IsIn,
} from 'class-validator';
import { PARTNER_SCOPES, PARTNER_WEBHOOK_EVENTS } from '../partner.constants';

export class CreatePartnerClientDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  orgName!: string;

  @IsString()
  @IsOptional()
  @MaxLength(64)
  ownerUserId?: string;

  @IsBoolean()
  @IsOptional()
  isSandbox?: boolean;

  @IsInt()
  @Min(1)
  @Max(100000)
  @IsOptional()
  rateLimitPerMinute?: number;

  @IsInt()
  @Min(0)
  @Max(10000000)
  @IsOptional()
  quotaPerDay?: number;
}

export class UpdatePartnerClientDto {
  @IsString()
  @IsOptional()
  @MaxLength(120)
  orgName?: string;

  @IsIn(['ACTIVE', 'SUSPENDED', 'REVOKED'])
  @IsOptional()
  status?: 'ACTIVE' | 'SUSPENDED' | 'REVOKED';

  @IsInt()
  @Min(1)
  @Max(100000)
  @IsOptional()
  rateLimitPerMinute?: number;

  @IsInt()
  @Min(0)
  @Max(10000000)
  @IsOptional()
  quotaPerDay?: number;
}

export class IssuePartnerKeyDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(16)
  @IsIn(PARTNER_SCOPES as unknown as string[], { each: true })
  scopes!: string[];

  @IsISO8601()
  @IsOptional()
  expiresAt?: string;
}

export class RevokePartnerKeyDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(280)
  reason!: string;
}

export class CreateWebhookEndpointDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  url!: string;

  @IsArray()
  @ArrayMinSize(1)
  @IsIn(PARTNER_WEBHOOK_EVENTS as unknown as string[], { each: true })
  events!: string[];

  @IsString()
  @IsOptional()
  @MaxLength(80)
  description?: string;
}

export class UpdateWebhookEndpointDto {
  @IsString()
  @IsOptional()
  @MaxLength(500)
  url?: string;

  @IsArray()
  @ArrayMinSize(1)
  @IsOptional()
  @IsIn(PARTNER_WEBHOOK_EVENTS as unknown as string[], { each: true })
  events?: string[];

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

export class VerifyChallengeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  endpointId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  challenge!: string;
}
