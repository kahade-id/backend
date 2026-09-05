import { Controller, Get, Header } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { PublicService } from './public.service';

@ApiTags('public')
@Controller('public')
export class PublicController {
  constructor(private publicService: PublicService) {}

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Get('config')
  @Header('Cache-Control', 'public, max-age=300, s-maxage=300')
  @ApiOperation({ summary: 'Get public system configurations' })
  async getPublicConfigs(): Promise<{ configs: Array<{ key: string; value: string; description: string | null; dataType: string; updatedAt: Date }> }> {
    return this.publicService.getPublicConfigs();
  }

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Get('fee-schedule')
  @Header('Cache-Control', 'public, max-age=300, s-maxage=300')
  @ApiOperation({ summary: 'Get current fee schedule' })
  getFeeSchedule(): Record<string, unknown> {
    return this.publicService.getFeeSchedule();
  }

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Get('banks')
  @Header('Cache-Control', 'public, max-age=3600, s-maxage=3600')
  @ApiOperation({ summary: 'List supported bank codes' })
  getBanks(): { banks: Array<{ code: string; name: string }> } {
    return this.publicService.getBanks();
  }

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Get('subscription-plans')
  @Header('Cache-Control', 'public, max-age=300, s-maxage=300')
  @ApiOperation({ summary: 'List subscription plans and pricing' })
  async getSubscriptionPlans(): Promise<Record<string, unknown>> {
    return this.publicService.getSubscriptionPlans();
  }

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Get('exchange-rates')
  @Header('Cache-Control', 'public, max-age=300, s-maxage=300')
  @ApiOperation({ summary: 'Get current exchange rates' })
  async getExchangeRates(): Promise<Record<string, unknown>> {
    return this.publicService.getExchangeRates();
  }

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @Get('app-version')
  @Header('Cache-Control', 'public, max-age=300, s-maxage=300')
  @ApiOperation({ summary: 'Get minimum and latest app version for force-update' })
  getAppVersion(): Record<string, unknown> {
    return this.publicService.getAppVersion();
  }
}
