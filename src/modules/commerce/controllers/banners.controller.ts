import { Controller, Get, Post, Patch, Delete, Body, Param, Query } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { BannersService } from '../services/banners.service';
import { CreateBannerDto, UpdateBannerDto } from '../dto/commerce.dto';
import { PaginationDto } from '../../../common/dto/pagination.dto';

/** GET /v1/banners/active — publik. */
@ApiTags('banners')
@Controller('banners')
export class BannersController {
  constructor(private readonly service: BannersService) {}

  @Throttle({ default: { ttl: 60000, limit: 120 } })
  @Get('active')
  @ApiOperation({ summary: 'Banner aktif (publik, filter tanggal tayang)' })
  active(@Query('position') position?: string) {
    return this.service.getActiveBanners(position);
  }
}
