import { Controller, Get, Post, Body, Query, HttpCode } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { SearchTrendsService } from '../services/search-trends.service';
import { RecordSearchDto } from '../dto/commerce.dto';
import { Public } from '../../../common/decorators/public.decorator';

@ApiTags('commerce-trends')
@ApiBearerAuth('access-token')
@Controller('commerce/trends')
export class SearchTrendsController {
  constructor(private readonly service: SearchTrendsService) {}

  @Throttle({ default: { ttl: 60000, limit: 120 } })
  // BES-12 (audit etalase 2026-10-10): klien memanggil tanpa sesi (tamu ikut
  // mencari) — tanpa @Public endpoint selalu 401 dan GET /trends kosong.
  // Payload sudah disanitasi (tanpa PII) + throttle per IP.
  @Public()
  @Post('record')
  @HttpCode(200)
  @ApiOperation({ summary: 'Catat kata kunci pencarian (disanitasi, tanpa PII)' })
  record(@Body() dto: RecordSearchDto) {
    return this.service.recordSearch(dto);
  }

  @Throttle({ default: { ttl: 60000, limit: 120 } })
  // BFE-116: didokumentasikan publik.
  @Public()
  @Get()
  @ApiOperation({ summary: 'Kata kunci pencarian terpopuler (publik)' })
  trending(@Query('limit') limit?: string) {
    const n = limit ? parseInt(limit, 10) : 10;
    return this.service.getTrending(Number.isNaN(n) ? 10 : n);
  }
}
