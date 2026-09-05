import { AdminRoute } from '../../../common/decorators/public.decorator';
import { Controller, Get, Post, Put, Delete, Param, Body, Query, UseGuards, Req, HttpCode, HttpStatus } from '@nestjs/common';
import { ParseIdPipe } from '../../../common/pipes/parse-id.pipe';
import { ParseQueryStringPipe } from '../../../common/pipes/parse-query-string.pipe';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { AdminManagementService } from './admin-management.service';
import { CreateAdminDto } from './dto/create-admin.dto';
import { UpdateAdminDto } from './dto/update-admin.dto';
import { JwtAdminGuard } from '../../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../../common/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../../../common/decorators/current-admin.decorator';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import { Request } from 'express';
import { UserThrottleGuard } from '../../../common/guards/user-throttle.guard';
import { Idempotency } from '../../../common/decorators/idempotency.decorator';

@ApiTags('admin-management')
@ApiBearerAuth('access-token')
@UseGuards(JwtAdminGuard, AdminRolesGuard)
@AdminRoles('SUPER_ADMIN')
@AdminRoute()
@Controller('admin/management')
export class AdminManagementController {
  constructor(private readonly service: AdminManagementService) {}

  @Get()
  @ApiOperation({ summary: 'List all admin users' })
  @ApiQuery({ name: 'search', required: false, description: 'Search by name, email, or adminId' })
  @ApiResponse({ status: 200, description: 'Admin list returned.' })
  listAdmins(
    @Query() pagination: PaginationDto,
    @Query('search', new ParseQueryStringPipe('search', 100)) search?: string,
  ): Promise<object> {
    return this.service.listAdmins(pagination.page!, pagination.limit!, search);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get admin detail' })
  @ApiResponse({ status: 200, description: 'Admin detail returned.' })
  @ApiResponse({ status: 404, description: 'Admin not found.' })
  getAdmin(@Param('id', ParseIdPipe) id: string): Promise<object> {
    return this.service.getAdmin(id);
  }

  @Post()
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @ApiOperation({ summary: 'Create a new admin user' })
  @ApiResponse({ status: 201, description: 'Admin created.' })
  @ApiResponse({ status: 409, description: 'Email already exists.' })
  createAdmin(
    @Body() dto: CreateAdminDto,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.createAdmin(dto, adminId, req.ip ?? '');
  }

  @Put(':id')
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @ApiOperation({ summary: 'Update admin user' })
  @ApiResponse({ status: 200, description: 'Admin updated.' })
  @ApiResponse({ status: 404, description: 'Admin not found.' })
  updateAdmin(
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: UpdateAdminDto,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<object> {
    return this.service.updateAdmin(id, dto, adminId, req.ip ?? '');
  }

  @Post(':id/reset-2fa')
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset admin 2FA' })
  @ApiResponse({ status: 200, description: '2FA reset successfully.' })
  @ApiResponse({ status: 404, description: 'Admin not found.' })
  resetAdmin2fa(
    @Param('id', ParseIdPipe) id: string,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    return this.service.resetAdmin2fa(id, adminId, req.ip ?? '');
  }

  @Post(':id/unlock')
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unlock locked admin account' })
  @ApiResponse({ status: 200, description: 'Admin unlocked.' })
  @ApiResponse({ status: 404, description: 'Admin not found.' })
  unlockAdmin(
    @Param('id', ParseIdPipe) id: string,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    return this.service.unlockAdmin(id, adminId, req.ip ?? '');
  }

  @Delete(':id')
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @ApiOperation({ summary: 'Soft-delete admin user' })
  @ApiResponse({ status: 200, description: 'Admin deleted.' })
  @ApiResponse({ status: 404, description: 'Admin not found.' })
  deleteAdmin(
    @Param('id', ParseIdPipe) id: string,
    @CurrentAdmin('sub') adminId: string,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    return this.service.deleteAdmin(id, adminId, req.ip ?? '');
  }
}
