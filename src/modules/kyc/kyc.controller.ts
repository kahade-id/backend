import { Controller, Post, Get, Body, Query, Req, BadRequestException, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { KycService } from './kyc.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Idempotency } from '../../common/decorators/idempotency.decorator';
import { UserThrottleGuard } from '../../common/guards/user-throttle.guard';
import { SubmitKycDto } from './dto/submit-kyc.dto';
import { PaginationDto, PaginatedResponse } from '../../common/dto/pagination.dto';
import { Request } from 'express';

@ApiTags('kyc')
@ApiBearerAuth('access-token')
@Controller('kyc')
export class KycController {
  constructor(private readonly kycService: KycService) {}

  @Post('submit')
  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 3 } })
  @Idempotency()
  @ApiOperation({ summary: 'Submit KYC request (gunakan fileKey dari /upload/confirm)' })
  async submit(
    @CurrentUser('sub') userId: string,
    @Body() dto: SubmitKycDto,
    @Req() req: Request,
  ): Promise<Record<string, unknown>> {
    const ipAddress = req.ip;
    this.validateKycFileOwnership(userId, dto.ktpFileKey, dto.selfieFileKey);
    return this.kycService.submit(userId, dto.ktpFileKey, dto.selfieFileKey, dto.nik, ipAddress);
  }

  @Get('status')
  @ApiOperation({ summary: 'Get current KYC status' })
  async getStatus(@CurrentUser('sub') userId: string): Promise<Record<string, unknown>> {
    return this.kycService.getStatus(userId);
  }

  @Get('history')
  @ApiOperation({ summary: 'List all KYC requests (paginated)' })
  async getHistory(
    @CurrentUser('sub') userId: string,
    @Query() pagination: PaginationDto,
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    return this.kycService.getHistory(userId, pagination.page ?? 1, pagination.limit ?? 20);
  }

  @Post('resubmit')
  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 3 } })
  @Idempotency()
  @ApiOperation({ summary: 'Resubmit KYC after rejection (gunakan fileKey dari /upload/confirm)' })
  async resubmit(
    @CurrentUser('sub') userId: string,
    @Body() dto: SubmitKycDto,
    @Req() req: Request,
  ): Promise<Record<string, unknown>> {
    const ipAddress = req.ip;
    this.validateKycFileOwnership(userId, dto.ktpFileKey, dto.selfieFileKey);
    return this.kycService.resubmit(userId, dto.ktpFileKey, dto.selfieFileKey, dto.nik, ipAddress);
  }

  private validateKycFileOwnership(userId: string, ktpFileKey: string, selfieFileKey: string): void {
    const ktpPrefix     = `uploads/kyc-ktp/${userId}/`;
    const selfiePrefix  = `uploads/kyc-selfie/${userId}/`;

    if (!ktpFileKey.startsWith(ktpPrefix) || !selfieFileKey.startsWith(selfiePrefix)) {
      throw new BadRequestException({
        code: 'FILE_ACCESS_DENIED',
        message: 'File key does not belong to this user',
      });
    }
  }
}
