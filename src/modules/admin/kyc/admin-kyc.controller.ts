import { AdminRoute } from '../../../common/decorators/public.decorator';
import { Controller, Get, Post, Param, Body, Query, UseGuards, Req } from '@nestjs/common';
import { ParseIdPipe } from '../../../common/pipes/parse-id.pipe';
import { Request } from 'express';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AdminKycService } from './admin-kyc.service';
import { KycQueueQueryDto } from './dto/kyc-queue-query.dto';
import { ReviewKycDto } from './dto/review-kyc.dto';
import { RejectKycDto } from './dto/reject-kyc.dto';
import { RevokeKycDto } from './dto/revoke-kyc.dto';
import { GetDocumentUrlsDto } from './dto/get-document-urls.dto';
import { JwtAdminGuard } from '../../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../../common/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../../../common/decorators/current-admin.decorator';
import { AdminJwtPayload } from '../../../common/types/jwt-payload.types';
import { UserThrottleGuard } from '../../../common/guards/user-throttle.guard';

@ApiTags('admin-kyc')
@ApiBearerAuth('access-token')
@UseGuards(JwtAdminGuard, AdminRolesGuard)
@AdminRoles('SUPER_ADMIN', 'KYC_ADMIN')
@AdminRoute()
@Controller('admin/kyc')
export class AdminKycController {
  constructor(private readonly service: AdminKycService) {}

  @Get()
  @ApiOperation({ summary: 'Get KYC queue', description: 'Paginated KYC request queue ordered FIFO, filterable by status.' })
  @ApiResponse({ status: 200, description: 'KYC queue returned.' })
  getQueue(@Query() query: KycQueueQueryDto): Promise<object> {
    return this.service.getKycQueue(query.page!, query.limit!, query.status);
  }

  @Get(':kycId')
  @ApiOperation({ summary: 'Get KYC detail', description: 'Returns full KYC request detail including submitted documents.' })
  @ApiResponse({ status: 200, description: 'KYC detail returned.' })
  @ApiResponse({ status: 404, description: 'KYC request not found.' })
  getDetail(
    @Param('kycId', ParseIdPipe) kycId: string,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<Record<string, unknown>> {
    return this.service.getKycDetail(kycId, admin.sub, req.ip || 'unknown');
  }

  @Post(':kycId/document-urls')
  @UseGuards(UserThrottleGuard)
  @ApiOperation({ summary: 'Get short-lived signed URLs for KYC documents', description: 'Decrypts stored document keys and returns 5-minute pre-signed S3 download URLs. Requires re-authentication with admin password. KYC_ADMIN and SUPER_ADMIN only.' })
  @ApiResponse({ status: 200, description: 'Signed URLs returned (expires in 300 s).' })
  @ApiResponse({ status: 401, description: 'Re-authentication failed.' })
  @ApiResponse({ status: 404, description: 'KYC request not found.' })
  getDocumentUrls(
    @Param('kycId', ParseIdPipe) kycId: string,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
    @Body() dto: GetDocumentUrlsDto,
  ): Promise<{ ktpUrl: string | null; selfieUrl: string | null; partialErrors?: string[] }> {
    return this.service.getDocumentUrls(kycId, admin.sub, req.ip || 'unknown', dto.password);
  }

  @Post(':kycId/approve')
  @UseGuards(UserThrottleGuard)
  @AdminRoles('SUPER_ADMIN', 'KYC_ADMIN')
  @ApiOperation({ summary: 'Approve KYC', description: 'Approves a pending KYC request and sets kycApprovedAt on the user. ADMIN and SUPER_ADMIN only.' })
  @ApiResponse({ status: 200, description: 'KYC approved — user kycStatus set to APPROVED and kycApprovedAt set.' })
  @ApiResponse({ status: 400, description: 'KYC is not in PENDING status.' })
  @ApiResponse({ status: 403, description: 'Insufficient admin role.' })
  @ApiResponse({ status: 404, description: 'KYC request not found.' })
  approve(
    @Param('kycId', ParseIdPipe) kycId: string,
    @Body() dto: ReviewKycDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<Record<string, unknown>> {
    return this.service.approveKyc(kycId, admin.sub, dto.notes, req.ip || 'unknown');
  }

  @Post(':kycId/reject')
  @UseGuards(UserThrottleGuard)
  @AdminRoles('SUPER_ADMIN', 'KYC_ADMIN')
  @ApiOperation({ summary: 'Reject KYC', description: 'Rejects a pending KYC request with a mandatory reason. ADMIN and SUPER_ADMIN only.' })
  @ApiResponse({ status: 200, description: 'KYC rejected.' })
  @ApiResponse({ status: 400, description: 'KYC is not in PENDING status.' })
  @ApiResponse({ status: 403, description: 'Insufficient admin role.' })
  @ApiResponse({ status: 404, description: 'KYC request not found.' })
  reject(
    @Param('kycId', ParseIdPipe) kycId: string,
    @Body() dto: RejectKycDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<Record<string, unknown>> {
    return this.service.rejectKyc(kycId, admin.sub, dto.reason, dto.notes, req.ip || 'unknown');
  }

  @Post(':kycId/revoke')
  @UseGuards(UserThrottleGuard)
  @AdminRoles('SUPER_ADMIN')
  @ApiOperation({ summary: 'Revoke KYC', description: 'Revokes a previously approved KYC. SUPER_ADMIN only.' })
  @ApiResponse({ status: 200, description: 'KYC revoked.' })
  @ApiResponse({ status: 400, description: 'KYC is not in APPROVED status.' })
  @ApiResponse({ status: 403, description: 'Insufficient admin role.' })
  @ApiResponse({ status: 404, description: 'KYC request not found.' })
  revoke(
    @Param('kycId', ParseIdPipe) kycId: string,
    @Body() dto: RevokeKycDto,
    @CurrentAdmin() admin: AdminJwtPayload,
    @Req() req: Request,
  ): Promise<Record<string, unknown>> {
    return this.service.revokeKyc(kycId, admin.sub, dto.reason, req.ip || 'unknown');
  }
}
