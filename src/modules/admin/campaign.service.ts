import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { AuditAction, CampaignType, CampaignStatus, Prisma, Campaign, MembershipRank, VoucherType, VoucherApplicability, NotificationType } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogService } from '../../common/services/audit-log.service';
import { generateCampaignId } from '../../common/utils/id-generator.util';
import * as ErrorCodes from '../../common/constants/error-codes';
import { safeBigIntToNumber } from '../../common/utils/bigint.util';
import { NotificationQueueService } from '../queue/notification-queue.service';

const MAX_CAMPAIGN_ID_RETRIES = 3;
const CAMPAIGN_ISSUE_BATCH_SIZE = 100;
const CAMPAIGN_NOTIFY_BATCH_SIZE = 50;
const RANK_ORDER: MembershipRank[] = [
  MembershipRank.BRONZE,
  MembershipRank.SILVER,
  MembershipRank.GOLD,
  MembershipRank.PLATINUM,
  MembershipRank.DIAMOND,
];

type CampaignMutationDto = {
  name?: string;
  description?: string;
  startsAt?: Date;
  endsAt?: Date;
  maxRedemptions?: number;
  status?: CampaignStatus;
  rolloutPercent?: number;
  promoCode?: string;
  targetAudience?: string;
  targetMinRank?: MembershipRank;
  targetDormantDays?: number;
  targetNewUserOnly?: boolean;
};

@Injectable()
export class CampaignService {
  private readonly logger = new Logger(CampaignService.name);

