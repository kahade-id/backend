// GAP-C (G196–G199): endpoint admin untuk milestone.
// RBAC: SUPER_ADMIN + FINANCE_ADMIN.
import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAdminGuard } from '../../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../../common/decorators/admin-roles.decorator';
import { AdminRoute } from '../../../common/decorators/public.decorator';
import { AdminMilestonesService } from './admin-milestones.service';
import { MilestoneStatus } from '@prisma/client';

@ApiTags('admin-milestones')
@ApiBearerAuth('access-token')
@UseGuards(JwtAdminGuard, AdminRolesGuard)
@AdminRoles('SUPER_ADMIN', 'FINANCE_ADMIN')
@AdminRoute()
@Controller('admin/milestones')
export class AdminMilestonesController {
  constructor(private readonly service: AdminMilestonesService) {}

  @Get()
  list(
    @Query('status') status?: MilestoneStatus,
    @Query('orderId') orderId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.listMilestones({
      status,
      orderId,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('escrow-summary')
  escrowSummary() {
    return this.service.escrowSummary();
  }

  @Get('reconcile/recent')
  reconcileRecent(@Query('limit') limit?: string) {
    return this.service.reconcileRecent(limit ? Number(limit) : undefined);
  }

  @Get('reconcile/:orderDbId')
  reconcileOrder(@Param('orderDbId') orderDbId: string) {
    return this.service.reconcileOrder(orderDbId);
  }
}
