import { AdminRoute } from '../../../common/decorators/public.decorator';
import { Controller, Get, Post, Delete, Param, Body, Query, UseGuards, Req } from '@nestjs/common';
import { ParseIdPipe } from '../../../common/pipes/parse-id.pipe';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Request } from 'express';
import { AdminJwtPayload } from '../../../common/types/jwt-payload.types';
import { AdminUsersService } from './admin-users.service';
import { UserListQueryDto } from './dto/user-list-query.dto';
import { UserOrderQueryDto } from './dto/user-order-query.dto';
import { BanUserDto } from './dto/ban-user.dto';
import { JwtAdminGuard } from '../../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../../common/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../../../common/decorators/current-admin.decorator';
import { WalletAdjustDto } from './dto/wallet-adjust.dto';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import { Idempotency } from '../../../common/decorators/idempotency.decorator';
import { UserThrottleGuard } from '../../../common/guards/user-throttle.guard';

@ApiTags('admin-users')
@ApiBearerAuth('access-token')
@UseGuards(JwtAdminGuard, AdminRolesGuard)
@AdminRoles('SUPER_ADMIN', 'CUSTOMER_SUPPORT')
@AdminRoute()
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly service: AdminUsersService) {}

  @Get()
  @ApiOperation({ summary: 'List users', description: 'Paginated list of all users with optional search and status filter.' })
  @ApiResponse({ status: 200, description: 'User list returned.' })
  listUsers(@Query() query: UserListQueryDto): Promise<object> {
    return this.service.listUsers(query.page!, query.limit!, query.search, query.status, query.sortBy, query.sortOrder);
  }

  @Get(':userId')
  @ApiOperation({ summary: 'Get user detail', description: 'Returns full user detail including wallet and KYC history.' })
  @ApiResponse({ status: 200, description: 'User detail returned.' })
  @ApiResponse({ status: 404, description: 'User not found.' })
  getUserDetail(
    @Param('userId', ParseIdPipe) userId: string,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.getUserDetail(userId, admin.sub, req.ip || 'unknown');
  }

  @Get(':userId/orders')
  @ApiOperation({ summary: 'List user orders', description: 'Paginated list of orders for a specific user (as buyer or seller).' })
  @ApiResponse({ status: 200, description: 'User orders returned.' })
  @ApiResponse({ status: 404, description: 'User not found.' })
  getUserOrders(
    @Param('userId', ParseIdPipe) userId: string,
    @Query() query: UserOrderQueryDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.getUserOrders(userId, query.page!, query.limit!, query.status, admin.sub, req.ip || 'unknown');
  }

  @Get(':userId/wallet')
  @ApiOperation({ summary: 'Get user wallet', description: 'Returns wallet details and recent transactions for a specific user.' })
  @ApiResponse({ status: 200, description: 'User wallet returned.' })
  @ApiResponse({ status: 404, description: 'User not found.' })
  getUserWallet(
    @Param('userId', ParseIdPipe) userId: string,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.getUserWallet(userId, admin.sub, req.ip || 'unknown');
  }

  @Get(':userId/sessions')
  @ApiOperation({ summary: 'List user sessions', description: 'Returns active sessions for a specific user.' })
  @ApiResponse({ status: 200, description: 'User sessions returned.' })
  @ApiResponse({ status: 404, description: 'User not found.' })
  getUserSessions(
    @Param('userId', ParseIdPipe) userId: string,
    @Query() pagination: PaginationDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.getUserSessions(userId, pagination.page, pagination.limit, admin.sub, req.ip || 'unknown');
  }

  @Post(':userId/wallet/adjust')
  @UseGuards(UserThrottleGuard)
  @AdminRoles('SUPER_ADMIN')
  @Idempotency()
  @ApiOperation({ summary: 'Adjust user wallet', description: 'Manual wallet credit or debit. SUPER_ADMIN only.' })
  @ApiResponse({ status: 200, description: 'Wallet adjusted.' })
  @ApiResponse({ status: 403, description: 'Insufficient admin role.' })
  @ApiResponse({ status: 404, description: 'User or wallet not found.' })
  adjustWallet(
    @Param('userId', ParseIdPipe) userId: string,
    @Body() dto: WalletAdjustDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<{ txId: string; type: string; amount: number; reason: string; balanceAfter: number }> {
    return this.service.adjustWallet(userId, dto, admin.sub, req.ip || 'unknown');
  }

  @Get(':userId/audit-log')
  @ApiOperation({ summary: 'User audit log', description: 'Returns the activity audit trail for a specific user.' })
  @ApiResponse({ status: 200, description: 'User audit log returned.' })
  @ApiResponse({ status: 404, description: 'User not found.' })
  getUserAuditLog(
    @Param('userId', ParseIdPipe) userId: string,
    @Query() pagination: PaginationDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.getUserAuditLog(userId, pagination.page!, pagination.limit!, admin.sub, req.ip || 'unknown');
  }

  @Post(':userId/reset-password')
  @UseGuards(UserThrottleGuard)
  @AdminRoles('SUPER_ADMIN')
  @ApiOperation({ summary: 'Trigger password reset email for user', description: 'Generates a password reset OTP and emails it to the user.' })
  @ApiResponse({ status: 200, description: 'Password reset email sent.' })
  @ApiResponse({ status: 404, description: 'User not found.' })
  resetUserPassword(
    @Param('userId', ParseIdPipe) userId: string,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    return this.service.resetUserPassword(userId, admin.sub, req.ip || 'unknown');
  }

  @Post(':userId/force-logout')
  @UseGuards(UserThrottleGuard)
  @AdminRoles('SUPER_ADMIN')
  @ApiOperation({ summary: 'Force logout user', description: 'Revokes all active sessions for a user, forcing logout.' })
  @ApiResponse({ status: 200, description: 'User sessions revoked.' })
  @ApiResponse({ status: 404, description: 'User not found.' })
  forceLogout(@Param('userId', ParseIdPipe) userId: string, @CurrentAdmin() admin: AdminJwtPayload, @Req() req: Request): Promise<{ message: string; revokedCount: number }> {
    return this.service.forceLogout(userId, admin.sub, req.ip || 'unknown');
  }

  @Delete(':userId/sessions/:sessionId')
  @UseGuards(UserThrottleGuard)
  @AdminRoles('SUPER_ADMIN', 'CUSTOMER_SUPPORT')
  @ApiOperation({ summary: 'Revoke a specific user session', description: 'Revokes one session by ID without affecting other active sessions.' })
  @ApiResponse({ status: 200, description: 'Session revoked.' })
  @ApiResponse({ status: 404, description: 'User or session not found.' })
  revokeUserSession(
    @Param('userId', ParseIdPipe) userId: string,
    @Param('sessionId', ParseIdPipe) sessionId: string,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    return this.service.revokeUserSession(userId, sessionId, admin.sub, req.ip || 'unknown');
  }

  @Post(':userId/ban')
  @UseGuards(UserThrottleGuard)
  @AdminRoles('SUPER_ADMIN')
  @ApiOperation({ summary: 'Ban user', description: 'Bans a user with a required reason. ADMIN and SUPER_ADMIN only.' })
  @ApiResponse({ status: 200, description: 'User banned.' })
  @ApiResponse({ status: 403, description: 'Insufficient admin role or user already banned.' })
  @ApiResponse({ status: 404, description: 'User not found.' })
  banUser(
    @Param('userId', ParseIdPipe) userId: string,
    @Body() dto: BanUserDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.banUser(userId, dto.reason, admin.sub, req.ip || 'unknown');
  }

  @Post(':userId/unban')
  @UseGuards(UserThrottleGuard)
  @AdminRoles('SUPER_ADMIN')
  @ApiOperation({ summary: 'Unban user', description: 'Removes a ban from a user. ADMIN and SUPER_ADMIN only.' })
  @ApiResponse({ status: 200, description: 'User unbanned.' })
  @ApiResponse({ status: 403, description: 'Insufficient admin role.' })
  @ApiResponse({ status: 404, description: 'User not found.' })
  unbanUser(@Param('userId', ParseIdPipe) userId: string, @CurrentAdmin() admin: AdminJwtPayload, @Req() req: Request): Promise<object> {
    return this.service.unbanUser(userId, admin.sub, req.ip || 'unknown');
  }
}
