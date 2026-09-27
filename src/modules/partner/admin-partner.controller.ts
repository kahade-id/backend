// GAP-F (G457/G463/G467/G468/G469): admin portal for partner clients.
// SUPER_ADMIN only. Actual routes: /v1/admin/partner-clients/* (global prefix v1).
// Secrets (API key plaintext, webhook secrets) are NEVER returned here.

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Request } from 'express';
import { AdminRoute } from '../../common/decorators/public.decorator';
import { AdminRoles } from '../../common/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../../common/decorators/current-admin.decorator';
import { JwtAdminGuard } from '../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../common/guards/admin-roles.guard';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe';
import { PartnerClientService } from './partner-client.service';
import { PartnerWebhookService } from './partner-webhook.service';
import { PartnerUsageService } from './partner-usage.service';
import {
  CreatePartnerClientDto,
  CreateWebhookEndpointDto,
  IssuePartnerKeyDto,
  RotatePartnerKeyDto,
  RevokePartnerKeyDto,
  UpdatePartnerClientDto,
  UpdateWebhookEndpointDto,
} from './dto/partner.dto';

@ApiTags('admin-partner-clients')
@ApiBearerAuth('access-token')
@UseGuards(JwtAdminGuard, AdminRolesGuard)
@AdminRoles('SUPER_ADMIN')
@AdminRoute()
@Controller('admin/partner-clients')
export class AdminPartnerController {
  constructor(
    private readonly clients: PartnerClientService,
    private readonly webhooks: PartnerWebhookService,
    private readonly usage: PartnerUsageService,
  ) {}

  // ---------- Clients ----------

  @Post()
  @ApiOperation({ summary: 'Create a partner client' })
  @ApiResponse({ status: 201, description: 'Client created.' })
  createClient(@Body() dto: CreatePartnerClientDto, @CurrentAdmin('sub') adminId: string, @Req() req: Request) {
    return this.clients.createClient(dto, adminId ?? '', req.ip ?? '');
  }