  constructor(
    private prisma: PrismaService,
    private auditLog: AuditLogService,
    private notificationQueue: NotificationQueueService,
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
    targetMinRank?: MembershipRank;
    targetDormantDays?: number;
    targetNewUserOnly?: boolean;
    maxRedemptions?: number;
    rolloutPercent?: number;
    promoCode?: string;
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
    this.validateCampaignPayload(dto);

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
            discountValue: dto.discountValue !== undefined ? BigInt(dto.discountValue * 100) : null,
            discountPercent: dto.discountPercent,
            maxDiscount: dto.maxDiscount !== undefined ? BigInt(dto.maxDiscount * 100) : null,
            freeTransactions: dto.freeTransactions,
            targetAudience: dto.targetAudience?.trim(),
            targetMinRank: dto.targetMinRank,
            targetDormantDays: dto.targetDormantDays,
            targetNewUserOnly: dto.targetNewUserOnly ?? false,
            maxRedemptions: dto.maxRedemptions,
            rolloutPercent: dto.rolloutPercent ?? 100,
            promoCode: this.normalizePromoCode(dto.promoCode),
            createdBy: adminId,
          },
        });
        break;
      } catch (err: unknown) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002' && attempt < MAX_CAMPAIGN_ID_RETRIES - 1) {
          this.logger.warn(`Campaign unique collision on attempt ${attempt + 1}, retrying...`);
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
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], // R2-L: id tiebreak keeps offset pages stable when timestamps collide
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

  async updateCampaign(campaignId: string, adminId: string, dto: CampaignMutationDto, ipAddress: string = 'unknown'): Promise<object> {
    const campaign = await this.prisma.campaign.findUnique({ where: { campaignId } });
    if (!campaign) throw new NotFoundException({ code: ErrorCodes.CAMPAIGN_NOT_FOUND, message: 'Campaign not found' });
    if (campaign.status === CampaignStatus.ENDED) {
      throw new BadRequestException({ code: ErrorCodes.CAMPAIGN_ACTIVE, message: 'Ended campaigns cannot be changed' });
    }
    if (dto.name !== undefined && (dto.name.trim().length < 3 || dto.name.trim().length > 100 || /[<>]/.test(dto.name))) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Campaign name must be 3–100 safe characters' });
    }
    if (dto.description !== undefined && (dto.description.trim().length > 1000 || /[<>]/.test(dto.description))) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Campaign description is invalid' });
    }
    if (dto.targetAudience !== undefined && (dto.targetAudience.trim().length > 500 || /[<>]/.test(dto.targetAudience))) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Campaign target audience is invalid' });
    }

    this.validateCampaignPayload(dto);

    const nextStartsAt = dto.startsAt ?? campaign.startsAt;
    const nextEndsAt = dto.endsAt ?? campaign.endsAt;
    if (nextEndsAt <= nextStartsAt) {
      throw new BadRequestException({ code: ErrorCodes.INVALID_CAMPAIGN_DATES, message: 'End date must be after start date' });
    }
    if (dto.maxRedemptions !== undefined && dto.maxRedemptions < campaign.currentRedemptions) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'maxRedemptions cannot be lower than current redemptions' });
    }
    if (dto.rolloutPercent !== undefined) {
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
    if (dto.promoCode !== undefined) data.promoCode = this.normalizePromoCode(dto.promoCode);
    if (dto.targetAudience !== undefined) data.targetAudience = dto.targetAudience.trim();
    if (dto.targetMinRank !== undefined) data.targetMinRank = dto.targetMinRank;
    if (dto.targetDormantDays !== undefined) data.targetDormantDays = dto.targetDormantDays;
    if (dto.targetNewUserOnly !== undefined) data.targetNewUserOnly = dto.targetNewUserOnly;

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

  async activateCampaign(campaignId: string, adminId: string, ipAddress: string = 'unknown'): Promise<object> {
    const campaign = await this.prisma.campaign.findUnique({ where: { campaignId } });
    if (!campaign) throw new NotFoundException({ code: ErrorCodes.CAMPAIGN_NOT_FOUND, message: 'Campaign not found' });
    const activated = await this.activateCampaignRecord(campaign);
    const issueResult = await this.issuePersonalVouchers(activated);

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'Campaign',
      targetId: activated.campaignId,
      description: `Activated campaign "${activated.name}" (${activated.campaignId})`,
      before: { status: campaign.status },
      after: { status: activated.status, issuedVouchers: issueResult.issued },
      ipAddress,
    });

    return { ...this.formatCampaign(activated), voucherIssuance: issueResult };
  }

  async activateDueCampaigns(): Promise<{ activated: number; ended: number; issued: number }> {
    const now = new Date();
    const ended = await this.prisma.campaign.updateMany({
      where: {
        status: { in: [CampaignStatus.DRAFT, CampaignStatus.ACTIVE, CampaignStatus.PAUSED] },
        endsAt: { lte: now },
      },
      data: { status: CampaignStatus.ENDED },
    });

    const dueCampaigns = await this.prisma.campaign.findMany({
      where: {
        status: CampaignStatus.DRAFT,
        startsAt: { lte: now },
        endsAt: { gt: now },
      },
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      take: 25,
    });

    let activated = 0;
    let issued = 0;
    for (const campaign of dueCampaigns) {
      try {
        const active = await this.activateCampaignRecord(campaign, true);
        activated += active.status === CampaignStatus.ACTIVE ? 1 : 0;
        const result = await this.issuePersonalVouchers(active);
        issued += result.issued;
      } catch (error: unknown) {
        this.logger.error(`CAMPAIGN_ACTIVATION_FAILED campaignId=${campaign.campaignId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const activeCampaigns = await this.prisma.campaign.findMany({
      where: {
        status: CampaignStatus.ACTIVE,
        type: { in: [CampaignType.FEE_PROMO, CampaignType.CASHBACK] },
        startsAt: { lte: now },
        endsAt: { gt: now },
      },
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      take: 25,
    });
    for (const campaign of activeCampaigns) {
      const result = await this.issuePersonalVouchers(campaign);
      issued += result.issued;
    }

    return { activated, ended: ended.count, issued };
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

  private async activateCampaignRecord(campaign: Campaign, skipIfAlreadyActive = false): Promise<Campaign> {
    const now = new Date();
    if (campaign.status === CampaignStatus.ENDED || campaign.endsAt <= now) {
      await this.prisma.campaign.updateMany({ where: { id: campaign.id }, data: { status: CampaignStatus.ENDED } });
      throw new BadRequestException({ code: ErrorCodes.CAMPAIGN_ACTIVE, message: 'Campaign has ended and cannot be activated' });
    }
    if (campaign.startsAt > now) {
      throw new BadRequestException({ code: ErrorCodes.INVALID_CAMPAIGN_DATES, message: 'Campaign start date is still in the future' });
    }
    if (campaign.status === CampaignStatus.ACTIVE && skipIfAlreadyActive) return campaign;
    if (campaign.status !== CampaignStatus.DRAFT && campaign.status !== CampaignStatus.PAUSED && campaign.status !== CampaignStatus.ACTIVE) {
      throw new BadRequestException({ code: ErrorCodes.CAMPAIGN_ACTIVE, message: `Campaign status ${campaign.status} cannot be activated` });
    }
    if (campaign.status === CampaignStatus.ACTIVE) return campaign;
    return this.prisma.campaign.update({ where: { id: campaign.id }, data: { status: CampaignStatus.ACTIVE } });
  }

  private validateCampaignPayload(dto: { type?: CampaignType; discountValue?: number; discountPercent?: number; maxDiscount?: number; targetMinRank?: MembershipRank; targetDormantDays?: number; targetNewUserOnly?: boolean; rolloutPercent?: number; promoCode?: string | null }): void {
    if (dto.rolloutPercent !== undefined && (!Number.isInteger(dto.rolloutPercent) || dto.rolloutPercent < 0 || dto.rolloutPercent > 100)) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'rolloutPercent must be between 0 and 100' });
    }
    if (dto.targetDormantDays !== undefined && (!Number.isInteger(dto.targetDormantDays) || dto.targetDormantDays < 1 || dto.targetDormantDays > 3650)) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'targetDormantDays must be between 1 and 3650' });
    }
    if (dto.targetMinRank !== undefined && !RANK_ORDER.includes(dto.targetMinRank)) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'targetMinRank is invalid' });
    }
    if (dto.promoCode !== undefined && dto.promoCode !== null) this.normalizePromoCode(dto.promoCode);
    if ((dto.type === CampaignType.FEE_PROMO || dto.type === CampaignType.CASHBACK || dto.type === CampaignType.SUBSCRIPTION_DISCOUNT) && dto.discountValue === undefined && dto.discountPercent === undefined) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Campaign discountValue or discountPercent is required for promo campaigns' });
    }
    if (dto.discountValue !== undefined && dto.discountPercent !== undefined) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Use either discountValue or discountPercent, not both' });
    }
    if (dto.maxDiscount !== undefined && dto.discountPercent === undefined) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'maxDiscount is only valid for percentage discounts' });
    }
  }

  private normalizePromoCode(code?: string | null): string | null {
    if (code === undefined || code === null || code.trim() === '') return null;
    const normalized = code.trim().toUpperCase();
    if (!/^[A-Z0-9_-]{3,32}$/.test(normalized)) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'promoCode must be 3-32 uppercase-safe characters (A-Z, 0-9, underscore, dash)' });
    }
    return normalized;
  }

  private rankFilter(minRank?: MembershipRank | null): MembershipRank[] | undefined {
    if (!minRank) return undefined;
    const start = RANK_ORDER.indexOf(minRank);
    return start >= 0 ? RANK_ORDER.slice(start) : undefined;
  }

  private isInRollout(campaignId: string, userId: string, percent: number | null): boolean {
    const rollout = percent ?? 100;
    if (rollout >= 100) return true;
    if (rollout <= 0) return false;
    const hex = createHash('sha256').update(`${campaignId}:${userId}`).digest('hex').slice(0, 8);
    return Number.parseInt(hex, 16) % 100 < rollout;
  }

  private resolveVoucherType(campaign: Campaign): VoucherType | null {
    if (campaign.type === CampaignType.CASHBACK) return VoucherType.WALLET_CASHBACK;
    if (campaign.type === CampaignType.FEE_PROMO) {
      return campaign.discountPercent !== null ? VoucherType.FEE_DISCOUNT_PERCENT : VoucherType.FEE_DISCOUNT_FLAT;
    }
    return null;
  }

  private campaignVoucherCode(campaign: Campaign, publicUserId: string): string {
    const base = (campaign.promoCode ?? campaign.campaignId).replace(/[^A-Z0-9_-]/gi, '').toUpperCase().slice(0, 24);
    const suffix = publicUserId.replace(/[^A-Z0-9]/gi, '').slice(-8).toUpperCase();
    return `${base}-${suffix}-${randomBytes(3).toString('hex').toUpperCase()}`.slice(0, 50);
  }

  private async issuePersonalVouchers(campaign: Campaign): Promise<{ issued: number; skipped: number; notified: number }> {
    if (campaign.status !== CampaignStatus.ACTIVE) return { issued: 0, skipped: 0, notified: 0 };
    if (campaign.endsAt <= new Date()) return { issued: 0, skipped: 0, notified: 0 };
    const voucherType = this.resolveVoucherType(campaign);
    if (!voucherType) return { issued: 0, skipped: 0, notified: 0 };

    const existingIssued = await this.prisma.voucher.count({ where: { campaignId: campaign.id } });
    let remaining = campaign.maxRedemptions === null ? Number.POSITIVE_INFINITY : Math.max(0, campaign.maxRedemptions - existingIssued);
    if (remaining === 0) return { issued: 0, skipped: 0, notified: 0 };

    const where: Prisma.UserWhereInput = {
      isActive: true,
      isBanned: false,
      deletedAt: null,
    };
    const ranks = this.rankFilter(campaign.targetMinRank);
    if (ranks) where.membershipRank = { in: ranks };
    if (campaign.targetNewUserOnly) where.totalOrdersCompleted = 0;
    const and: Prisma.UserWhereInput[] = [];
    if (campaign.targetDormantDays !== null) {
      const cutoff = new Date(Date.now() - campaign.targetDormantDays * 24 * 60 * 60 * 1000);
      and.push(
        { totalOrdersCompleted: { gt: 0 } },
        { ordersAsBuyer: { none: { status: 'COMPLETED', deletedAt: null, completedAt: { gte: cutoff } } } },
        { ordersAsSeller: { none: { status: 'COMPLETED', deletedAt: null, completedAt: { gte: cutoff } } } },
      );
    }
    if (and.length > 0) where.AND = and;

    let cursor: string | undefined;
    let issued = 0;
    let skipped = 0;
    const notifyUsers: Array<{ userId: string; code: string }> = [];

    while (remaining > 0) {
      const users = await this.prisma.user.findMany({
        where,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: Math.min(CAMPAIGN_ISSUE_BATCH_SIZE, Number.isFinite(remaining) ? remaining : CAMPAIGN_ISSUE_BATCH_SIZE),
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: { id: true, userId: true },
      });
      if (users.length === 0) break;
      cursor = users[users.length - 1].id;

      for (const user of users) {
        if (!this.isInRollout(campaign.campaignId, user.id, campaign.rolloutPercent)) {
          skipped++;
          continue;
        }
        if (remaining <= 0) break;
        let created = false;
        for (let attempt = 0; attempt < 3 && !created; attempt++) {
          try {
            const code = this.campaignVoucherCode(campaign, user.userId);
            const voucher = await this.prisma.voucher.create({
              data: {
                voucherId: `VCH-${code}`,
                code,
                name: campaign.name,
                voucherType,
                description: campaign.description ?? `Campaign ${campaign.name}`,
                discountAmount: campaign.discountValue,
                discountPercent: campaign.discountPercent,
                maxDiscountAmount: campaign.maxDiscount,
                minOrderValue: null,
                maxUsageTotal: 1,
                maxUsagePerUser: 1,
                currentUsage: 0,
                applicableTo: campaign.targetDormantDays !== null ? VoucherApplicability.DORMANT_USER : VoucherApplicability.ALL,
                isActive: true,
                validFrom: campaign.startsAt,
                validUntil: campaign.endsAt,
                createdBy: campaign.createdBy,
                campaignId: campaign.id,
                assignedToUserId: user.id,
              },
            });
            issued++;
            remaining = Number.isFinite(remaining) ? remaining - 1 : remaining;
            notifyUsers.push({ userId: user.id, code: voucher.code });
            created = true;
          } catch (error: unknown) {
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
              skipped++;
              break;
            }
            if (error instanceof Prisma.PrismaClientKnownRequestError && attempt < 2) continue;
            throw error;
          }
        }
      }
      if (users.length < CAMPAIGN_ISSUE_BATCH_SIZE) break;
    }

    const notified = await this.notifyIssuedUsers(campaign, notifyUsers);
    return { issued, skipped, notified };
  }

  private async notifyIssuedUsers(campaign: Campaign, recipients: Array<{ userId: string; code: string }>): Promise<number> {
    let notified = 0;
    for (let i = 0; i < recipients.length; i += CAMPAIGN_NOTIFY_BATCH_SIZE) {
      const batch = recipients.slice(i, i + CAMPAIGN_NOTIFY_BATCH_SIZE);
      await Promise.all(batch.map((recipient) => this.notificationQueue.enqueue({
        userId: recipient.userId,
        type: NotificationType.VOUCHER_ISSUED,
        title: 'Voucher Baru dari Kahade',
        body: `Voucher ${recipient.code} dari campaign "${campaign.name}" sudah tersedia sampai ${campaign.endsAt.toLocaleDateString('id-ID')}.`,
        pushData: { type: 'VOUCHER_ISSUED', campaignId: campaign.campaignId, voucherCode: recipient.code },
      }).then(() => { notified++; }).catch((error: unknown) => {
        this.logger.warn(`CAMPAIGN_VOUCHER_NOTIFY_FAILED campaignId=${campaign.campaignId} userId=${recipient.userId}: ${error instanceof Error ? error.message : String(error)}`);
      })));
      if (i + CAMPAIGN_NOTIFY_BATCH_SIZE < recipients.length) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    return notified;
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
      targetMinRank: c.targetMinRank,
      targetDormantDays: c.targetDormantDays,
      targetNewUserOnly: c.targetNewUserOnly,
      promoCode: c.promoCode,
      maxRedemptions: c.maxRedemptions,
      currentRedemptions: c.currentRedemptions,
      rolloutPercent: c.rolloutPercent,
      createdBy: c.createdBy,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  }
}
