import { AdminRoute } from '../../../common/decorators/public.decorator';
import { Controller, Get, Post, Put, Param, Body, Query, UseGuards, Req } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AdminSystemService } from './admin-system.service';
import { UpdateConfigDto } from './dto/update-config.dto';
import { BroadcastDto } from './dto/broadcast.dto';
import { AuditLogQueryDto, WebhookLogQueryDto } from './dto/audit-log-query.dto';
import { WebhookDeadLetterResolutionDto } from './dto/webhook-dead-letter.dto';
import { Idempotency } from '../../../common/decorators/idempotency.decorator';
import { Throttle } from '@nestjs/throttler';
import { JwtAdminGuard } from '../../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../../common/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../../../common/decorators/current-admin.decorator';
import { ParseIdPipe } from '../../../common/pipes/parse-id.pipe';
import { Request } from 'express';
import { UserThrottleGuard } from '../../../common/guards/user-throttle.guard';
import { StepUpGuard } from '../../../common/guards/step-up.guard';
import { RequireStepUp } from '../../../common/decorators/require-step-up.decorator';
import { AdminJwtPayload } from '../../../common/types/jwt-payload.types';

@ApiTags('admin-system')
@ApiBearerAuth('access-token')
@UseGuards(JwtAdminGuard, AdminRolesGuard)
@AdminRoles('SUPER_ADMIN')
@AdminRoute()
@Controller('admin/system')
export class AdminSystemController {
  constructor(private readonly service: AdminSystemService) {}

  @Get('configs')
  @ApiOperation({ summary: 'List system configs' })
  @ApiResponse({ status: 200, description: 'System configs list returned.' })
  listConfigs(): Promise<object[]> {
    return this.service.listConfigs();
  }

  @Put('configs/:key')
  @UseGuards(UserThrottleGuard, StepUpGuard)
  // SYS-B-405: klasifikasi finansial/security eksplisit per key (registry).
  // Key finansial/security-gated SELALU via dual control (tabel approvals) —
  // endpoint ini hanya membuat usulan PENDING; eksekusi oleh admin kedua.
  // admin_mfa_required = security-gated: tidak bisa dimatikan 1 admin.
  @RequireStepUp('systemConfig.update', 'key')
  @Idempotency()
  @ApiOperation({ summary: 'Update system config value', description: 'SYS-B-405: requires X-Step-Up-Token (action systemConfig.update). Untuk key finansial/security-gated, perubahan disimpan sebagai usulan dual control (butuh approval admin kedua via POST /v1/admin/approvals/:id/approve atau rute kompatibilitas configs/:key/approve).' })
  @ApiResponse({ status: 200, description: 'System config updated or pending approval.' })
  @ApiResponse({ status: 404, description: 'Config key not found.' })
  updateConfig(
    @Param('key') key: string,
    @Body() dto: UpdateConfigDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.updateConfig(key, dto, admin.sub, admin.role, req.ip ?? '');
  }

  @Get('configs/pending')
  @ApiOperation({ summary: 'List pending financial/security config changes awaiting approval', description: 'SYS-B-405: dibaca dari tabel approvals (satu-satunya sistem dual control).' })
  @ApiResponse({ status: 200, description: 'Pending config changes list returned.' })
  listPendingConfigChanges(): Promise<object[]> {
    return this.service.listPendingConfigChanges();
  }

  @Post('configs/:key/approve')
  @UseGuards(UserThrottleGuard, StepUpGuard)
  // SYS-B-405: rute kompatibilitas — diteruskan ke approvals (menjamin bukan
  // pengusul sendiri + belum kedaluwarsa). Action step-up sama dengan
  // pemetaan SYSTEM_CONFIG_CHANGE agar satu token berlaku untuk kedua rute.
  @RequireStepUp('systemConfig.update', 'key')
  @Idempotency()
  @ApiOperation({ summary: 'Approve a pending financial config change', description: 'SYS-B-405: requires X-Step-Up-Token (action systemConfig.update). Must be a different admin than the one who proposed the change. Diteruskan ke sistem dual control terpusat (tabel approvals).' })
  @ApiResponse({ status: 200, description: 'Config change approved and applied.' })
  @ApiResponse({ status: 403, description: 'Cannot approve own change.' })
  @ApiResponse({ status: 404, description: 'No pending change found.' })
  approveConfigChange(
    @Param('key') key: string,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.approveConfigChange(key, admin.sub, admin.role, req.ip ?? '');
  }

  @Post('configs/:key/reject')
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @ApiOperation({ summary: 'Reject a pending financial config change', description: 'SYS-B-405: diteruskan ke sistem dual control terpusat (tabel approvals).' })
  @ApiResponse({ status: 200, description: 'Config change rejected.' })
  @ApiResponse({ status: 404, description: 'No pending change found.' })
  rejectConfigChange(
    @Param('key') key: string,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    return this.service.rejectConfigChange(key, admin.sub, admin.role, req.ip ?? '');
  }

  @Get('audit-logs')
  @ApiOperation({ summary: 'List admin audit logs' })
  @ApiResponse({ status: 200, description: 'Audit logs list returned.' })
  listAuditLogs(@Query() query: AuditLogQueryDto): Promise<object> {
    return this.service.listAuditLogs(query);
  }

  @Get('webhook-logs')
  @ApiOperation({ summary: 'List webhook logs' })
  @ApiResponse({ status: 200, description: 'Webhook logs list returned.' })
  listWebhookLogs(@Query() query: WebhookLogQueryDto): Promise<object> {
    return this.service.listWebhookLogs(query);
  }

  @Post('webhook-logs/:id/retry')
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @AdminRoles('SUPER_ADMIN')
  @ApiOperation({ summary: 'Requeue dead-letter webhook', description: 'Resets a failed webhook to retryable state. Requires Idempotency-Key.' })
  retryDeadLetterWebhook(
    @Param('id', ParseIdPipe) id: string,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.retryDeadLetterWebhook(id, adminId, req.ip ?? '');
  }

  @Post('webhook-logs/:id/resolve')
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @AdminRoles('SUPER_ADMIN')
  @ApiOperation({ summary: 'Resolve dead-letter webhook', description: 'Marks a dead-letter webhook as manually resolved and prevents automatic retry.' })
  resolveDeadLetterWebhook(
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: WebhookDeadLetterResolutionDto,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.resolveDeadLetterWebhook(id, adminId, req.ip ?? '', dto.resolution);
  }

  @Post('broadcast')
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @ApiOperation({ summary: 'Send broadcast notification', description: 'Sends a broadcast notification to users based on target audience filter.' })
  @ApiResponse({ status: 201, description: 'Broadcast sent successfully.' })
  sendBroadcast(
    @Body() dto: BroadcastDto,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<{ recipientCount: number }> {
    return this.service.sendBroadcast(dto, adminId, req.ip ?? '');
  }
}
