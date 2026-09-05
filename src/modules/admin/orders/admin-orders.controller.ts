import { AdminRoute } from '../../../common/decorators/public.decorator';
import { Controller, Get, Post, Param, Body, Query, UseGuards, Req } from '@nestjs/common';
import { ParseIdPipe } from '../../../common/pipes/parse-id.pipe';
import { Request } from 'express';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AdminOrdersService } from './admin-orders.service';
import { PaginatedResponse } from '../../../common/dto/pagination.dto';
import { AdminOrderQueryDto, ForceActionDto } from './dto/admin-order-query.dto';
import { JwtAdminGuard } from '../../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../../common/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../../../common/decorators/current-admin.decorator';
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
  listOrders(@Query() query: AdminOrderQueryDto): Promise<PaginatedResponse<Record<string, unknown>>> {
    return this.service.listOrders(query);
  }

  @Get(':orderId')
  @ApiOperation({ summary: 'Get order detail', description: 'Returns full order detail including participants, wallet transactions, and status history.' })
  @ApiResponse({ status: 200, description: 'Order detail returned.' })
  @ApiResponse({ status: 404, description: 'Order not found.' })
  getOrderDetail(@Param('orderId', ParseIdPipe) orderId: string): Promise<Record<string, unknown>> {
    return this.service.getOrderDetail(orderId);
  }

  @Post(':orderId/force-cancel')
  @Idempotency()
  @UseGuards(UserThrottleGuard)
  @AdminRoles('SUPER_ADMIN', 'DISPUTE_ADMIN')
  @ApiOperation({ summary: 'Force cancel order', description: 'Admin force-cancels an order with optional escrow refund.' })
  @ApiResponse({ status: 200, description: 'Order force-cancelled.' })
  @ApiResponse({ status: 400, description: 'Invalid order status for cancellation.' })
  @ApiResponse({ status: 404, description: 'Order not found.' })
  forceCancel(
    @Param('orderId', ParseIdPipe) orderId: string,
    @Body() dto: ForceActionDto,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<{ orderId: string; status: string }> {
    return this.service.forceCancel(orderId, adminId, dto, req.ip || 'unknown');
  }

  @Post(':orderId/force-complete')
  @Idempotency()
  @UseGuards(UserThrottleGuard)
  @AdminRoles('SUPER_ADMIN')
  @ApiOperation({ summary: 'Force complete order', description: 'Admin force-completes an order, releasing escrow to seller.' })
  @ApiResponse({ status: 200, description: 'Order force-completed.' })
  @ApiResponse({ status: 400, description: 'Invalid order status for completion.' })
  @ApiResponse({ status: 404, description: 'Order not found.' })
  forceComplete(
    @Param('orderId', ParseIdPipe) orderId: string,
    @Body() dto: ForceActionDto,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<{ orderId: string; status: string }> {
    return this.service.forceComplete(orderId, adminId, dto, req.ip || 'unknown');
  }
}
