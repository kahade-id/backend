import { Controller, Get, Post, Patch, Delete, Body, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { BannersService } from '../services/banners.service';
import { CreateBannerDto, UpdateBannerDto } from '../dto/commerce.dto';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import { JwtAdminGuard } from '../../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../../common/decorators/admin-roles.decorator';
import { AdminRoute } from '../../../common/decorators/public.decorator';
import { CurrentAdmin } from '../../../common/decorators/current-admin.decorator';
import { AdminRole } from '@prisma/client';

@ApiTags('admin-banners')
@ApiBearerAuth('access-token')
@UseGuards(JwtAdminGuard, AdminRolesGuard)
@AdminRoles(AdminRole.SUPER_ADMIN, AdminRole.CUSTOMER_SUPPORT)
@AdminRoute()
@Controller('admin/banners')
export class AdminBannersController {
  constructor(private readonly service: BannersService) {}

  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @Get()
  @ApiOperation({ summary: 'Daftar semua banner (admin)' })
  list(@Query() pagination: PaginationDto) {
    return this.service.listAdminBanners(pagination.page ?? 1, pagination.limit ?? 20);
  }

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Post()
  @ApiOperation({ summary: 'Buat banner promo (admin)' })
  create(@CurrentAdmin('adminId') adminId: string, @Body() dto: CreateBannerDto) {
    return this.service.createBanner(adminId ?? 'unknown', dto);
  }

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Patch(':id')
  @ApiOperation({ summary: 'Ubah banner (admin)' })
  update(@Param('id') id: string, @Body() dto: UpdateBannerDto) {
    return this.service.updateBanner(id, dto);
  }

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Delete(':id')
  @ApiOperation({ summary: 'Hapus banner (admin)' })
  remove(@Param('id') id: string) {
    return this.service.deleteBanner(id);
  }
}
