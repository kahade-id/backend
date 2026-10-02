import { Injectable, BadRequestException, ForbiddenException, NotFoundException, Logger, OnModuleInit } from '@nestjs/common';
import { AuditAction, CampaignType, CampaignStatus, Prisma, Campaign, MembershipRank, VoucherType, VoucherApplicability, NotificationType } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogService } from '../../common/services/audit-log.service';
import { generateCampaignId } from '../../common/utils/id-generator.util';
import * as ErrorCodes from '../../common/constants/error-codes';
import { safeBigIntToNumber } from '../../common/utils/bigint.util';
import { NotificationQueueService } from '../queue/notification-queue.service';
// SYS-B-402: dual control untuk aktivasi campaign bernilai di atas ambang.
import { ApprovalsService } from './approvals/approvals.service';
import { DUAL_CONTROL_THRESHOLD_SEN } from './approvals/dual-control.constants';

const MAX_CAMPAIGN_ID_RETRIES = 3;
const CAMPAIGN_ISSUE_BATCH_SIZE = 100;
const CAMPAIGN_NOTIFY_BATCH_SIZE = 50;
/** Ambang alarm kuota: flag bila pemakaian > 80% dari maxRedemptions (G365). */
export const CAMPAIGN_QUOTA_ALARM_THRESHOLD = 80;
/**
 * G351: FIELD TERKUNCI setelah campaign keluar dari status DRAFT.
 * Mengubah field ini setelah voucher diterbitkan / campaign berjalan akan
 * merusak konsistensi promo — update ditolak dengan CAMPAIGN_FIELD_LOCKED.
 * (type, discountValue/discountPercent, maxDiscount, freeTransactions memang
 * tidak bisa diubah via PUT sama sekali; sisanya dikunci setelah DRAFT.)
 */
export const LOCKED_AFTER_ACTIVE: readonly string[] = [
  'type',
  'discountValue',
  'discountPercent',
  'maxDiscount',
  'freeTransactions',
  'promoCode',
  'targetAudience',
  'targetMinRank',
  'targetDormantDays',
  'targetNewUserOnly',
] as const;
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
  /** Alasan perubahan — WAJIB untuk PUT (G353), dicatat di CampaignVersion. */
  changeReason?: string;
};

@Injectable()
export class CampaignService implements OnModuleInit {
  private readonly logger = new Logger(CampaignService.name);

  constructor(
    private prisma: PrismaService,
    private auditLog: AuditLogService,
    private notificationQueue: NotificationQueueService,
    // SYS-B-402: modul ini mengeksekusi CAMPAIGN_ACTIVATE yang disetujui
    // (ApprovalsModule @Global — tanpa import modul).
    private readonly approvals: ApprovalsService,
  ) {}