  @Get()
  @ApiOperation({ summary: 'List partner clients' })
  listClients(@Query('page') page?: string, @Query('limit') limit?: string) {
    return this.clients.listClients(Number(page) || 1, Math.min(100, Number(limit) || 20));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Client detail: keys (redacted), endpoints, usage summary' })
  async getClient(@Param('id', ParseIdPipe) id: string) {
    // ADM-304: kunci (teredaksi) diekspos eksplisit sebagai `keys` agar
    // client admin tidak perlu mengorek nested object.
    const [clientRow, endpoints, usageSummary] = await Promise.all([
      this.clients.getClient(id),
      this.webhooks.listEndpoints(id),
      this.usage.summary(id),
    ]);
    const row = clientRow as unknown as Record<string, unknown>;
    const { keys, ...client } = row;
    return { client, keys, endpoints, usage: usageSummary };
  }

  @Get(':id/keys')
  @ApiOperation({ summary: 'List API keys for a client (redacted — no hashes/secrets)' })
  async listKeys(@Param('id', ParseIdPipe) id: string) {
    // ADM-304: endpoint daftar kunci eksplisit (ringkasan teredaksi).
    const row = (await this.clients.getClient(id)) as unknown as Record<string, unknown>;
    return { clientId: id, keys: row['keys'] ?? [] };
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update client (status, quotas, limits)' })
  updateClient(
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: UpdatePartnerClientDto,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ) {
    return this.clients.updateClient(id, dto, adminId ?? '', req.ip ?? '');
  }

  @Get(':id/audit-log')
  @ApiOperation({ summary: 'Partner audit log for a client' })
  auditLog(@Param('id', ParseIdPipe) id: string, @Query('limit') limit?: string) {
    return this.clients.getAuditLog(id, Math.min(200, Number(limit) || 50));
  }

  // ---------- Keys ----------

  @Post(':id/keys')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Issue API key — plaintext returned ONCE in this response' })
  @ApiResponse({ status: 201, description: 'Key issued. Plaintext shown once.' })
  issueKey(
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: IssuePartnerKeyDto,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ) {
    return this.clients.issueKey(id, dto, adminId ?? '', req.ip ?? '');
  }

  @Post(':id/keys/:keyId/rotate')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Rotate key — new key issued, old key valid 24h overlap (body optional; inherited from old key)' })
  rotateKey(
    @Param('id', ParseIdPipe) id: string,
    @Param('keyId', ParseIdPipe) keyId: string,
    @Body() dto: RotatePartnerKeyDto,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ) {
    return this.clients.rotateKey(id, keyId, dto, adminId ?? '', req.ip ?? '');
  }

  @Post(':id/keys/:keyId/revoke')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke key instantly (reason required)' })
  revokeKey(
    @Param('id', ParseIdPipe) id: string,
    @Param('keyId', ParseIdPipe) keyId: string,
    @Body() dto: RevokePartnerKeyDto,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ) {
    return this.clients.revokeKey(id, keyId, dto, adminId ?? '', req.ip ?? '');
  }

  // ---------- Webhook endpoints ----------

  @Post(':id/endpoints')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Register webhook endpoint (HTTPS, SSRF-validated). Secret returned ONCE.' })
  createEndpoint(
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: CreateWebhookEndpointDto,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ) {
    return this.webhooks.createEndpoint(id, dto, adminId ?? '', req.ip ?? '');
  }

  @Get(':id/endpoints')
  @ApiOperation({ summary: 'List webhook endpoints (redacted)' })
  listEndpoints(@Param('id', ParseIdPipe) id: string) {
    return this.webhooks.listEndpoints(id);
  }

  @Patch(':id/endpoints/:endpointId')
  @ApiOperation({ summary: 'Update webhook endpoint' })
  updateEndpoint(
    @Param('id', ParseIdPipe) id: string,
    @Param('endpointId', ParseIdPipe) endpointId: string,
    @Body() dto: UpdateWebhookEndpointDto,
  ) {
    return this.webhooks.updateEndpoint(id, endpointId, dto);
  }

  @Delete(':id/endpoints/:endpointId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete webhook endpoint' })
  async deleteEndpoint(@Param('id', ParseIdPipe) id: string, @Param('endpointId', ParseIdPipe) endpointId: string) {
    await this.webhooks.deleteEndpoint(id, endpointId);
  }

  @Post(':id/endpoints/:endpointId/challenge')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send ownership challenge to the endpoint URL' })
  issueChallenge(@Param('id', ParseIdPipe) id: string, @Param('endpointId', ParseIdPipe) endpointId: string) {
    return this.webhooks.issueChallenge(id, endpointId);
  }

  @Post(':id/endpoints/:endpointId/test')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send synthetic webhook.test event (G467)' })
  sendTest(@Param('id', ParseIdPipe) id: string, @Param('endpointId', ParseIdPipe) endpointId: string) {
    return this.webhooks.sendTest(id, endpointId);
  }

  // ---------- Deliveries ----------

  @Get(':id/deliveries')
  @ApiOperation({ summary: 'Redacted delivery log (G468)' })
  deliveryLog(
    @Param('id', ParseIdPipe) id: string,
    @Query('endpointId') endpointId?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.webhooks.deliveryLog(id, {
      endpointId,
      status,
      page: Number(page) || 1,
      limit: Math.min(100, Number(limit) || 20),
    });
  }

  @Post(':id/deliveries/:deliveryId/replay')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Manual replay of a delivery — same eventId (idempotent, G469)' })
  replay(@Param('id', ParseIdPipe) id: string, @Param('deliveryId', ParseIdPipe) deliveryId: string) {
    return this.webhooks.replay(id, deliveryId);
  }

  // ---------- Usage ----------

  @Get(':id/usage')
  @ApiOperation({ summary: 'Usage summary: daily per-endpoint counts + quota (G461)' })
  usageSummary(@Param('id', ParseIdPipe) id: string, @Query('days') days?: string) {
    return this.usage.summary(id, Math.min(90, Number(days) || 7));
  }
}
