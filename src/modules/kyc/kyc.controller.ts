import { Controller, Post, Get, Body, Query, Req, BadRequestException, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { KycService } from './kyc.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Idempotency } from '../../common/decorators/idempotency.decorator';
import { UserThrottleGuard } from '../../common/guards/user-throttle.guard';
import { SubmitKycDto, KycDocumentType } from './dto/submit-kyc.dto';
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
  @ApiOperation({ summary: 'Submit KYC request (gunakan fileKey dari /upload/confirm). Supports KTP and PASSPORT.' })
  async submit(
    @CurrentUser('sub') userId: string,
    @Body() dto: SubmitKycDto,
    @Req() req: Request,
  ): Promise<Record<string, unknown>> {
    const ipAddress = req.ip;
    this.validateKycFileOwnership(userId, dto);
    return this.kycService.submit(
      userId,
      dto.ktpFileKey ?? '',
      dto.selfieFileKey,
      dto.nik,
      ipAddress,
      {
        documentType: dto.documentType ?? KycDocumentType.KTP,
        passportFileKey: dto.passportFileKey,
        livenessFileKey: dto.livenessFileKey,
      },
    );
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
    this.validateKycFileOwnership(userId, dto);
    return this.kycService.resubmit(
      userId,
      dto.ktpFileKey ?? '',
      dto.selfieFileKey,
      dto.nik,
      ipAddress,
      {
        documentType: dto.documentType ?? KycDocumentType.KTP,
        passportFileKey: dto.passportFileKey,
        livenessFileKey: dto.livenessFileKey,
      },
    );
  }

  private validateKycFileOwnership(userId: string, dto: SubmitKycDto): void {
    const checks: { key?: string; prefix: string }[] = [];
    if (dto.documentType === KycDocumentType.PASSPORT) {
      if (dto.passportFileKey) checks.push({ key: dto.passportFileKey, prefix: `uploads/kyc-passport/${userId}/` });
    } else {
      if (dto.ktpFileKey) checks.push({ key: dto.ktpFileKey, prefix: `uploads/kyc-ktp/${userId}/` });
    }
    checks.push({ key: dto.selfieFileKey, prefix: `uploads/kyc-selfie/${userId}/` });
    if (dto.livenessFileKey) checks.push({ key: dto.livenessFileKey, prefix: `uploads/kyc-liveness/${userId}/` });

    for (const c of checks) {
      if (!c.key || !c.key.startsWith(c.prefix)) {
        throw new BadRequestException({
          code: 'FILE_ACCESS_DENIED',
          message: `File key does not belong to this user or invalid prefix: ${c.prefix}`,
        });
      }
    }
  }
}
