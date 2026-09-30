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
import { AdminRoute } from '../../../common/decorators/public.decorator';
import { ParseIdPipe } from '../../../common/pipes/parse-id.pipe';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AdminFeedbackService } from './admin-feedback.service';
import { JwtAdminGuard } from '../../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../../common/decorators/admin-roles.decorator';
import { AdminRole } from '@prisma/client';
import { CurrentAdmin } from '../../../common/decorators/current-admin.decorator';
import { AdminJwtPayload } from '../../../common/types/jwt-payload.types';
import {
  AdminFeedbackAssignDto,
  AdminFeedbackCloseDto,
  AdminFeedbackEscalateDto,
  AdminFeedbackExportDto,
  AdminFeedbackNoteDto,
  AdminFeedbackQueryDto,
  AdminFeedbackReplyDto,
  AdminFeedbackSlaRuleDto,
  AdminFeedbackStatusDto,
  AdminFeedbackTagsDto,
  UpdateAdminFeedbackSlaRuleDto,
} from './dto/admin-feedback.dto';

@ApiTags('admin-feedback')
@ApiBearerAuth('access-token')
@UseGuards(JwtAdminGuard, AdminRolesGuard)
@AdminRoles(AdminRole.SUPER_ADMIN, AdminRole.CUSTOMER_SUPPORT)
@AdminRoute()
@Controller('admin/feedback')
export class AdminFeedbackController {
  constructor(private readonly service: AdminFeedbackService) {}

  // NOTE: rute statis dideklarasikan SEBELUM ':id' agar tidak tertelan param.

  @Get('export')
  @ApiOperation({ summary: 'Ekspor agregat feedback (tanpa kontak/isi)' })
  export(@Query() query: AdminFeedbackExportDto): Promise<object> {
    return this.service.exportAggregates(query.format ?? 'json');
  }

  @Get('summary')
  @ApiOperation({ summary: 'Ringkasan volume, rating, distribusi & tren 30 hari' })
  summary(): Promise<object> {
    return this.service.getSummary();
  }

  @Get('sla-rules')
  @ApiOperation({ summary: 'Daftar aturan SLA per kategori' })
  listSlaRules(): Promise<object> {
    return this.service.listSlaRules();
  }

  @Post('sla-rules')
  @AdminRoles(AdminRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Buat/ubah aturan SLA (SUPER_ADMIN)' })
  createSlaRule(
    @Body() dto: AdminFeedbackSlaRuleDto,
    @CurrentAdmin() admin: AdminJwtPayload,
  ): Promise<object> {
    return this.service.createSlaRule(admin.sub, dto);
  }

  @Patch('sla-rules/:ruleId')
  @AdminRoles(AdminRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Ubah aturan SLA (SUPER_ADMIN)' })
  updateSlaRule(
    @Param('ruleId', ParseIdPipe) ruleId: string,
    @Body() dto: UpdateAdminFeedbackSlaRuleDto,
    @CurrentAdmin() admin: AdminJwtPayload,
  ): Promise<object> {
    return this.service.updateSlaRule(admin.sub, ruleId, dto);
  }

  @Delete('sla-rules/:ruleId')
  @AdminRoles(AdminRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Hapus aturan SLA (SUPER_ADMIN)' })
  deleteSlaRule(
    @Param('ruleId', ParseIdPipe) ruleId: string,
    @CurrentAdmin() admin: AdminJwtPayload,
  ): Promise<object> {
    return this.service.deleteSlaRule(admin.sub, ruleId);
  }

  @Get()
  @ApiOperation({ summary: 'Antrean feedback — pagination cursor, tanpa kolom kontak' })
  @ApiResponse({ status: 200, description: 'Antrean feedback.' })
  queue(@Query() query: AdminFeedbackQueryDto): Promise<object> {
    return this.service.listQueue(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detail feedback — kontak di-masking berbasis role' })
  @ApiResponse({ status: 404, description: 'Feedback tidak ditemukan.' })
  detail(
    @Param('id', ParseIdPipe) id: string,
    @CurrentAdmin() admin: AdminJwtPayload,
  ): Promise<object> {
    return this.service.getDetail(id, admin.role);
  }

  @Get(':id/duplicates')
  @ApiOperation({ summary: 'Deteksi kemiripan feedback (skor triase)' })
  duplicates(@Param('id', ParseIdPipe) id: string): Promise<object> {
    return this.service.findDuplicates(id);
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Ubah status dengan validasi transisi' })
  updateStatus(
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: AdminFeedbackStatusDto,
    @CurrentAdmin() admin: AdminJwtPayload,
  ): Promise<object> {
    return this.service.updateStatus(id, admin.sub, dto);
  }

  @Post(':id/close')
  @ApiOperation({ summary: 'Tutup feedback — reason code wajib' })
  close(
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: AdminFeedbackCloseDto,
    @CurrentAdmin() admin: AdminJwtPayload,
  ): Promise<object> {
    return this.service.close(id, admin.sub, dto);
  }

  @Post(':id/assign')
  @ApiOperation({ summary: 'Tugaskan feedback ke admin' })
  assign(
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: AdminFeedbackAssignDto,
    @CurrentAdmin() admin: AdminJwtPayload,
  ): Promise<object> {
    return this.service.assign(id, admin.sub, dto);
  }

  @Post(':id/unassign')
  @ApiOperation({ summary: 'Lepas penugasan feedback' })
  unassign(
    @Param('id', ParseIdPipe) id: string,
    @CurrentAdmin() admin: AdminJwtPayload,
  ): Promise<object> {
    return this.service.unassign(id, admin.sub);
  }

  @Post(':id/notes')
  @ApiOperation({ summary: 'Tambah catatan internal (tidak dikirim ke user)' })
  addNote(
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: AdminFeedbackNoteDto,
    @CurrentAdmin() admin: AdminJwtPayload,
  ): Promise<object> {
    return this.service.addNote(id, admin.sub, dto.note);
  }

  @Post(':id/tags')
  @ApiOperation({ summary: 'Set tag tema + label dampak' })
  setTags(
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: AdminFeedbackTagsDto,
    @CurrentAdmin() admin: AdminJwtPayload,
  ): Promise<object> {
    return this.service.setTags(id, admin.sub, dto);
  }

  @Post(':id/contact')
  @ApiOperation({ summary: 'Catat outreach ke pengirim (perlu contactConsent)' })
  contact(
    @Param('id', ParseIdPipe) id: string,
    @CurrentAdmin() admin: AdminJwtPayload,
  ): Promise<object> {
    return this.service.contactSender(id, admin.sub, admin.role);
  }

  @Post(':id/reply')
  @ApiOperation({ summary: 'Balas feedback ke akun Kahade (+ notifikasi bila consent)' })
  reply(
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: AdminFeedbackReplyDto,
    @CurrentAdmin() admin: AdminJwtPayload,
  ): Promise<object> {
    return this.service.reply(id, admin.sub, dto);
  }

  @Post(':id/escalate')
  @ApiOperation({ summary: 'Eskalasi risiko (SECURITY_RISK / FRAUD_RISK)' })
  escalate(
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: AdminFeedbackEscalateDto,
    @CurrentAdmin() admin: AdminJwtPayload,
  ): Promise<object> {
    return this.service.escalate(id, admin.sub, dto);
  }
}