  onModuleInit(): void {
    this.approvals.registerExecutor('CAMPAIGN_ACTIVATE', async (ctx) => {
      if (!ctx.targetId) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'CAMPAIGN_ACTIVATE membutuhkan targetId (campaignId)',
        });
      }
      const reason = typeof ctx.payload.reason === 'string' ? ctx.payload.reason : '';
      // Jalur dual control: gate ambang dilewati (sudah dipenuhi saat propose
      // + approve oleh dua admin berbeda).
      return this.performActivateCampaign(ctx.targetId, ctx.decidedBy, { reason }, ctx.ipAddress);
    });
  }

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

  async getCampaigns(page: number, limit: number, status?: string, filters: { createdBy?: string; from?: Date; to?: Date } = {}): Promise<object> {
    const safePage = Math.max(1, Math.floor(page));
    const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 50);
    const skip = (safePage - 1) * safeLimit;
    const where: Prisma.CampaignWhereInput = {};

    if (status) where.status = status as CampaignStatus;
    if (filters.createdBy) where.createdBy = filters.createdBy;
    // G370: rentang tanggal = irisan dengan periode kampanye [startsAt, endsAt].
    if (filters.from || filters.to) {
      if (filters.to) where.startsAt = { lte: filters.to };
      if (filters.from) where.endsAt = { gte: filters.from };
    }

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

  /**
   * G351-G355: update kampanye via PUT /v1/admin/campaigns/:campaignId.
   * - Field di LOCKED_AFTER_ACTIVE ditolak bila status != DRAFT (CAMPAIGN_FIELD_LOCKED).
   * - Perubahan status via PUT ditolak — pakai endpoint pause/activate.
   * - changeReason WAJIB; CampaignVersion ditulis SEBELUM update (atomik via transaksi).
   * - Audit: CAMPAIGN_UPDATED.
   */
  async updateCampaign(campaignId: string, adminId: string, dto: CampaignMutationDto, ipAddress: string = 'unknown'): Promise<object> {
    const campaign = await this.prisma.campaign.findUnique({ where: { campaignId } });
    if (!campaign) throw new NotFoundException({ code: ErrorCodes.CAMPAIGN_NOT_FOUND, message: 'Campaign not found' });
    if (campaign.status === CampaignStatus.ENDED) {
      throw new BadRequestException({ code: ErrorCodes.CAMPAIGN_ACTIVE, message: 'Ended campaigns cannot be changed' });
    }
    if (dto.status !== undefined) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Ubah status lewat endpoint khusus: POST :id/pause, POST :id/activate' });
    }
    const changeReason = dto.changeReason?.trim() ?? '';
    if (changeReason.length < 5) {
      throw new BadRequestException({ code: ErrorCodes.CAMPAIGN_CHANGE_REASON_REQUIRED, message: 'changeReason wajib diisi (min 5 karakter)' });
    }

    // G351: tolak perubahan field terkunci setelah keluar dari DRAFT.
    if (campaign.status !== CampaignStatus.DRAFT) {
      const lockedTouched = (LOCKED_AFTER_ACTIVE as readonly string[]).filter((field) => {
        const next = (dto as Record<string, unknown>)[field];
        if (next === undefined) return false;
        return !this.campaignFieldEquals(field, next, campaign);
      });
      if (lockedTouched.length > 0) {
        throw new BadRequestException({
          code: ErrorCodes.CAMPAIGN_FIELD_LOCKED,
          message: `Field terkunci setelah campaign aktif: ${lockedTouched.join(', ')}. Buat kampanye baru untuk mengubahnya.`,
          lockedFields: lockedTouched,
        });
      }
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
    // G352: draf tidak boleh dijadwalkan mulai di masa lalu.
    if (campaign.status === CampaignStatus.DRAFT && dto.startsAt && dto.startsAt.getTime() < Date.now() - 60_000) {
      throw new BadRequestException({ code: ErrorCodes.INVALID_CAMPAIGN_DATES, message: 'Tanggal mulai draf tidak boleh di masa lalu' });
    }
    if (dto.maxRedemptions !== undefined) {
      if (!Number.isInteger(dto.maxRedemptions) || dto.maxRedemptions <= 0) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'maxRedemptions harus > 0' });
      }
      if (dto.maxRedemptions < campaign.currentRedemptions) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'maxRedemptions cannot be lower than current redemptions' });
      }
    }
    if (dto.rolloutPercent !== undefined) {
      // G352: rollout 1-100 (DTO juga memvalidasi).
      if (!Number.isInteger(dto.rolloutPercent) || dto.rolloutPercent < 1 || dto.rolloutPercent > 100) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'rolloutPercent must be between 1 and 100' });
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
    if (dto.rolloutPercent !== undefined) data.rolloutPercent = dto.rolloutPercent;
    if (dto.promoCode !== undefined) data.promoCode = this.normalizePromoCode(dto.promoCode);
    if (dto.targetAudience !== undefined) data.targetAudience = dto.targetAudience.trim();
    if (dto.targetMinRank !== undefined) data.targetMinRank = dto.targetMinRank;
    if (dto.targetDormantDays !== undefined) data.targetDormantDays = dto.targetDormantDays;
    if (dto.targetNewUserOnly !== undefined) data.targetNewUserOnly = dto.targetNewUserOnly;

    if (Object.keys(data).length === 0) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'At least one campaign field must be changed' });
    }

    // G353: tulis CampaignVersion (snapshot SEBELUM update), lalu update.
    const changedFields = this.diffCampaignFields(campaign, data);
    await this.writeCampaignVersion(campaign, adminId, changeReason, changedFields);
    const updated = await this.prisma.campaign.update({ where: { campaignId }, data });

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.CAMPAIGN_UPDATED,
      targetType: 'Campaign',
      targetId: campaignId,
      description: `Updated campaign "${updated.name}" (${campaignId}): ${changeReason}`,
      before: { name: campaign.name, status: campaign.status },
      after: { ...data, changeReason },
      ipAddress,
    });

    return this.formatCampaign(updated);
  }

  /** Bandingkan nilai field DTO dengan nilai campaign saat ini (untuk deteksi field terkunci). */
  private campaignFieldEquals(field: string, next: unknown, campaign: Campaign): boolean {
    switch (field) {
      case 'promoCode': {
        const normalized = typeof next === 'string' ? this.normalizePromoCode(next) : next;
        return normalized === campaign.promoCode;
      }
      case 'targetAudience': {
        const normalized = typeof next === 'string' ? next.trim() : next;
        return (normalized || null) === campaign.targetAudience;
      }
      case 'targetMinRank':
        return (next ?? null) === campaign.targetMinRank;
      case 'targetDormantDays':
        return (next ?? null) === campaign.targetDormantDays;
      case 'targetNewUserOnly':
        return Boolean(next) === campaign.targetNewUserOnly;
      case 'discountValue':
      case 'maxDiscount': {
        const current = field === 'discountValue' ? campaign.discountValue : campaign.maxDiscount;
        if (next === null || next === undefined) return current === null;
        try { return BigInt(Math.round(Number(next) * 100)) === current; } catch { return false; }
      }
      case 'discountPercent':
        return next === null || next === undefined
          ? campaign.discountPercent === null
          : Number(next) === Number(campaign.discountPercent);
      case 'freeTransactions':
        return (next ?? null) === campaign.freeTransactions;
      case 'type':
        return next === campaign.type;
      default:
        return false;
    }
  }

  /** Daftar field yang benar-benar berubah (untuk diff pratinjau & versi). */
  private diffCampaignFields(campaign: Campaign, data: Prisma.CampaignUpdateInput): string[] {
    const changed: string[] = [];
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue;
      let same: boolean;
      switch (key) {
        case 'promoCode':
        case 'targetAudience':
        case 'targetMinRank':
        case 'targetDormantDays':
        case 'targetNewUserOnly':
          same = this.campaignFieldEquals(key, value, campaign);
          break;
        case 'name':
        case 'description':
          same = String(value) === String((campaign as unknown as Record<string, unknown>)[key] ?? '');
          break;
        case 'startsAt':
        case 'endsAt':
          same = value instanceof Date && (campaign as unknown as Record<string, Date>)[key] instanceof Date
            && value.getTime() === (campaign as unknown as Record<string, Date>)[key].getTime();
          break;
        default:
          same = Number(value) === Number((campaign as unknown as Record<string, unknown>)[key]);
      }
      if (!same) changed.push(key);
    }
    return changed;
  }

  /**
   * G353: tulis satu entri CampaignVersion berisi snapshot JSON campaign
   * SEBELUM perubahan + changedBy + changeReason wajib.
   */
  private async writeCampaignVersion(campaign: Campaign, changedBy: string, changeReason: string, changedFields: string[]): Promise<void> {
    const agg = await this.prisma.campaignVersion.aggregate({
      where: { campaignId: campaign.id },
      _max: { version: true },
    });
    const version = (agg._max.version ?? 0) + 1;
    const snapshot = this.formatCampaign(campaign) as unknown as Prisma.InputJsonValue;
    await this.prisma.campaignVersion.create({
      data: {
        campaignId: campaign.id,
        version,
        payload: { snapshot, changedFields } as unknown as Prisma.InputJsonValue,
        changedBy,
        changeReason,
      },
    });
  }

  /**
   * G359-G361: aktivasi kampanye manual.
   * - reason WAJIB → dicatat di CampaignVersion + audit PAUSE_REASON_RECORDED.
   * - Idempotency dijamin @Idempotency() pada route (header Idempotency-Key UUID v4
   *   wajib; duplikat key+payload sama di-replay, key dipakai ulang dengan payload
   *   beda ditolak IDEMPOTENCY_KEY_REUSE).
   * - Idempoten di level service: campaign yang sudah ACTIVE tidak menerbitkan ulang.
   */
  async activateCampaign(campaignId: string, adminId: string, opts: { reason: string }, ipAddress: string = 'unknown'): Promise<object> {
    // SYS-B-402: aktivasi = momen liabilitas finansial lahir. Nilai campaign
    // (discountValue/maxDiscount, sen) di atas ambang → wajib dual control.
    const campaign = await this.prisma.campaign.findUnique({ where: { campaignId } });
    if (!campaign) throw new NotFoundException({ code: ErrorCodes.CAMPAIGN_NOT_FOUND, message: 'Campaign not found' });
    const valueSen = [campaign.discountValue, campaign.maxDiscount]
      .filter((v): v is bigint => v !== null && v !== undefined)
      .reduce((m, v) => (v > m ? v : m), 0n);
    if (valueSen > DUAL_CONTROL_THRESHOLD_SEN) {
      throw new ForbiddenException({
        code: ErrorCodes.DUAL_CONTROL_REQUIRED,
        message:
          'Nilai campaign di atas Rp1.000.000 wajib dual control ' +
          '(usulkan via POST /v1/admin/approvals/propose dengan actionType CAMPAIGN_ACTIVATE)',
      });
    }
    return this.performActivateCampaign(campaignId, adminId, opts, ipAddress, campaign);
  }

  /**
   * Inti aktivasi campaign — dipakai activateCampaign (jalur langsung, setelah
   * gate ambang) dan executor CAMPAIGN_ACTIVATE (jalur dual control; guard
   * sudah dipenuhi saat propose + approve oleh dua admin berbeda).
   */
  private async performActivateCampaign(
    campaignId: string,
    adminId: string,
    opts: { reason: string },
    ipAddress: string = 'unknown',
    preloaded?: Campaign,
  ): Promise<object> {
    const reason = opts.reason?.trim() ?? '';
    if (reason.length < 5) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'reason wajib diisi (min 5 karakter)' });
    }
    const campaign = preloaded ?? await this.prisma.campaign.findUnique({ where: { campaignId } });
    if (!campaign) throw new NotFoundException({ code: ErrorCodes.CAMPAIGN_NOT_FOUND, message: 'Campaign not found' });

    if (campaign.status === CampaignStatus.ACTIVE) {
      return { ...this.formatCampaign(campaign), alreadyActive: true, voucherIssuance: { issued: 0, skipped: 0, notified: 0 } };
    }

    const activated = await this.activateCampaignRecord(campaign);
    const changeReason = `Aktivasi: ${reason}`;
    await this.writeCampaignVersion(activated, adminId, changeReason, ['status']);
    const issueResult = await this.issuePersonalVouchers(activated);

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.PAUSE_REASON_RECORDED,
      targetType: 'Campaign',
      targetId: activated.campaignId,
      description: `Activated campaign "${activated.name}" (${activated.campaignId}). Alasan: ${reason}`,
      before: { status: campaign.status },
      after: { status: activated.status, issuedVouchers: issueResult.issued, reason },
      ipAddress,
    });

    return { ...this.formatCampaign(activated), voucherIssuance: issueResult };
  }

  /**
   * G359: jeda kampanye. reason WAJIB → CampaignVersion + audit PAUSE_REASON_RECORDED.
   * Idempoten: campaign yang sudah PAUSED dikembalikan apa adanya tanpa versi baru.
   */
  async pauseCampaign(campaignId: string, adminId: string, reason: string, ipAddress: string = 'unknown'): Promise<object> {
    const cleanReason = reason?.trim() ?? '';
    if (cleanReason.length < 5) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'reason wajib diisi (min 5 karakter)' });
    }
    const campaign = await this.prisma.campaign.findUnique({ where: { campaignId } });
    if (!campaign) throw new NotFoundException({ code: ErrorCodes.CAMPAIGN_NOT_FOUND, message: 'Campaign not found' });
    if (campaign.status === CampaignStatus.PAUSED) {
      return { ...this.formatCampaign(campaign), alreadyPaused: true };
    }
    if (campaign.status !== CampaignStatus.ACTIVE) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: `Hanya kampanye ACTIVE yang bisa dijeda (status saat ini: ${campaign.status})` });
    }

    const changeReason = `Jeda: ${cleanReason}`;
    await this.writeCampaignVersion(campaign, adminId, changeReason, ['status']);
    const paused = await this.prisma.campaign.update({ where: { campaignId }, data: { status: CampaignStatus.PAUSED } });

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.PAUSE_REASON_RECORDED,
      targetType: 'Campaign',
      targetId: campaignId,
      description: `Paused campaign "${paused.name}" (${campaignId}). Alasan: ${cleanReason}`,
      before: { status: campaign.status },
      after: { status: paused.status, reason: cleanReason },
      ipAddress,
    });

    return this.formatCampaign(paused);
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

  /**
   * G356-G357: hapus kampanye.
   * - Tolak bila status ACTIVE.
   * - Tolak bila campaign sudah menerbitkan voucher (vouchers count > 0),
   *   KECUALI status DRAFT + force=true + reason wajib.
   * - Penghapusan paksa menonaktifkan dulu voucher terbit (CW-009) lalu hapus campaign.
   * - Audit: CAMPAIGN_DELETED.
   */
  async deleteCampaign(campaignId: string, adminId: string, opts: { force?: boolean; reason?: string } = {}, ipAddress: string = 'unknown'): Promise<{ message: string }> {
    const campaign = await this.prisma.campaign.findUnique({ where: { campaignId } });
    if (!campaign) throw new NotFoundException({ code: ErrorCodes.CAMPAIGN_NOT_FOUND, message: 'Campaign not found' });
    if (campaign.status === CampaignStatus.ACTIVE) {
      throw new BadRequestException({ code: ErrorCodes.CAMPAIGN_ACTIVE, message: 'Tidak bisa menghapus kampanye yang sedang aktif — jeda dulu' });
    }

    const voucherCount = await this.prisma.voucher.count({ where: { campaignId: campaign.id } });
    const force = opts.force === true;
    const reason = opts.reason?.trim() ?? '';
    if (voucherCount > 0) {
      const allowed = campaign.status === CampaignStatus.DRAFT && force && reason.length >= 5;
      if (!allowed) {
        throw new BadRequestException({
          code: ErrorCodes.CAMPAIGN_HAS_VOUCHERS,
          message: `Campaign sudah menerbitkan ${voucherCount} voucher dan tidak bisa dihapus.`
            + (campaign.status === CampaignStatus.DRAFT
              ? ' Untuk draf, ulangi dengan force=true + reason (min 5 karakter).'
              : ' Hanya kampanye DRAFT yang bisa dihapus paksa.'),
          voucherCount,
        });
      }
    } else if (force && reason.length < 5) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'reason wajib diisi (min 5 karakter) bila force=true' });
    }

    // CW-009: hapus campaign HARUS mencabut voucher yang sudah diterbitkan.
    // Relasi onDelete: SetNull membuat campaignId voucher jadi NULL, dan
    // voucher dengan campaignId NULL dianggap tersedia (buildActiveVoucherWhere)
    // — tanpa ini, voucher "yatim" tetap bisa ditebus setelah campaign dihapus.
    // Nonaktifkan dulu (idempoten), lalu hapus campaign — atomik.
    const now = new Date();
    const [deactivated] = await this.prisma.$transaction([
      this.prisma.voucher.updateMany({
        where: { campaignId: campaign.id, isActive: true },
        data: { isActive: false, deactivatedBy: adminId, deactivatedAt: now },
      }),
      this.prisma.campaign.delete({ where: { campaignId } }),
    ]);

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.CAMPAIGN_DELETED,
      targetType: 'Campaign',
      targetId: campaignId,
      description: `Deleted campaign "${campaign.name}" (${campaignId}); deactivated ${deactivated.count} issued voucher(s)${force ? `. Alasan paksa: ${reason}` : ''}`,
      before: { name: campaign.name, status: campaign.status, voucherCount },
      after: { force, reason: force ? reason : undefined },
      ipAddress,
    });

    return { message: 'Campaign deleted' };
  }

  /** G358: riwayat versi kampanye (paginasi, terbaru dulu). */
  async getCampaignVersions(campaignId: string, page = 1, limit = 20): Promise<object> {
    const campaign = await this.prisma.campaign.findUnique({ where: { campaignId } });
    if (!campaign) throw new NotFoundException({ code: ErrorCodes.CAMPAIGN_NOT_FOUND, message: 'Campaign not found' });
    const safePage = Math.max(1, Math.floor(page));
    const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 50);
    const [versions, total] = await Promise.all([
      this.prisma.campaignVersion.findMany({
        where: { campaignId: campaign.id },
        orderBy: [{ version: 'desc' }],
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
      }),
      this.prisma.campaignVersion.count({ where: { campaignId: campaign.id } }),
    ]);
    const totalPages = Math.ceil(total / safeLimit);
    return {
      data: versions.map(v => ({
        id: v.id,
        version: v.version,
        payload: v.payload,
        changedBy: v.changedBy,
        changeReason: v.changeReason,
        createdAt: v.createdAt,
      })),
      total,
      page: safePage,
      limit: safeLimit,
      totalPages,
      hasNext: safePage < totalPages,
      hasPrev: safePage > 1,
    };
  }

  /**
   * G362: duplikat kampanye ke DRAFT baru — tanpa hasil redemption.
   * Menyalin konfigurasi (tipe, diskon, targeting, kuota, rollout) tetapi:
   * - status selalu DRAFT, currentRedemptions = 0
   * - promoCode dikosongkan (unik) — admin mengisi kode baru saat edit draf
   * - bila jadwal asli sudah lewat, digeser maju mempertahankan durasi
   * - menulis CampaignVersion v1 + audit CAMPAIGN_UPDATED
   */
  async duplicateCampaign(campaignId: string, adminId: string, opts: { name?: string } = {}, ipAddress: string = 'unknown'): Promise<object> {
    const campaign = await this.prisma.campaign.findUnique({ where: { campaignId } });
    if (!campaign) throw new NotFoundException({ code: ErrorCodes.CAMPAIGN_NOT_FOUND, message: 'Campaign not found' });

    const name = (opts.name?.trim() || `${campaign.name} (salinan)`.slice(0, 100)).slice(0, 100);
    if (name.trim().length < 3 || /[<>]/.test(name)) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Campaign name must be 3–100 safe characters' });
    }

    // Geser jadwal bila sudah lewat — draf salinan harus bisa diaktifkan.
    const now = new Date();
    const durationMs = campaign.endsAt.getTime() - campaign.startsAt.getTime();
    let startsAt = campaign.startsAt;
    let endsAt = campaign.endsAt;
    let datesAdjusted = false;
    if (endsAt <= now) {
      startsAt = now;
      endsAt = new Date(now.getTime() + Math.max(durationMs, 24 * 60 * 60 * 1000));
      datesAdjusted = true;
    }

    let copy: Campaign | null = null;
    for (let attempt = 0; attempt < MAX_CAMPAIGN_ID_RETRIES; attempt++) {
      const count = await this.prisma.campaign.count();
      const newCampaignId = generateCampaignId(count + 1 + attempt);
      try {
        copy = await this.prisma.campaign.create({
          data: {
            campaignId: newCampaignId,
            name,
            description: campaign.description,
            type: campaign.type,
            status: CampaignStatus.DRAFT,
            startsAt,
            endsAt,
            discountValue: campaign.discountValue,
            discountPercent: campaign.discountPercent,
            maxDiscount: campaign.maxDiscount,
            freeTransactions: campaign.freeTransactions,
            targetAudience: campaign.targetAudience,
            targetMinRank: campaign.targetMinRank,
            targetDormantDays: campaign.targetDormantDays,
            targetNewUserOnly: campaign.targetNewUserOnly,
            promoCode: null,
            maxRedemptions: campaign.maxRedemptions,
            currentRedemptions: 0,
            rolloutPercent: campaign.rolloutPercent,
            createdBy: adminId,
          },
        });
        break;
      } catch (err: unknown) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002' && attempt < MAX_CAMPAIGN_ID_RETRIES - 1) continue;
        throw err;
      }
    }
    if (!copy) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Gagal membuat salinan kampanye' });
    }

    await this.writeCampaignVersion(copy, adminId, `Duplikat dari ${campaign.campaignId}`, []);
    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.CAMPAIGN_UPDATED,
      targetType: 'Campaign',
      targetId: copy.campaignId,
      description: `Duplicated campaign "${campaign.name}" (${campaignId}) → "${copy.name}" (${copy.campaignId}) sebagai DRAFT`,
      before: { sourceCampaignId: campaignId },
      after: { name: copy.name, status: copy.status, datesAdjusted },
      ipAddress,
    });

    return { ...this.formatCampaign(copy), datesAdjusted, sourceCampaignId: campaignId };
  }

  /**
   * G363-G365: analitik kampanye.
   * - redemptions: jumlah penukaran (baris voucher_usages milik voucher kampanye)
   * - skipped: voucher terbit yang masih aktif & belum kedaluwarsa tapi belum pernah ditebus
   * - errors: voucher yang dinonaktifkan sebelum waktunya (deactivatedAt terisi)
   * - actualPromoCost: SUM(discountApplied) dari usages, dalam IDR
   * - quota: kuota terpakai vs maxRedemptions + alarm bila > 80%
   * - audienceEstimate: estimasi penerima bila kampanye diterbitkan sekarang
   */
  async getCampaignAnalytics(campaignId: string): Promise<object> {
    const campaign = await this.prisma.campaign.findUnique({ where: { campaignId } });
    if (!campaign) throw new NotFoundException({ code: ErrorCodes.CAMPAIGN_NOT_FOUND, message: 'Campaign not found' });
    const now = new Date();

    const [voucherStats, usages, costAgg] = await Promise.all([
      this.prisma.voucher.groupBy({
        by: ['voucherType'],
        where: { campaignId: campaign.id },
        _count: { _all: true },
        _sum: { currentUsage: true },
      }),
      this.prisma.voucherUsage.findMany({
        where: { voucher: { campaignId: campaign.id } },
        select: { userId: true },
      }),
      this.prisma.voucherUsage.aggregate({
        where: { voucher: { campaignId: campaign.id } },
        _sum: { discountApplied: true },
        _count: { _all: true },
      }),
    ]);

    const [totalVouchers, activeVouchers, deactivatedVouchers, unusedActiveVouchers] = await Promise.all([
      this.prisma.voucher.count({ where: { campaignId: campaign.id } }),
      this.prisma.voucher.count({ where: { campaignId: campaign.id, isActive: true, validUntil: { gt: now } } }),
      this.prisma.voucher.count({ where: { campaignId: campaign.id, deactivatedAt: { not: null } } }),
      this.prisma.voucher.count({
        where: { campaignId: campaign.id, isActive: true, validUntil: { gt: now }, currentUsage: 0 },
      }),
    ]);

    const redemptions = costAgg._count._all;
    const uniqueRedeemers = new Set(usages.map(u => u.userId)).size;
    const actualPromoCost = costAgg._sum.discountApplied ? safeBigIntToNumber(costAgg._sum.discountApplied) / 100 : 0;

    const quotaPercent = campaign.maxRedemptions
      ? Math.round((campaign.currentRedemptions / campaign.maxRedemptions) * 1000) / 10
      : null;
    const quotaAlarm = quotaPercent !== null && quotaPercent > CAMPAIGN_QUOTA_ALARM_THRESHOLD;

    const audienceEstimate = await this.prisma.user.count({ where: this.buildAudienceWhere(campaign) });

    return {
      campaignId: campaign.campaignId,
      name: campaign.name,
      status: campaign.status,
      vouchers: {
        total: totalVouchers,
        active: activeVouchers,
        deactivated: deactivatedVouchers,
      },
      redemptions,
      uniqueRedeemers,
      /** Voucher terbit, masih aktif & berlaku, tapi belum pernah ditebus. */
      skipped: unusedActiveVouchers,
      /** Voucher yang dinonaktifkan sebelum masa berlakunya habis. */
      errors: deactivatedVouchers,
      /** Biaya promo aktual (IDR) = total discountApplied dari semua penukaran. */
      actualPromoCost,
      byType: voucherStats.map(s => ({
        voucherType: s.voucherType,
        issued: s._count._all,
        redemptions: s._sum.currentUsage ?? 0,
      })),
      quota: {
        max: campaign.maxRedemptions,
        used: campaign.currentRedemptions,
        issued: totalVouchers,
        percent: quotaPercent,
        alarm: quotaAlarm,
      },
      audienceEstimate: {
        eligibleUsers: audienceEstimate,
        note: 'Estimasi pengguna yang memenuhi kriteria target bila kampanye diterbitkan sekarang (sebelum rollout sampling).',
      },
    };
  }

  /** Kriteria audience terstruktur — dipakai bersama issuePersonalVouchers & analitik. */
  private buildAudienceWhere(campaign: Campaign): Prisma.UserWhereInput {
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
    return where;
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

    const where: Prisma.UserWhereInput = this.buildAudienceWhere(campaign);

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
      // G351: daftar field terkunci (badge "terkunci" di UI) — kosong saat DRAFT.
      lockedFields: c.status === CampaignStatus.DRAFT ? [] : [...LOCKED_AFTER_ACTIVE],
    };
  }
}
