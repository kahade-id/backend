import { Controller, Get, Post, Patch, Body, Param, Query, HttpCode } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { SellerVouchersService } from '../services/seller-vouchers.service';
import { CreateSellerVoucherDto, ValidateSellerVoucherDto } from '../dto/commerce.dto';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { PaginationDto, PaginatedResponse } from '../../../common/dto/pagination.dto';

@ApiTags('seller-vouchers')
@ApiBearerAuth('access-token')
@Controller('seller-vouchers')
export class SellerVouchersController {
  constructor(private readonly service: SellerVouchersService) {}

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Post()
  @ApiOperation({ summary: 'Seller membuat voucher toko' })
  create(@CurrentUser('sub') sellerId: string, @Body() dto: CreateSellerVoucherDto) {
    return this.service.createVoucher(sellerId, dto);
  }

  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @Get('mine')
  @ApiOperation({ summary: 'Daftar voucher milik seller' })
  listMine(
    @CurrentUser('sub') sellerId: string,
    @Query() pagination: PaginationDto,
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    return this.service.listMyVouchers(sellerId, pagination.page ?? 1, pagination.limit ?? 20);
  }

  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @Post('validate')
  @HttpCode(200)
  @ApiOperation({ summary: 'Validasi kode voucher seller untuk order ke seller tertentu' })
  validate(@CurrentUser('sub') userId: string, @Body() dto: ValidateSellerVoucherDto) {
    return this.service.validateVoucher(userId, dto);
  }

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Patch(':id/deactivate')
  @HttpCode(200)
  @ApiOperation({ summary: 'Nonaktifkan voucher milik seller' })
  deactivate(@CurrentUser('sub') sellerId: string, @Param('id') id: string) {
    return this.service.deactivateVoucher(sellerId, id);
  }
}
