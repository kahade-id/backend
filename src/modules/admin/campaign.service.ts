import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { AuditAction, CampaignType, CampaignStatus, Prisma, Campaign } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogService } from '../../common/services/audit-log.service';
import { generateCampaignId } from '../../common/utils/id-generator.util';
import * as ErrorCodes from '../../common/constants/error-codes';
import { safeBigIntToNumber } from '../../common/utils/bigint.util';

const MAX_CAMPAIGN_ID_RETRIES = 3;

@Injectable()
export class CampaignService {
  private readonly logger = new Logger(CampaignService.name);

  constructor(
    private prisma: PrismaService,
    private auditLog: AuditLogService,
  ) {}

  async createCampaign(adminId: string, dto: {
    name: string;
    description?: string;
    type: CampaignType;
    startsAt: Date;
    endsAt: Date;
    discountValue?: number;
    discountPercent?: number;
    maxDiscount?: number;
    freeTransactions?: number;
    targetAudience?: string;
    maxRedemptions?: number;
  }, ipAddress: string = 'unknown'): Promise<object> {
    const normalizedName = dto.name.trim();
    if (normalizedName.length < 3 || normalizedName.length > 100 || /[<>]/.test(normalizedName)) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Campaign name must be 3–100 safe characters' });
    }
    if (dto.description !== undefined && (dto.description.trim().length > 1000 || /[<>]/.test(dto.description))) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Campaign description is invalid' });
    }
    if (dto.targetAudience !== undefined && (dto.targetAudience.trim().length > 500 || /[<>]/.test(dto.targetAudience))) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Campaign target audience is invalid' });
    }
    if (!(dto.startsAt instanceof Date) || !(dto.endsAt instanceof Date) || Number.isNaN(dto.startsAt.getTime()) || Number.isNaN(dto.endsAt.getTime()) || dto.endsAt <= dto.startsAt) {
      throw new BadRequestException({ code: ErrorCodes.INVALID_CAMPAIGN_DATES, message: 'End date must be after start date' });
    }

    let campaign: Campaign | null = null;
    for (let attempt = 0; attempt < MAX_CAMPAIGN_ID_RETRIES; attempt++) {
      const count = await this.prisma.campaign.count();
      const campaignId = generateCampaignId(count + 1 + attempt);
      try {
        campaign = await this.prisma.campaign.create({
          data: {
            campaignId,
            name: normalizedName,
            description: dto.description?.trim(),
            type: dto.type,
            startsAt: dto.startsAt,
            endsAt: dto.endsAt,
            discountValue: dto.discountValue ? BigInt(dto.discountValue * 100) : null,
            discountPercent: dto.discountPercent,
            maxDiscount: dto.maxDiscount ? BigInt(dto.maxDiscount * 100) : null,
            freeTransactions: dto.freeTransactions,
            targetAudience: dto.targetAudience?.trim(),
            maxRedemptions: dto.maxRedemptions,
            createdBy: adminId,
          },
        });
        break;
      } catch (err: unknown) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002' && attempt < MAX_CAMPAIGN_ID_RETRIES - 1) {
          this.logger.warn(`Campaign ID collision on attempt ${attempt + 1}, retrying...`);
          continue;
        }
        throw err;
      }
    }
    if (!campaign) {
      throw new BadRequestException({ code: ErrorCodes.INVALID_CAMPAIGN_DATES, message: 'Failed to generate unique campaign ID' });
    }

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'Campaign',
      targetId: campaign.campaignId,
      description: `Created campaign "${campaign.name}" (${campaign.campaignId})`,
      after: { name: campaign.name, type: campaign.type, startsAt: campaign.startsAt, endsAt: campaign.endsAt },
      ipAddress,
    });

    return this.formatCampaign(campaign);
  }

  async getCampaigns(page: number, limit: number, status?: string): Promise<object> {
    const safePage = Math.max(1, Math.floor(page));
    const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 50);
    const skip = (safePage - 1) * safeLimit;
    const where: Prisma.CampaignWhereInput = {};

    if (status) where.status = status as CampaignStatus;

    const [campaigns, total] = await Promise.all([
      this.prisma.campaign.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: safeLimit,
      }),
      this.prisma.campaign.count({ where }),
    ]);

    const totalPages = Math.ceil(total / safeLimit);
    return {
      data: campaigns.map(c => this.formatCampaign(c)),
      total,
      page: safePage,
      limit: safeLimit,
      totalPages,
      hasNext: safePage < totalPages,
      hasPrev: safePage > 1,
    };
  }

  async getCampaign(campaignId: string): Promise<object> {
    const campaign = await this.prisma.campaign.findUnique({ where: { campaignId } });
    if (!campaign) throw new NotFoundException({ code: ErrorCodes.CAMPAIGN_NOT_FOUND, message: 'Campaign not found' });
    return this.formatCampaign(campaign);
  }

  async updateCampaign(campaignId: string, adminId: string, dto: {
    name?: string;
    description?: string;
    startsAt?: Date;
    endsAt?: Date;
    maxRedemptions?: number;
    status?: CampaignStatus;
    rolloutPercent?: number;
  }, ipAddress: string = 'unknown'): Promise<object> {
    const campaign = await this.prisma.campaign.findUnique({ where: { campaignId } });
    if (!campaign) throw new NotFoundException({ code: ErrorCodes.CAMPAIGN_NOT_FOUND, message: 'Campaign not found' });
    if (dto.name !== undefined && (dto.name.trim().length < 3 || dto.name.trim().length > 100 || /[<>]/.test(dto.name))) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Campaign name must be 3–100 safe characters' });
    }
    if (dto.description !== undefined && (dto.description.trim().length > 1000 || /[<>]/.test(dto.description))) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Campaign description is invalid' });
    }

    const nextStartsAt = dto.startsAt ?? campaign.startsAt;
    const nextEndsAt = dto.endsAt ?? campaign.endsAt;
    if (nextEndsAt <= nextStartsAt) {
      throw new BadRequestException({ code: ErrorCodes.INVALID_CAMPAIGN_DATES, message: 'End date must be after start date' });
    }
    if (dto.maxRedemptions !== undefined && dto.maxRedemptions < campaign.currentRedemptions) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'maxRedemptions cannot be lower than current redemptions' });
    }
    if (dto.rolloutPercent !== undefined) {
      if (!Number.isInteger(dto.rolloutPercent) || dto.rolloutPercent < 0 || dto.rolloutPercent > 100) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'rolloutPercent must be between 0 and 100' });
      }
      const currentRollout = campaign.rolloutPercent;
      if (currentRollout !== null && currentRollout !== undefined && dto.rolloutPercent < currentRollout) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'rolloutPercent cannot be decreased once set' });
      }
    }

    const data: Prisma.CampaignUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.description !== undefined) data.description = dto.description.trim();
    if (dto.startsAt) data.startsAt = dto.startsAt;
    if (dto.endsAt) data.endsAt = dto.endsAt;
    if (dto.maxRedemptions !== undefined) data.maxRedemptions = dto.maxRedemptions;
    if (dto.status) data.status = dto.status;
    if (dto.rolloutPercent !== undefined) data.rolloutPercent = dto.rolloutPercent;

    if (Object.keys(data).length === 0) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'At least one campaign field must be changed' });
    }
    const updated = await this.prisma.campaign.update({ where: { campaignId }, data });

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'Campaign',
      targetId: campaignId,
      description: `Updated campaign "${updated.name}" (${campaignId})`,
      before: { name: campaign.name, status: campaign.status },
      after: { ...data },
      ipAddress,
    });

    return this.formatCampaign(updated);
  }

  async deleteCampaign(campaignId: string, adminId: string, ipAddress: string = 'unknown'): Promise<{ message: string }> {
    const campaign = await this.prisma.campaign.findUnique({ where: { campaignId } });
    if (!campaign) throw new NotFoundException({ code: ErrorCodes.CAMPAIGN_NOT_FOUND, message: 'Campaign not found' });
    if (campaign.status === 'ACTIVE') throw new BadRequestException({ code: ErrorCodes.CAMPAIGN_ACTIVE, message: 'Cannot delete an active campaign' });

    await this.prisma.campaign.delete({ where: { campaignId } });

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'Campaign',
      targetId: campaignId,
      description: `Deleted campaign "${campaign.name}" (${campaignId})`,
      ipAddress,
    });

    return { message: 'Campaign deleted' };
  }

  private formatCampaign(c: Campaign): object {
    return {
      id: c.id,
      campaignId: c.campaignId,
      name: c.name,
      description: c.description,
      type: c.type,
      status: c.status,
      startsAt: c.startsAt,
      endsAt: c.endsAt,
      discountValue: c.discountValue ? safeBigIntToNumber(c.discountValue) / 100 : null,
      discountPercent: c.discountPercent ? Number(c.discountPercent) : null,
      maxDiscount: c.maxDiscount ? safeBigIntToNumber(c.maxDiscount) / 100 : null,
      freeTransactions: c.freeTransactions,
      targetAudience: c.targetAudience,
      maxRedemptions: c.maxRedemptions,
      currentRedemptions: c.currentRedemptions,
      rolloutPercent: c.rolloutPercent,
      createdBy: c.createdBy,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  }
}
