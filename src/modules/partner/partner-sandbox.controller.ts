// GAP-F (G458): sandbox partner API. Sandbox keys ONLY; synthetic data only;
// production keys are rejected here, sandbox keys are rejected on /v1/partner/*.

import { Controller, Get, Param, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiSecurity } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { PartnerAuth, PartnerScopes, PartnerRequestIdentity } from './partner.decorators';
import { PartnerApiKeyGuard } from './partner-api-key.guard';
import { PartnerScopeGuard } from './partner-scope.guard';
import { PartnerRateLimitGuard } from './partner-rate-limit.guard';
import { PartnerUsageInterceptor } from './partner-usage.interceptor';
import { PartnerApiService } from './partner-api.service';

@ApiTags('partner-sandbox')
@ApiSecurity('api-key')
@Public()
@PartnerAuth()
@UseGuards(PartnerApiKeyGuard, PartnerRateLimitGuard, PartnerScopeGuard)
@UseInterceptors(PartnerUsageInterceptor)
@Controller('partner-sandbox')
export class PartnerSandboxController {
  constructor(private readonly api: PartnerApiService) {}

  @Get('orders/:publicId')
  @PartnerScopes('orders:read')
  @ApiOperation({ summary: '[SANDBOX] Get synthetic order detail — never production data' })
  @ApiResponse({ status: 200, description: 'Synthetic order detail.' })
  getOrder(@Param('publicId') publicId: string, @Req() _req: { partner: PartnerRequestIdentity }) {
    return this.api.sandboxOrder(publicId);
  }

  @Get('webhooks/health')
  @ApiOperation({ summary: '[SANDBOX] Webhook subscription health (synthetic)' })
  @ApiResponse({ status: 200, description: 'Synthetic subscription status.' })
  webhookHealth() {
    return {
      version: '1.0',
      sandbox: true,
      isSandbox: true,
      endpoints: [],
      note: 'Sandbox: tidak ada endpoint produksi yang terdaftar di sini.',
    };
  }
}
