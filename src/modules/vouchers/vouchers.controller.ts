import { Controller, Get, Post, Body, Query, HttpCode, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { VouchersService } from './vouchers.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AllowResponseFields } from '../../common/decorators/allow-response-fields.decorator';
import { ValidateVoucherDto } from './dto/validate-voucher.dto';
import { PaginationDto, PaginatedResponse } from '../../common/dto/pagination.dto';
import { ListVouchersDto } from './dto/list-vouchers.dto';
import { UserThrottleGuard } from '../../common/guards/user-throttle.guard';

@ApiTags('vouchers')
@ApiBearerAuth('access-token')
@Controller('vouchers')
export class VouchersController {
  constructor(private vouchersService: VouchersService) {}

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Get('available')
  @AllowResponseFields('code')
  async getAvailableVouchers(
    @CurrentUser('sub') userId: string,
    @Query() query: ListVouchersDto,
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    return this.vouchersService.getAvailableVouchers(
      userId,
      query.page!,
      query.limit!,
      query.applicableTo,
    );
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @Post('validate')
  @HttpCode(200)
  @AllowResponseFields('code')
  async validateVoucher(
    @CurrentUser('sub') userId: string,
    @Body() dto: ValidateVoucherDto,
  ): Promise<Record<string, unknown>> {
    return this.vouchersService.validateVoucher(userId, dto.code, dto.orderValue, dto.userRole);
  }

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Get('my-usage')
  @AllowResponseFields('code')
  async getMyUsage(
    @CurrentUser('sub') userId: string,
    @Query() pagination: PaginationDto,
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    return this.vouchersService.getMyUsageHistory(
      userId,
      pagination.page!,
      pagination.limit!,
    );
  }
}
