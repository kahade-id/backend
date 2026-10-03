import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JobApplicationStatus } from '@prisma/client';
import { AdminRoute } from '../../common/decorators/public.decorator';
import { JwtAdminGuard } from '../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../common/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../../common/decorators/current-admin.decorator';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { CareersService } from './careers.service';
import { CreateJobPostingDto } from './dto/create-job-posting.dto';
import { UpdateJobPostingDto } from './dto/update-job-posting.dto';
import { UpdateApplicationStatusDto } from './dto/update-application-status.dto';

/**
 * Endpoint admin karir — HANYA SUPER_ADMIN (rekrutmen = keputusan founder).
 * Base path: /v1/admin/careers.
 */
@ApiTags('admin-careers')
@ApiBearerAuth('access-token')
@UseGuards(JwtAdminGuard, AdminRolesGuard)
@AdminRoles('SUPER_ADMIN')
@AdminRoute()
@Controller('admin/careers')
export class AdminCareersController {
  constructor(private readonly careersService: CareersService) {}

  // ── Lowongan ───────────────────────────────────────────────────────────

  @Get('postings')
  @ApiOperation({ summary: 'Daftar semua lowongan + jumlah pelamar' })
  listPostings(@Query() pagination: PaginationDto, @Query('active') active?: string) {
    return this.careersService.listPostingsAdmin({
      page: pagination.page ?? 1,
      limit: pagination.limit ?? 20,
      active: active === undefined ? undefined : active === 'true',
    });
  }

  @Post('postings')
  @ApiOperation({ summary: 'Buat lowongan baru (slug otomatis dari judul bila kosong)' })
  createPosting(@Body() dto: CreateJobPostingDto, @CurrentAdmin('sub') adminId: string) {
    return this.careersService.createPosting(dto, adminId);
  }

  @Patch('postings/:id')
  @ApiOperation({ summary: 'Ubah lowongan (termasuk toggle isActive tutup/buka)' })
  updatePosting(@Param('id') id: string, @Body() dto: UpdateJobPostingDto) {
    return this.careersService.updatePosting(id, dto);
  }

  @Delete('postings/:id')
  @ApiOperation({ summary: 'Hapus lowongan — 409 bila masih ada lamaran' })
  deletePosting(@Param('id') id: string) {
    return this.careersService.deletePosting(id);
  }

  // ── Lamaran ────────────────────────────────────────────────────────────

  @Get('applications')
  @ApiOperation({ summary: 'Daftar lamaran (filter postingId/status/q, PII penuh — admin only)' })
  listApplications(
    @Query() pagination: PaginationDto,
    @Query('postingId') postingId?: string,
    @Query('status') status?: JobApplicationStatus,
    @Query('q') q?: string,
  ) {
    return this.careersService.listApplicationsAdmin({
      page: pagination.page ?? 1,
      limit: pagination.limit ?? 20,
      postingId,
      status,
      q,
    });
  }

  @Get('applications/:id')
  @ApiOperation({ summary: 'Detail lamaran + cvDownloadUrl (signed URL 15 menit) + riwayat status' })
  getApplication(@Param('id') id: string) {
    return this.careersService.getApplicationAdmin(id);
  }

  @Patch('applications/:id/status')
  @ApiOperation({ summary: 'Ubah status lamaran (validasi transisi + audit trail + email pelamar)' })
  updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateApplicationStatusDto,
    @CurrentAdmin('sub') adminId: string,
  ) {
    return this.careersService.updateApplicationStatus(id, dto, adminId);
  }

  @Delete('applications/:id')
  @ApiOperation({ summary: 'Hapus lamaran manual (UU PDP) — hard delete + hapus file CV' })
  deleteApplication(@Param('id') id: string) {
    return this.careersService.deleteApplicationAdmin(id);
  }
}
