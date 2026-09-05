"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var CampaignService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.CampaignService = void 0;
const common_1 = require("@nestjs/common");
const client_1 = require("@prisma/client");
const prisma_service_1 = require("../../prisma/prisma.service");
const audit_log_service_1 = require("../../common/services/audit-log.service");
const id_generator_util_1 = require("../../common/utils/id-generator.util");
const ErrorCodes = __importStar(require("../../common/constants/error-codes"));
const bigint_util_1 = require("../../common/utils/bigint.util");
const MAX_CAMPAIGN_ID_RETRIES = 3;
let CampaignService = CampaignService_1 = class CampaignService {
    constructor(prisma, auditLog) {
        this.prisma = prisma;
        this.auditLog = auditLog;
        this.logger = new common_1.Logger(CampaignService_1.name);
    }
    async createCampaign(adminId, dto, ipAddress = 'unknown') {
        const normalizedName = dto.name.trim();
        if (normalizedName.length < 3 || normalizedName.length > 100 || /[<>]/.test(normalizedName)) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Campaign name must be 3–100 safe characters' });
        }
        if (dto.description !== undefined && (dto.description.trim().length > 1000 || /[<>]/.test(dto.description))) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Campaign description is invalid' });
        }
        if (dto.targetAudience !== undefined && (dto.targetAudience.trim().length > 500 || /[<>]/.test(dto.targetAudience))) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Campaign target audience is invalid' });
        }
        if (!(dto.startsAt instanceof Date) || !(dto.endsAt instanceof Date) || Number.isNaN(dto.startsAt.getTime()) || Number.isNaN(dto.endsAt.getTime()) || dto.endsAt <= dto.startsAt) {
            throw new common_1.BadRequestException({ code: ErrorCodes.INVALID_CAMPAIGN_DATES, message: 'End date must be after start date' });
        }
        let campaign = null;
        for (let attempt = 0; attempt < MAX_CAMPAIGN_ID_RETRIES; attempt++) {
            const count = await this.prisma.campaign.count();
            const campaignId = (0, id_generator_util_1.generateCampaignId)(count + 1 + attempt);
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
            }
            catch (err) {
                if (err instanceof client_1.Prisma.PrismaClientKnownRequestError && err.code === 'P2002' && attempt < MAX_CAMPAIGN_ID_RETRIES - 1) {
                    this.logger.warn(`Campaign ID collision on attempt ${attempt + 1}, retrying...`);
                    continue;
                }
                throw err;
            }
        }
        if (!campaign) {
            throw new common_1.BadRequestException({ code: ErrorCodes.INVALID_CAMPAIGN_DATES, message: 'Failed to generate unique campaign ID' });
        }
        this.auditLog.logAdminAction({
            adminId,
            action: client_1.AuditAction.ADMIN_ACTION,
            targetType: 'Campaign',
            targetId: campaign.campaignId,
            description: `Created campaign "${campaign.name}" (${campaign.campaignId})`,
            after: { name: campaign.name, type: campaign.type, startsAt: campaign.startsAt, endsAt: campaign.endsAt },
            ipAddress,
        });
        return this.formatCampaign(campaign);
    }
    async getCampaigns(page, limit, status) {
        const safePage = Math.max(1, Math.floor(page));
        const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 50);
        const skip = (safePage - 1) * safeLimit;
        const where = {};
        if (status)
            where.status = status;
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
    async getCampaign(campaignId) {
        const campaign = await this.prisma.campaign.findUnique({ where: { campaignId } });
        if (!campaign)
            throw new common_1.NotFoundException({ code: ErrorCodes.CAMPAIGN_NOT_FOUND, message: 'Campaign not found' });
        return this.formatCampaign(campaign);
    }
    async updateCampaign(campaignId, adminId, dto, ipAddress = 'unknown') {
        const campaign = await this.prisma.campaign.findUnique({ where: { campaignId } });
        if (!campaign)
            throw new common_1.NotFoundException({ code: ErrorCodes.CAMPAIGN_NOT_FOUND, message: 'Campaign not found' });
        if (dto.name !== undefined && (dto.name.trim().length < 3 || dto.name.trim().length > 100 || /[<>]/.test(dto.name))) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Campaign name must be 3–100 safe characters' });
        }
        if (dto.description !== undefined && (dto.description.trim().length > 1000 || /[<>]/.test(dto.description))) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Campaign description is invalid' });
        }
        const nextStartsAt = dto.startsAt ?? campaign.startsAt;
        const nextEndsAt = dto.endsAt ?? campaign.endsAt;
        if (nextEndsAt <= nextStartsAt) {
            throw new common_1.BadRequestException({ code: ErrorCodes.INVALID_CAMPAIGN_DATES, message: 'End date must be after start date' });
        }
        if (dto.maxRedemptions !== undefined && dto.maxRedemptions < campaign.currentRedemptions) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'maxRedemptions cannot be lower than current redemptions' });
        }
        if (dto.rolloutPercent !== undefined) {
            if (!Number.isInteger(dto.rolloutPercent) || dto.rolloutPercent < 0 || dto.rolloutPercent > 100) {
                throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'rolloutPercent must be between 0 and 100' });
            }
            const currentRollout = campaign.rolloutPercent;
            if (currentRollout !== null && currentRollout !== undefined && dto.rolloutPercent < currentRollout) {
                throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'rolloutPercent cannot be decreased once set' });
            }
        }
        const data = {};
        if (dto.name !== undefined)
            data.name = dto.name.trim();
        if (dto.description !== undefined)
            data.description = dto.description.trim();
        if (dto.startsAt)
            data.startsAt = dto.startsAt;
        if (dto.endsAt)
            data.endsAt = dto.endsAt;
        if (dto.maxRedemptions !== undefined)
            data.maxRedemptions = dto.maxRedemptions;
        if (dto.status)
            data.status = dto.status;
        if (dto.rolloutPercent !== undefined)
            data.rolloutPercent = dto.rolloutPercent;
        if (Object.keys(data).length === 0) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'At least one campaign field must be changed' });
        }
        const updated = await this.prisma.campaign.update({ where: { campaignId }, data });
        this.auditLog.logAdminAction({
            adminId,
            action: client_1.AuditAction.ADMIN_ACTION,
            targetType: 'Campaign',
            targetId: campaignId,
            description: `Updated campaign "${updated.name}" (${campaignId})`,
            before: { name: campaign.name, status: campaign.status },
            after: { ...data },
            ipAddress,
        });
        return this.formatCampaign(updated);
    }
    async deleteCampaign(campaignId, adminId, ipAddress = 'unknown') {
        const campaign = await this.prisma.campaign.findUnique({ where: { campaignId } });
        if (!campaign)
            throw new common_1.NotFoundException({ code: ErrorCodes.CAMPAIGN_NOT_FOUND, message: 'Campaign not found' });
        if (campaign.status === 'ACTIVE')
            throw new common_1.BadRequestException({ code: ErrorCodes.CAMPAIGN_ACTIVE, message: 'Cannot delete an active campaign' });
        await this.prisma.campaign.delete({ where: { campaignId } });
        this.auditLog.logAdminAction({
            adminId,
            action: client_1.AuditAction.ADMIN_ACTION,
            targetType: 'Campaign',
            targetId: campaignId,
            description: `Deleted campaign "${campaign.name}" (${campaignId})`,
            ipAddress,
        });
        return { message: 'Campaign deleted' };
    }
    formatCampaign(c) {
        return {
            id: c.id,
            campaignId: c.campaignId,
            name: c.name,
            description: c.description,
            type: c.type,
            status: c.status,
            startsAt: c.startsAt,
            endsAt: c.endsAt,
            discountValue: c.discountValue ? (0, bigint_util_1.safeBigIntToNumber)(c.discountValue) / 100 : null,
            discountPercent: c.discountPercent ? Number(c.discountPercent) : null,
            maxDiscount: c.maxDiscount ? (0, bigint_util_1.safeBigIntToNumber)(c.maxDiscount) / 100 : null,
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
};
exports.CampaignService = CampaignService;
exports.CampaignService = CampaignService = CampaignService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        audit_log_service_1.AuditLogService])
], CampaignService);
