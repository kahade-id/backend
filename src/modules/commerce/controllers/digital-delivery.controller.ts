import { Controller, Get, Post, Delete, Body, Param, Query, HttpCode } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { DigitalDeliveryService } from '../services/digital-delivery.service';
import { CreateDigitalAssetDto } from '../dto/commerce.dto';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { PaginationDto } from '../../../common/dto/pagination.dto';

@ApiTags('commerce-digital-assets')
@ApiBearerAuth('access-token')
@Controller('commerce/digital-assets')
export class DigitalDeliveryController {
  constructor(private readonly service: DigitalDeliveryService) {}

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Post()
  @ApiOperation({ summary: 'Seller menambah aset digital (file/link/lisensi) untuk produk DIGITAL' })
  create(@CurrentUser('sub') sellerId: string, @Body() dto: CreateDigitalAssetDto) {
    return this.service.createAsset(sellerId, dto);
  }

  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @Get('showcase/:showcaseId/seller')
  @ApiOperation({ summary: 'Kelola aset digital produk (seller)' })
  listSeller(
    @CurrentUser('sub') sellerId: string,
    @Param('showcaseId') showcaseId: string,
    @Query() pagination: PaginationDto,
  ) {
    return this.service.listSellerAssets(sellerId, showcaseId, pagination.page ?? 1, pagination.limit ?? 20);
  }

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Delete(':id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Hapus aset digital (seller)' })
  remove(@CurrentUser('sub') sellerId: string, @Param('id') id: string) {
    return this.service.deleteAsset(sellerId, id);
  }

  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @Get('showcase/:showcaseId')
  @ApiOperation({ summary: 'Lihat aset digital — otomatis terbuka untuk buyer SETELAH bayar' })
  listBuyer(@CurrentUser('sub') userId: string, @Param('showcaseId') showcaseId: string) {
    return this.service.listBuyerAssets(userId, showcaseId);
  }

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Get(':id/download')
  @ApiOperation({ summary: 'Signed URL unduhan aset FILE (pemilik atau pembeli berbayar; 15 menit)' })
  download(@CurrentUser('sub') userId: string, @Param('id') id: string) {
    return this.service.downloadAsset(userId, id);
  }
}
