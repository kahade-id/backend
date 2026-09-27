// GAP-F: partner-facing API (production). Auth via API key, NEVER JWT.
// Guards: PartnerApiKeyGuard (auth) → PartnerRateLimitGuard (429 + quota) → PartnerScopeGuard.
// Usage recorded by PartnerUsageInterceptor.

import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  UseGuards,
  UseInterceptors,
  HttpCode,
  HttpStatus,
  Req,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiSecurity } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { PartnerAuth, PartnerScopes, PartnerRequestIdentity } from './partner.decorators';
import { PartnerApiKeyGuard } from './partner-api-key.guard';
import { PartnerScopeGuard } from './partner-scope.guard';
import { PartnerRateLimitGuard } from './partner-rate-limit.guard';
import { PartnerUsageInterceptor } from './partner-usage.interceptor';
import { PartnerApiService } from './partner-api.service';
import { PartnerWebhookService } from './partner-webhook.service';
import { VerifyChallengeDto } from './dto/partner.dto';

@ApiTags('partner')
@ApiSecurity('api-key')
@Public() // bypass global JWT guard — API-key guard below is the real auth
@PartnerAuth()
@UseGuards(PartnerApiKeyGuard, PartnerRateLimitGuard, PartnerScopeGuard)
@UseInterceptors(PartnerUsageInterceptor)
@Controller('partner')
export class PartnerController {
  constructor(
    private readonly api: PartnerApiService,
    private readonly webhooks: PartnerWebhookService,
  ) {}

  @Get('orders/:publicId')
  @PartnerScopes('orders:read')
  @ApiOperation({ summary: 'Get order detail (scoped to the client\'s own orders)' })
  @ApiResponse({ status: 200, description: 'Order detail (whitelisted fields).' })
  @ApiResponse({ status: 404, description: 'Order not found or not accessible.' })
  getOrder(@Param('publicId') publicId: string, @Req() req: { partner: PartnerRequestIdentity }) {
    return this.api.getOrder(publicId, req.partner);
  }

  @Get('webhooks/health')
  @ApiOperation({ summary: 'Webhook subscription health (G473)' })
  @ApiResponse({ status: 200, description: 'Event subscriptions + endpoint status.' })
  webhookHealth(@Req() req: { partner: PartnerRequestIdentity }) {
    return this.api.webhookHealth(req.partner);
  }

  @Post('webhooks/verify-challenge')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Echo ownership challenge token to activate a webhook endpoint' })
  @ApiResponse({ status: 200, description: 'Endpoint verified and activated.' })
  verifyChallenge(@Body() dto: VerifyChallengeDto, @Req() req: { partner: PartnerRequestIdentity }) {
    return this.webhooks.verifyChallenge(req.partner, dto.endpointId, dto.challenge);
  }
}
