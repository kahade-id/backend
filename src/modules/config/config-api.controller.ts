import { Controller, Get, Header } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { PublicService } from '../public/public.service';

@ApiTags('config')
@Controller('config')
export class ConfigApiController {
  constructor(private publicService: PublicService) {}

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Get('exchange-rates')
  @Header('Cache-Control', 'public, max-age=300, s-maxage=300')
  @ApiOperation({ summary: 'Get current exchange rates' })
  async getExchangeRates(): Promise<Record<string, unknown>> {
    return this.publicService.getExchangeRates();
  }
}

@ApiTags('app')
@Controller('app')
export class AppApiController {
  constructor(private publicService: PublicService) {}

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @Get('version')
  @Header('Cache-Control', 'public, max-age=300, s-maxage=300')
  @ApiOperation({ summary: 'Get minimum and latest app version for force-update' })
  getAppVersion(): Record<string, unknown> {
    return this.publicService.getAppVersion();
  }
}
