import { IsOptional, IsBoolean, IsString, IsIn, Matches } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdatePreferencesDto {
  @ApiPropertyOptional({ description: 'Order in-app notifications' })
  @IsOptional()
  @IsBoolean()
  orderInApp?: boolean;

  @ApiPropertyOptional({ description: 'Order push notifications' })
  @IsOptional()
  @IsBoolean()
  orderPush?: boolean;

  @ApiPropertyOptional({ description: 'Order email notifications' })
  @IsOptional()
  @IsBoolean()
  orderEmail?: boolean;

  @ApiPropertyOptional({ description: 'Wallet in-app notifications' })
  @IsOptional()
  @IsBoolean()
  walletInApp?: boolean;

  @ApiPropertyOptional({ description: 'Wallet push notifications' })
  @IsOptional()
  @IsBoolean()
  walletPush?: boolean;

  @ApiPropertyOptional({ description: 'Wallet email notifications' })
  @IsOptional()
  @IsBoolean()
  walletEmail?: boolean;

  @ApiPropertyOptional({ description: 'Security in-app notifications' })
  @IsOptional()
  @IsBoolean()
  securityInApp?: boolean;

  @ApiPropertyOptional({ description: 'Security push notifications' })
  @IsOptional()
  @IsBoolean()
  securityPush?: boolean;

  @ApiPropertyOptional({ description: 'Security email notifications' })
  @IsOptional()
  @IsBoolean()
  securityEmail?: boolean;

  @ApiPropertyOptional({ description: 'Chat in-app notifications' })
  @IsOptional()
  @IsBoolean()
  chatInApp?: boolean;

  @ApiPropertyOptional({ description: 'Chat push notifications' })
  @IsOptional()
  @IsBoolean()
  chatPush?: boolean;

  @ApiPropertyOptional({ description: 'Dispute in-app notifications' })
  @IsOptional()
  @IsBoolean()
  disputeInApp?: boolean;

  @ApiPropertyOptional({ description: 'Dispute push notifications' })
  @IsOptional()
  @IsBoolean()
  disputePush?: boolean;

  @ApiPropertyOptional({ description: 'Dispute email notifications' })
  @IsOptional()
  @IsBoolean()
  disputeEmail?: boolean;

  @ApiPropertyOptional({ description: 'Ranking in-app notifications' })
  @IsOptional()
  @IsBoolean()
  rankingInApp?: boolean;

  @ApiPropertyOptional({ description: 'Ranking push notifications' })
  @IsOptional()
  @IsBoolean()
  rankingPush?: boolean;

  @ApiPropertyOptional({ description: 'Marketing email notifications' })
  @IsOptional()
  @IsBoolean()
  marketingEmail?: boolean;

  @ApiPropertyOptional({ description: 'Marketing push notifications' })
  @IsOptional()
  @IsBoolean()
  marketingPush?: boolean;

  @ApiPropertyOptional({ description: 'Marketing in-app notifications' })
  @IsOptional()
  @IsBoolean()
  marketingInApp?: boolean;

  @ApiPropertyOptional({ description: 'Quiet hours enabled' })
  @IsOptional()
  @IsBoolean()
  quietHoursEnabled?: boolean;

  @ApiPropertyOptional({ description: 'Quiet hours start (HH:mm)' })
  @IsOptional()
  @IsString()
  @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/, { message: 'quietHoursStart must be HH:mm' })
  quietHoursStart?: string;

  @ApiPropertyOptional({ description: 'Quiet hours end (HH:mm)' })
  @IsOptional()
  @IsString()
  @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/, { message: 'quietHoursEnd must be HH:mm' })
  quietHoursEnd?: string;

  @ApiPropertyOptional({ description: 'Preferred language', enum: ['id', 'en'] })
  @IsOptional()
  @IsIn(['id', 'en'])
  language?: string;
}
