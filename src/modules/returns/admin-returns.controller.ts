/**
 * GAP-D retur — endpoint admin. Prefix global /v1 → /v1/admin/returns.
 * Guard: JwtAdminGuard + AdminRolesGuard (pola admin-disputes).
 */
import { Controller, Get, Post, Body, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { ReturnsService } from './returns.service';
import { JwtAdminGuard } from '../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../common/decorators/admin-roles.decorator';
import { AdminRoute } from '../../common/decorators/public.decorator';
import { CurrentAdmin } from '../../common/decorators/current-admin.decorator';
import { Idempotency } from '../../common/decorators/idempotency.decorator';
import type { AdminJwtPayload } from '../../common/types/jwt-payload.types';
import { ReturnQueueQueryDto, AdminReturnActionDto } from './dto/returns.dto';

@ApiTags('admin-returns')
@ApiBearerAuth('access-token')
@UseGuards(JwtAdminGuard, AdminRolesGuard)
@AdminRoles('SUPER_ADMIN', 'DISPUTE_ADMIN', 'CUSTOMER_SUPPORT')
@AdminRoute()
@Controller('admin/returns')
export class AdminReturnsController {
  constructor(private returnsService: ReturnsService) {}

  @Get('queue')
  @ApiOperation({ summary: 'Antrean retur + filter umur kasus (G219)' })
  async queue(@Query() query: ReturnQueueQueryDto) {
    return this.returnsService.adminQueue(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detail retur untuk admin' })
  async detail(@Param('id') id: string, @CurrentAdmin() _admin: AdminJwtPayload) {
    return this.returnsService.getDetail(id, '', { isAdmin: true });
  }

  @Post(':id/action')
  @Idempotency()
  @ApiOperation({ summary: 'Aksi admin: approve / reject / escalate / force-resolve' })
  async act(
    @Param('id') id: string,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Body() dto: AdminReturnActionDto,
  ) {
    return this.returnsService.adminAct(id, admin.sub, dto);
  }

  @Post(':id/note')
  @Idempotency()
  @ApiOperation({ summary: 'Admin menambah catatan (terlihat dua pihak)' })
  async addNote(
    @Param('id') id: string,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Body() body: { message: string },
  ) {
    return this.returnsService.addNote(id, admin.sub, { message: body.message }, 'ADMIN');
  }
}
