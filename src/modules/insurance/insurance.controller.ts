import { Body, Controller, Get, Post, Query, DefaultValuePipe, ParseIntPipe, UseGuards } from '@nestjs/common';
import { ClampLimitPipe } from '../../common/pipes/clamp-limit.pipe';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { InsuranceService } from './insurance.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CreateInsuranceClaimDto } from './dto/insurance-claim.dto';
import { UserThrottleGuard } from '../../common/guards/user-throttle.guard';
import { Param } from '@nestjs/common';

@ApiTags('insurance')
@ApiBearerAuth('access-token')
@Controller('insurance')
export class InsuranceController {
  constructor(private readonly insuranceService: InsuranceService) {}

  @Post('claims')
  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: 'Ajukan klaim asuransi Kahade+ (hanya subscriber aktif)' })
  async createClaim(
    @CurrentUser('sub') userId: string,
    @Body() dto: CreateInsuranceClaimDto,
  ): Promise<Record<string, unknown>> {
    return this.insuranceService.createClaim(userId, dto);
  }

  @Get('claims')
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @ApiOperation({ summary: 'Daftar klaim asuransi milik user' })
  async listClaims(
    @CurrentUser('sub') userId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe, new ClampLimitPipe()) limit: number,
  ): Promise<object> {
    return this.insuranceService.listClaims(userId, page, limit);
  }

  @Get('claims/:claimId')
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @ApiOperation({ summary: 'Detail klaim asuransi milik user' })
  async getClaim(
    @CurrentUser('sub') userId: string,
    @Param('claimId', ParseIdPipe) claimId: string,
  ): Promise<Record<string, unknown>> {
    return this.insuranceService.getClaim(userId, claimId);
  }
}
