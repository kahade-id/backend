import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { AdminShowcaseReportsService } from '../admin/showcase-reports/admin-showcase-reports.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Idempotency } from '../../common/decorators/idempotency.decorator';
import { UserThrottleGuard } from '../../common/guards/user-throttle.guard';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe';
import { FileShowcaseAppealDto } from './dto/file-showcase-appeal.dto';

/**
 * G404/G405 — banding moderasi etalase oleh pemilik item (user-facing,
 * ter-autentikasi).
 *
 * - `POST /v1/showcase/:showcaseId/appeals` — ajukan banding atas takedown /
 *   pembatasan item. Alasan + bukti baru wajib. Satu banding PENDING per
 *   pemilik per laporan (duplikat → 409).
 * - `GET /v1/showcase/:showcaseId/appeals` — daftar banding milik sendiri
 *   untuk item ini (status + putusan).
 *
 * Catatan route: dideklarasikan di controller terpisah agar tidak bentrok
 * dengan `:showcaseId/report` di ShowcaseController; service logic terpusat
 * di AdminShowcaseReportsService (fileAppeal).
 */
@ApiTags('showcase-appeals')
@ApiBearerAuth('access-token')
@Controller('showcase')
export class ShowcaseAppealsController {
  constructor(private readonly moderation: AdminShowcaseReportsService) {}

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 3600000, limit: 5 } })
  @Post(':showcaseId/appeals')
  @Idempotency()
  @ApiOperation({
    summary: 'File an appeal against a moderation takedown/restriction',
    description:
      'G404 — pemilik item mengajukan banding atas takedown/pembatasan. ' +
      'Alasan (min. 20 karakter) + bukti baru WAJIB. Requires Idempotency-Key.',
  })
  @ApiResponse({ status: 201, description: 'Appeal filed.' })
  @ApiResponse({ status: 400, description: 'Nothing to appeal, or reason/evidence missing.' })
  @ApiResponse({ status: 404, description: 'Showcase item not found.' })
  @ApiResponse({ status: 409, description: 'A pending appeal already exists for this item.' })
  async fileAppeal(
    @CurrentUser('sub') userId: string,
    @Param('showcaseId', ParseIdPipe) showcaseId: string,
    @Body() dto: FileShowcaseAppealDto,
    @Req() req: Request,
  ): Promise<{ message: string; appealId: string; reportId: string }> {
    return this.moderation.fileAppeal(
      userId,
      showcaseId,
      { reason: dto.reason, newEvidence: dto.newEvidence },
      req.ip ?? '',
    );
  }

  @UseGuards(UserThrottleGuard)
  @Get(':showcaseId/appeals')
  @ApiOperation({
    summary: "List my appeals for a showcase item",
    description: 'Daftar banding milik sendiri atas item ini (status + putusan reviewer).',
  })
  @ApiResponse({ status: 200, description: 'Own appeals returned.' })
  async listMyAppeals(
    @CurrentUser('sub') userId: string,
    @Param('showcaseId', ParseIdPipe) showcaseId: string,
  ): Promise<object> {
    return this.moderation.listOwnAppeals(userId, showcaseId);
  }
}
