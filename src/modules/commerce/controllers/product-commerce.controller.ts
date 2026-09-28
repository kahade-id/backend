import { Controller, Get, Post, Patch, Body, Param, HttpCode } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ProductCommerceService } from '../services/product-commerce.service';
import { UpdateProductCommerceDto } from '../dto/commerce.dto';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';

@ApiTags('commerce-products')
@ApiBearerAuth('access-token')
@Controller('commerce/products')
export class ProductCommerceController {
  constructor(private readonly service: ProductCommerceService) {}

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Patch(':id')
  @ApiOperation({ summary: 'Update field commerce etalase (tipe produk, harga coret, jadwal publish)' })
  updateCommerce(
    @CurrentUser('sub') userId: string,
    @Param('id') id: string,
    @Body() dto: UpdateProductCommerceDto,
  ) {
    return this.service.updateCommerceFields(userId, id, dto);
  }

  @Throttle({ default: { ttl: 60000, limit: 120 } })
  @Post(':id/click')
  @HttpCode(200)
  @ApiOperation({ summary: 'Catat hit klik produk (publik)' })
  recordClick(@Param('id') id: string) {
    return this.service.recordClick(id);
  }

  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @Get(':id/stats')
  @ApiOperation({ summary: 'Statistik produk — khusus pemilik' })
  getStats(@CurrentUser('sub') userId: string, @Param('id') id: string) {
    return this.service.getProductStats(userId, id);
  }

  @Throttle({ default: { ttl: 60000, limit: 120 } })
  @Get(':id/badges')
  @ApiOperation({ summary: 'Badge produk (TERLARIS/DISKON) — komputasi on-read, publik' })
  getBadges(@Param('id') id: string) {
    return this.service.getProductBadges(id);
  }
}
