import { AdminRoute } from '../../../common/decorators/public.decorator';
import { Controller, Get, Post, Patch, Param, Body, Query, UseGuards, Req } from '@nestjs/common';
import { ParseIdPipe } from '../../../common/pipes/parse-id.pipe';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AdminSupportService } from './admin-support.service';
import { JwtAdminGuard } from '../../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../../common/decorators/admin-roles.decorator';
import { AdminRole } from '@prisma/client';
import { CurrentAdmin } from '../../../common/decorators/current-admin.decorator';
import { AdminJwtPayload } from '../../../common/types/jwt-payload.types';
import { AdminTicketQueryDto, AdminTicketReplyDto, AdminTicketStatusDto } from './dto/admin-support.dto';
import { Request } from 'express';
import { UserThrottleGuard } from '../../../common/guards/user-throttle.guard';

@ApiTags('admin-support')
@ApiBearerAuth('access-token')
@UseGuards(JwtAdminGuard, AdminRolesGuard)
@AdminRoles(AdminRole.SUPER_ADMIN, AdminRole.CUSTOMER_SUPPORT)
@AdminRoute()
@Controller('admin/support/tickets')
export class AdminSupportController {
  constructor(private readonly service: AdminSupportService) {}

  @Get()
  @ApiOperation({ summary: 'List support tickets / feedback', description: 'Paginated list of all support tickets with optional status & category filters.' })
  @ApiResponse({ status: 200, description: 'Tickets list returned.' })
  listTickets(@Query() query: AdminTicketQueryDto): Promise<object> {
    return this.service.listTickets(
      query.page ?? 1,
      query.limit ?? 20,
      query.status,
      query.category,
      query.search,
    );
  }

  @Get(':ticketId')
  @ApiOperation({ summary: 'Get ticket detail with replies' })
  @ApiResponse({ status: 200, description: 'Ticket detail returned.' })
  @ApiResponse({ status: 404, description: 'Ticket not found.' })
  getDetail(@Param('ticketId', ParseIdPipe) ticketId: string): Promise<object> {
    return this.service.getTicketDetail(ticketId);
  }

  @UseGuards(UserThrottleGuard)
  @Post(':ticketId/reply')
  @ApiOperation({ summary: 'Reply to a ticket as admin' })
  @ApiResponse({ status: 201, description: 'Reply added.' })
  @ApiResponse({ status: 404, description: 'Ticket not found.' })
  @ApiResponse({ status: 400, description: 'Ticket already closed.' })
  reply(
    @Param('ticketId', ParseIdPipe) ticketId: string,
    @Body() dto: AdminTicketReplyDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.replyToTicket(ticketId, admin.sub, dto.message, req.ip ?? '');
  }

  @UseGuards(UserThrottleGuard)
  @Patch(':ticketId/status')
  @ApiOperation({ summary: 'Update ticket status' })
  @ApiResponse({ status: 200, description: 'Ticket status updated.' })
  @ApiResponse({ status: 404, description: 'Ticket not found.' })
  updateStatus(
    @Param('ticketId', ParseIdPipe) ticketId: string,
    @Body() dto: AdminTicketStatusDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.updateStatus(ticketId, dto.status, admin.sub, req.ip ?? '');
  }
}
