import { AdminRoute } from '../../../common/decorators/public.decorator';
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ActionLocationType } from '@prisma/client';
import { JwtAdminGuard } from '../../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../../common/decorators/admin-roles.decorator';
import { AdminActionLocationsService } from './admin-action-locations.service';

class ActionLocationsQueryDto {
  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsEnum(ActionLocationType)
  actionType?: ActionLocationType;

  @IsOptional()
  @IsString()
  referenceType?: string;

  @IsOptional()
  @IsString()
  referenceId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  take?: number;
}

@ApiTags('admin-action-locations')
@ApiBearerAuth('access-token')
@UseGuards(JwtAdminGuard, AdminRolesGuard)
// ADM-421: lokasi aksi adalah data keamanan/fraud yang sensitif — SUPER_ADMIN-only.
// Tidak ada konsumen UI untuk DISPUTE_ADMIN (satu-satunya pemanggil UI adalah
// halaman detail user yang section lokasinya pun hanya tampil untuk SUPER_ADMIN).
@AdminRoles('SUPER_ADMIN')
@AdminRoute()
@Controller('admin/action-locations')
export class AdminActionLocationsController {
  constructor(private readonly service: AdminActionLocationsService) {}

  @Get()
  @ApiOperation({ summary: 'List action location logs', description: 'Read lokasi presisi yang dicatat saat aksi sensitif (order, wallet, dispute, hapus akun). Filter opsional; default 50 baris terbaru, maks 200.' })
  @ApiQuery({ name: 'userId', required: false })
  @ApiQuery({ name: 'actionType', required: false, enum: ActionLocationType })
  @ApiQuery({ name: 'referenceType', required: false })
  @ApiQuery({ name: 'referenceId', required: false })
  @ApiQuery({ name: 'take', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Action location logs returned.' })
  @ApiResponse({ status: 401, description: 'Invalid or expired admin token.' })
  @ApiResponse({ status: 403, description: 'Insufficient admin role.' })
  list(@Query() query: ActionLocationsQueryDto): Promise<{ data: object[]; total: number }> {
    return this.service.list(query);
  }
}
