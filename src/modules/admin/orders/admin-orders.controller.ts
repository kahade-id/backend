import { AdminRoute } from '../../../common/decorators/public.decorator';
import { Controller, Get, Post, Param, Body, Query, UseGuards, Req } from '@nestjs/common';
import { ParseIdPipe } from '../../../common/pipes/parse-id.pipe';
import { Request } from 'express';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AdminOrdersService } from './admin-orders.service';
import { PaginatedResponse } from '../../../common/dto/pagination.dto';
import { AdminOrderQueryDto, ForceActionDto, ForceActionWithReauthDto } from './dto/admin-order-query.dto';
import { JwtAdminGuard } from '../../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../../common/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../../../common/decorators/current-admin.decorator';
import { AdminJwtPayload } from '../../../common/types/jwt-payload.types';
import { Idempotency } from '../../../common/decorators/idempotency.decorator';
import { UserThrottleGuard } from '../../../common/guards/user-throttle.guard';

@ApiTags('admin-orders')
@ApiBearerAuth('access-token')
@UseGuards(JwtAdminGuard, AdminRolesGuard)
@AdminRoles('SUPER_ADMIN', 'DISPUTE_ADMIN')
@AdminRoute()
@Controller('admin/orders')
export class AdminOrdersController {
  constructor(private readonly service: AdminOrdersService) {}

  @Get()
  @ApiOperation({ summary: 'List all orders', description: 'Paginated list of all orders with optional status and date range filters.' })
  @ApiResponse({ status: 200, description: 'Orders list returned.' })
  listOrders(@Query() query: AdminOrderQueryDto, @CurrentAdmin() admin: AdminJwtPayload): Promise<PaginatedResponse<Record<string, unknown>>> {
    return this.service.listOrders(query, admin.role);
  }

  @Get(':orderId')
  @ApiOperation({ summary: 'Get order detail', description: 'Returns full order detail including participants, wallet transactions, and status history.' })
  @ApiResponse({ status: 200, description: 'Order detail returned.' })
  @ApiResponse({ status: 404, description: 'Order not found.' })
  getOrderDetail(@Param('orderId', ParseIdPipe) orderId: string, @CurrentAdmin() admin: AdminJwtPayload): Promise<Record<string, unknown>> {
    return this.service.getOrderDetail(orderId, admin.role);
  }

  @Post(':orderId/force-cancel')
  @Idempotency()
  @UseGuards(UserThrottleGuard)
  @AdminRoles('SUPER_ADMIN', 'DISPUTE_ADMIN')
  @ApiOperation({
    summary: 'Force cancel order',
    description:
      'Admin force-cancels an order with optional escrow refund. ' +
      'ADM-404: DISPUTE_ADMIN hanya untuk order dengan dispute aktif; di luar itu butuh SUPER_ADMIN. Reason wajib (min 10 karakter). ' +
      'AUT-013: aksi finansial final — password admin wajib di body (re-auth).',
  })
  @ApiResponse({ status: 200, description: 'Order force-cancelled.' })
  @ApiResponse({ status: 400, description: 'Invalid order status for cancellation.' })
  @ApiResponse({ status: 403, description: 'DISPUTE_ADMIN di luar konteks dispute aktif.' })
  @ApiResponse({ status: 404, description: 'Order not found.' })
  forceCancel(
    @Param('orderId', ParseIdPipe) orderId: string,
    @Body() dto: ForceActionWithReauthDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<{ orderId: string; status: string }> {
    return this.service.forceCancel(orderId, admin.sub, admin.role, dto, req.ip || 'unknown');
  }

  @Post(':orderId/cancel-unshipped')
  @Idempotency()
  @UseGuards(UserThrottleGuard)
  @AdminRoles('SUPER_ADMIN')
  @ApiOperation({
    summary: 'Cancel unshipped order (SLA fallback)',
    description:
      'Wave 3 P0: pemicu manual untuk SATU order yang melewati batas kirim tanpa pengiriman — ' +
      'cancel + auto-refund penuh ke wallet buyer. Guard sama seperti sweep otomatis ' +
      '(PROCESSING + belum dikirim + lewat batas kirim + tanpa dispute berjalan); ' +
      'order yang belum due / sudah dikirim / dalam dispute ditolak (fail closed). ' +
      'SEC-603: wajib password admin di body (re-auth server-side).',
  })
  @ApiResponse({ status: 200, description: 'Cancel-unshipped dieksekusi (lihat outcome).' })
  @ApiResponse({ status: 400, description: 'Order tidak memenuhi syarat cancel-unshipped.' })
  @ApiResponse({ status: 404, description: 'Order tidak ditemukan.' })
  cancelUnshipped(
    @Param('orderId', ParseIdPipe) orderId: string,
    @Body() dto: ForceActionWithReauthDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<{ orderId: string; status: string; outcome: string; detail?: string }> {
    return this.service.cancelUnshipped(orderId, admin.sub, dto, req.ip || 'unknown');
  }

  @Post(':orderId/force-complete')
  @Idempotency()
  @UseGuards(UserThrottleGuard)
  @AdminRoles('SUPER_ADMIN')
  @ApiOperation({ summary: 'Force complete order', description: 'Admin force-completes an order, releasing escrow to seller. AUT-013: password admin wajib di body (re-auth).' })
  @ApiResponse({ status: 200, description: 'Order force-completed.' })
  @ApiResponse({ status: 400, description: 'Invalid order status for completion.' })
  @ApiResponse({ status: 404, description: 'Order not found.' })
  forceComplete(
    @Param('orderId', ParseIdPipe) orderId: string,
    @Body() dto: ForceActionWithReauthDto,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<{ orderId: string; status: string }> {
    return this.service.forceComplete(orderId, adminId, dto, req.ip || 'unknown');
  }
}
