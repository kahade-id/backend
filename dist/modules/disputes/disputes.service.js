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
var DisputesService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.DisputesService = void 0;
const common_1 = require("@nestjs/common");
const crypto_1 = require("crypto");
const prisma_service_1 = require("../../prisma/prisma.service");
const wallet_tx_serial_service_1 = require("../../common/services/wallet-tx-serial.service");
const upload_service_1 = require("../upload/upload.service");
const audit_log_service_1 = require("../../common/services/audit-log.service");
const pagination_dto_1 = require("../../common/dto/pagination.dto");
const client_1 = require("@prisma/client");
const id_generator_util_1 = require("../../common/utils/id-generator.util");
const notification_category_map_1 = require("../notifications/notification-category.map");
const currency_util_1 = require("../../common/utils/currency.util");
const ErrorCodes = __importStar(require("../../common/constants/error-codes"));
const app_constants_1 = require("../../common/constants/app.constants");
const DISPUTE_EVIDENCE_ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
function dropFailedUrls(signedUrls, fileTypes) {
    const keptUrls = [];
    const keptTypes = [];
    signedUrls.forEach((url, i) => {
        if (url === null)
            return;
        keptUrls.push(url);
        keptTypes.push(fileTypes?.[i] ?? '');
    });
    return { fileUrls: keptUrls, fileTypes: keptTypes };
}
let DisputesService = DisputesService_1 = class DisputesService {
    constructor(prisma, serialService, uploadService, auditLog) {
        this.prisma = prisma;
        this.serialService = serialService;
        this.uploadService = uploadService;
        this.auditLog = auditLog;
        this.logger = new common_1.Logger(DisputesService_1.name);
    }
    isRetryableDbError(err) {
        if (err instanceof client_1.Prisma.PrismaClientKnownRequestError && err.code === 'P2034')
            return true;
        if (err instanceof client_1.Prisma.PrismaClientUnknownRequestError) {
            const msg = err.message.toLowerCase();
            if (msg.includes('40001') || msg.includes('serialization') || msg.includes('40p01') || msg.includes('deadlock'))
                return true;
        }
        return false;
    }
    async withSerializableRetry(operation, label) {
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                return await operation();
            }
            catch (error) {
                if (!this.isRetryableDbError(error) || attempt === 3)
                    throw error;
                this.logger.warn(`${label}_RETRY attempt=${attempt}/3`);
                await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, attempt - 1) + (0, crypto_1.randomInt)(0, 50)));
            }
        }
        throw new Error(`${label} exhausted retry loop`);
    }
    runRealtimeBestEffort(task, label) {
        try {
            task();
        }
        catch (error) {
            this.logger.warn(`${label} realtime side effect failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async cleanupEvidenceUploads(userId, fileKeys) {
        if (fileKeys.length === 0)
            return;
        try {
            await this.uploadService.cleanupFileKeys(userId, fileKeys);
        }
        catch (error) {
            this.logger.warn(`Dispute evidence cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async listMyDisputes(userId, page, limit) {
        const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
        const safeLimit = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.floor(limit))) : 20;
        const skip = (safePage - 1) * safeLimit;
        const where = {
            order: {
                OR: [{ buyerId: userId }, { sellerId: userId }],
            },
        };
        const [disputes, total] = await Promise.all([
            this.prisma.dispute.findMany({
                where,
                skip,
                take: safeLimit,
                orderBy: { createdAt: 'desc' },
                include: {
                    order: {
                        select: {
                            orderId: true,
                            title: true,
                            orderValue: true,
                            buyerId: true,
                            sellerId: true,
                        },
                    },
                },
            }),
            this.prisma.dispute.count({ where }),
        ]);
        const serialized = disputes.map((d) => ({
            ...d,
            order: { ...d.order, orderValue: (0, currency_util_1.toIdr)(d.order.orderValue) },
        }));
        return (0, pagination_dto_1.createPaginatedResponse)(serialized, total, safePage, safeLimit);
    }
    async listEvidence(disputeId, userId, page, limit) {
        const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
        const safeLimit = Number.isFinite(limit) ? Math.min(50, Math.max(1, Math.floor(limit))) : 20;
        const dispute = await this.prisma.dispute.findFirst({
            where: { OR: [{ id: disputeId }, { disputeId }] },
            include: {
                order: { select: { buyerId: true, sellerId: true } },
            },
        });
        if (!dispute) {
            throw new common_1.NotFoundException({ code: ErrorCodes.DISPUTE_NOT_FOUND, message: 'Dispute not found' });
        }
        if (dispute.order.buyerId !== userId && dispute.order.sellerId !== userId) {
            throw new common_1.ForbiddenException({ code: ErrorCodes.NOT_DISPUTE_PARTICIPANT, message: 'You are not a participant in this dispute' });
        }
        const where = { disputeId: dispute.id };
        const [data, total] = await Promise.all([
            this.prisma.disputeEvidence.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip: (safePage - 1) * safeLimit,
                take: safeLimit,
            }),
            this.prisma.disputeEvidence.count({ where }),
        ]);
        const EVIDENCE_URL_EXPIRY_SECONDS = 900;
        const signedData = await Promise.all(data.map(async (evidence) => {
            const signedUrls = await Promise.all(evidence.fileUrls.map((key) => this.uploadService.generateDownloadUrl(key, EVIDENCE_URL_EXPIRY_SECONDS).catch(() => null)));
            return { ...evidence, ...dropFailedUrls(signedUrls, evidence.fileTypes) };
        }));
        return (0, pagination_dto_1.createPaginatedResponse)(signedData, total, safePage, safeLimit);
    }
    async getDisputeDetail(disputeId, userId) {
        const dispute = await this.prisma.dispute.findFirst({
            where: { OR: [{ id: disputeId }, { disputeId }] },
            include: {
                order: {
                    select: {
                        orderId: true,
                        title: true,
                        orderValue: true,
                        buyerId: true,
                        sellerId: true,
                        status: true,
                        buyer: { select: { userId: true } },
                        seller: { select: { userId: true } },
                    },
                },
                evidences: { orderBy: { createdAt: 'asc' }, take: 50 },
                decision: {
                    select: {
                        id: true,
                        decisionType: true,
                        buyerAmount: true,
                        sellerAmount: true,
                        buyerPercent: true,
                        sellerPercent: true,
                        createdAt: true,
                    },
                },
                calls: { orderBy: { createdAt: 'desc' }, take: 5 },
            },
        });
        if (!dispute) {
            throw new common_1.NotFoundException({ code: ErrorCodes.DISPUTE_NOT_FOUND, message: 'Dispute not found' });
        }
        if (dispute.order.buyerId !== userId && dispute.order.sellerId !== userId) {
            throw new common_1.ForbiddenException({ code: ErrorCodes.NOT_DISPUTE_PARTICIPANT, message: 'You are not a participant in this dispute' });
        }
        const EVIDENCE_URL_EXPIRY_SECONDS = 900;
        const signedEvidences = await Promise.all((dispute.evidences ?? []).map(async (evidence) => {
            const signedUrls = await Promise.all(evidence.fileUrls.map((key) => this.uploadService.generateDownloadUrl(key, EVIDENCE_URL_EXPIRY_SECONDS).catch(() => null)));
            return { ...evidence, ...dropFailedUrls(signedUrls, evidence.fileTypes) };
        }));
        const { orderId: _orderId, buyerId: _buyerId, sellerId: _sellerId, ...disputeFields } = dispute;
        return {
            ...disputeFields,
            evidences: signedEvidences,
            order: {
                orderId: dispute.order.orderId,
                title: dispute.order.title,
                orderValue: (0, currency_util_1.toIdr)(dispute.order.orderValue),
                buyerId: dispute.order.buyer.userId,
                sellerId: dispute.order.seller.userId,
                status: dispute.order.status,
            },
        };
    }
    async submitEvidence(disputeId, userId, dto) {
        const dispute = await this.prisma.dispute.findFirst({
            where: { OR: [{ id: disputeId }, { disputeId }] },
            include: {
                order: { select: { buyerId: true, sellerId: true, status: true } },
            },
        });
        if (!dispute) {
            throw new common_1.NotFoundException({ code: ErrorCodes.DISPUTE_NOT_FOUND, message: 'Dispute not found' });
        }
        if (dispute.order.status !== client_1.OrderStatus.DISPUTED) {
            throw new common_1.BadRequestException({ code: 'ORDER_NOT_IN_DISPUTE', message: 'Evidence can only be submitted while the order is in disputed status' });
        }
        const isBuyer = dispute.order.buyerId === userId;
        const isSeller = dispute.order.sellerId === userId;
        if (!isBuyer && !isSeller) {
            throw new common_1.ForbiddenException({ code: ErrorCodes.NOT_DISPUTE_PARTICIPANT, message: 'You are not a participant in this dispute' });
        }
        const openForEvidence = [client_1.DisputeStatus.OPEN, client_1.DisputeStatus.WAITING_RESPONSE, client_1.DisputeStatus.ASSIGNED, client_1.DisputeStatus.UNDER_REVIEW];
        if (!openForEvidence.includes(dispute.status)) {
            throw new common_1.BadRequestException({ code: 'DISPUTE_CLOSED_FOR_EVIDENCE', message: 'Evidence can only be submitted when the dispute is OPEN, WAITING_RESPONSE, ASSIGNED, or UNDER_REVIEW' });
        }
        const normalizedDescription = dto.description.trim();
        if (!normalizedDescription || normalizedDescription.length > 2000) {
            throw new common_1.BadRequestException({ code: 'VALIDATION_ERROR', message: 'Evidence description must contain 1–2000 non-whitespace characters' });
        }
        if (dto.fileUrls.length < 1 || dto.fileUrls.length > 10 || dto.fileUrls.length !== dto.fileTypes.length) {
            throw new common_1.BadRequestException({ code: 'VALIDATION_ERROR', message: 'fileUrls and fileTypes must have the same length' });
        }
        const invalidTypes = dto.fileTypes.filter((t) => !DISPUTE_EVIDENCE_ALLOWED_TYPES.includes(t));
        if (invalidTypes.length > 0) {
            throw new common_1.BadRequestException({
                code: 'INVALID_FILE_TYPE',
                message: `Unsupported file type(s) for dispute evidence: ${invalidTypes.join(', ')}. Allowed: ${DISPUTE_EVIDENCE_ALLOWED_TYPES.join(', ')}`,
            });
        }
        const MAX_PER_FILE_SIZE_BYTES = 10 * 1024 * 1024;
        const MAX_TOTAL_EVIDENCE_SIZE_BYTES = 50 * 1024 * 1024;
        const fileResults = await this.uploadService.verifyEvidenceFileKeysBatch(userId, dto.fileUrls, dto.fileTypes);
        const validFileUrls = fileResults.filter((r) => r.status === 'ok').map((r) => r.fileKey);
        const validFileTypes = fileResults.filter((r) => r.status === 'ok').map((r) => r.fileType);
        if (validFileUrls.length === 0) {
            return {
                evidence: null,
                fileResults,
                summary: {
                    total: dto.fileUrls.length,
                    succeeded: 0,
                    failed: dto.fileUrls.length,
                },
            };
        }
        const fileSizeResults = await Promise.all(validFileUrls.map(async (key) => {
            try {
                return { key, size: await this.uploadService.getFileSize(key), error: null };
            }
            catch (err) {
                return { key, size: -1, error: err instanceof Error ? err.message : String(err) };
            }
        }));
        for (const result of fileSizeResults) {
            if (result.size < 0) {
                await this.cleanupEvidenceUploads(userId, validFileUrls);
                throw new common_1.BadRequestException({
                    code: 'FILE_SIZE_VERIFICATION_FAILED',
                    message: `Could not verify size of file "${result.key}". Upload may be incomplete or file is inaccessible.`,
                });
            }
            if (result.size > MAX_PER_FILE_SIZE_BYTES) {
                await this.cleanupEvidenceUploads(userId, validFileUrls);
                throw new common_1.BadRequestException({
                    code: 'FILE_TOO_LARGE',
                    message: `File "${result.key}" exceeds the per-file size limit of ${MAX_PER_FILE_SIZE_BYTES / (1024 * 1024)} MB`,
                });
            }
        }
        const fileSizes = fileSizeResults.map((r) => r.size);
        const submittedByRole = isBuyer ? 'BUYER' : 'SELLER';
        const MAX_EVIDENCE_PER_USER = 10;
        let evidence;
        try {
            evidence = await this.prisma.$transaction(async (tx) => {
                await tx.$queryRaw `SELECT id FROM disputes WHERE id = ${dispute.id} FOR UPDATE`;
                const fresh = await tx.dispute.findUnique({
                    where: { id: dispute.id },
                    select: { status: true, order: { select: { status: true } } },
                });
                if (!fresh) {
                    throw new common_1.NotFoundException({ code: ErrorCodes.DISPUTE_NOT_FOUND, message: 'Dispute disappeared during evidence submission' });
                }
                if (fresh.order.status !== client_1.OrderStatus.DISPUTED) {
                    throw new common_1.BadRequestException({ code: 'ORDER_NOT_IN_DISPUTE', message: 'Order is no longer in disputed status' });
                }
                if (!openForEvidence.includes(fresh.status)) {
                    throw new common_1.BadRequestException({ code: 'DISPUTE_CLOSED_FOR_EVIDENCE', message: 'Dispute closed for evidence submission while request was processing' });
                }
                const existingCount = await tx.disputeEvidence.count({
                    where: { disputeId: dispute.id, submittedByUserId: userId },
                });
                if (existingCount >= MAX_EVIDENCE_PER_USER) {
                    throw new common_1.BadRequestException({
                        code: 'MAX_EVIDENCE_REACHED',
                        message: `Maximum ${MAX_EVIDENCE_PER_USER} evidence items per party per dispute`,
                    });
                }
                const existingEvidence = await tx.disputeEvidence.findMany({
                    where: { disputeId: dispute.id },
                    select: { fileUrls: true },
                    take: 200,
                });
                const existingFileKeys = existingEvidence.flatMap((e) => e.fileUrls);
                const existingSizeResults = await Promise.all(existingFileKeys.map(async (key) => {
                    try {
                        return await this.uploadService.getFileSize(key);
                    }
                    catch {
                        return -1;
                    }
                }));
                const failedExistingCheck = existingSizeResults.some((s) => s < 0);
                if (failedExistingCheck) {
                    throw new common_1.BadRequestException({
                        code: 'FILE_SIZE_VERIFICATION_FAILED',
                        message: 'Could not verify size of existing evidence files. Please retry.',
                    });
                }
                const existingTotalSize = existingSizeResults.reduce((sum, s) => sum + s, 0);
                const newTotalSize = fileSizes.reduce((sum, s) => sum + s, 0);
                if (existingTotalSize + newTotalSize > MAX_TOTAL_EVIDENCE_SIZE_BYTES) {
                    throw new common_1.BadRequestException({
                        code: 'EVIDENCE_SIZE_LIMIT_EXCEEDED',
                        message: `Total evidence size would exceed the per-dispute limit of ${MAX_TOTAL_EVIDENCE_SIZE_BYTES / (1024 * 1024)} MB`,
                    });
                }
                return tx.disputeEvidence.create({
                    data: {
                        disputeId: dispute.id,
                        submittedByRole: submittedByRole,
                        submittedByUserId: userId,
                        description: normalizedDescription,
                        fileUrls: validFileUrls,
                        fileTypes: validFileTypes,
                    },
                });
            });
        }
        catch (err) {
            if (validFileUrls.length > 0) {
                this.logger.warn(`Evidence DB transaction failed for dispute ${dispute.id}. ` +
                    `Orphaned S3 keys may exist: ${validFileUrls.join(', ')}. ` +
                    `Schedule cleanup if these are not referenced elsewhere.`);
                this.uploadService.cleanupFileKeys(userId, validFileUrls).catch((delErr) => this.logger.warn(`Failed to clean up orphaned S3 keys: ${delErr?.message}`));
            }
            throw err;
        }
        return {
            evidence,
            fileResults,
            summary: {
                total: dto.fileUrls.length,
                succeeded: validFileUrls.length,
                failed: dto.fileUrls.length - validFileUrls.length,
            },
        };
    }
    async deleteEvidence(disputeId, evidenceId, userId) {
        const dispute = await this.prisma.dispute.findFirst({
            where: { OR: [{ id: disputeId }, { disputeId }] },
            include: {
                order: { select: { buyerId: true, sellerId: true, status: true } },
            },
        });
        if (!dispute) {
            throw new common_1.NotFoundException({ code: ErrorCodes.DISPUTE_NOT_FOUND, message: 'Dispute not found' });
        }
        const isBuyer = dispute.order.buyerId === userId;
        const isSeller = dispute.order.sellerId === userId;
        if (!isBuyer && !isSeller) {
            throw new common_1.ForbiddenException({ code: ErrorCodes.NOT_DISPUTE_PARTICIPANT, message: 'You are not a participant in this dispute' });
        }
        const openForDelete = [client_1.DisputeStatus.OPEN, client_1.DisputeStatus.WAITING_RESPONSE, client_1.DisputeStatus.ASSIGNED];
        if (!openForDelete.includes(dispute.status)) {
            throw new common_1.BadRequestException({ code: 'DISPUTE_CLOSED_FOR_EVIDENCE', message: 'Evidence can only be deleted when the dispute is open' });
        }
        const evidence = await this.prisma.disputeEvidence.findUnique({ where: { id: evidenceId } });
        if (!evidence || evidence.disputeId !== dispute.id) {
            throw new common_1.NotFoundException({ code: 'EVIDENCE_NOT_FOUND', message: 'Evidence not found' });
        }
        if (evidence.submittedByUserId !== userId) {
            throw new common_1.ForbiddenException({ code: 'NOT_EVIDENCE_OWNER', message: 'You can only delete your own evidence' });
        }
        await this.prisma.$transaction(async (tx) => {
            await tx.$queryRaw `SELECT id FROM disputes WHERE id = ${dispute.id} FOR UPDATE`;
            const fresh = await tx.dispute.findUnique({
                where: { id: dispute.id },
                select: { status: true },
            });
            if (!fresh) {
                throw new common_1.NotFoundException({ code: ErrorCodes.DISPUTE_NOT_FOUND, message: 'Dispute not found' });
            }
            if (!openForDelete.includes(fresh.status)) {
                throw new common_1.BadRequestException({
                    code: 'DISPUTE_CLOSED_FOR_EVIDENCE',
                    message: 'Evidence can only be deleted when the dispute is open',
                });
            }
            const deleted = await tx.disputeEvidence.deleteMany({
                where: { id: evidenceId, disputeId: dispute.id, submittedByUserId: userId },
            });
            if (deleted.count === 0) {
                throw new common_1.NotFoundException({ code: 'EVIDENCE_NOT_FOUND', message: 'Evidence not found' });
            }
        });
        this.auditLog.logUserAction({
            userId,
            action: client_1.UserAuditAction.DISPUTE_EVIDENCE_ADDED,
            entityType: 'DisputeEvidence',
            entityId: evidenceId,
            description: `User deleted evidence ${evidenceId} from dispute ${dispute.disputeId}`,
        });
        const fileKeys = evidence.fileUrls;
        if (fileKeys.length > 0) {
            this.uploadService.cleanupFileKeys(userId, fileKeys).catch((err) => this.logger.warn(`Failed to clean up S3 keys after evidence deletion: ${err?.message}`));
        }
        return { deleted: true };
    }
    async submitClaim(disputeId, userId, dto) {
        const normalizedClaim = dto.claim.trim();
        if (normalizedClaim.length < 20 || normalizedClaim.length > 5000) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Claim must contain 20–5000 non-whitespace characters' });
        }
        return this.withSerializableRetry(() => this.prisma.$transaction(async (tx) => {
            const dispute = await tx.dispute.findFirst({
                where: { OR: [{ id: disputeId }, { disputeId }] },
                include: {
                    order: { select: { id: true, buyerId: true, sellerId: true, status: true } },
                },
            });
            if (!dispute) {
                throw new common_1.NotFoundException({ code: ErrorCodes.DISPUTE_NOT_FOUND, message: 'Dispute not found' });
            }
            await tx.$queryRaw `SELECT id FROM disputes WHERE id = ${dispute.id} FOR UPDATE`;
            const freshDispute = await tx.dispute.findUnique({
                where: { id: dispute.id },
                include: { order: { select: { buyerId: true, sellerId: true, status: true } } },
            });
            if (!freshDispute) {
                throw new common_1.NotFoundException({ code: ErrorCodes.DISPUTE_NOT_FOUND, message: 'Dispute not found' });
            }
            if (freshDispute.order.status !== client_1.OrderStatus.DISPUTED) {
                throw new common_1.BadRequestException({ code: 'ORDER_NOT_IN_DISPUTE', message: 'Claims can only be submitted while the order is in disputed status' });
            }
            const isBuyer = freshDispute.order.buyerId === userId;
            const isSeller = freshDispute.order.sellerId === userId;
            if (!isBuyer && !isSeller) {
                throw new common_1.ForbiddenException({ code: ErrorCodes.NOT_DISPUTE_PARTICIPANT, message: 'You are not a participant in this dispute' });
            }
            const openForClaim = [client_1.DisputeStatus.OPEN, client_1.DisputeStatus.WAITING_RESPONSE];
            if (!openForClaim.includes(freshDispute.status)) {
                throw new common_1.BadRequestException({ code: 'DISPUTE_CLOSED_FOR_CLAIM', message: 'Claims can only be submitted when the dispute is OPEN or WAITING_RESPONSE' });
            }
            if (freshDispute.slaDeadlineAt && Date.now() >= freshDispute.slaDeadlineAt.getTime()) {
                throw new common_1.BadRequestException({ code: 'CLAIM_DEADLINE_PASSED', message: 'The claim submission deadline for this dispute has passed' });
            }
            const claimWhere = isBuyer
                ? { id: freshDispute.id, status: { in: openForClaim }, buyerClaimedAt: null, order: { status: client_1.OrderStatus.DISPUTED }, OR: [{ slaDeadlineAt: null }, { slaDeadlineAt: { gt: new Date() } }] }
                : { id: freshDispute.id, status: { in: openForClaim }, sellerClaimedAt: null, order: { status: client_1.OrderStatus.DISPUTED }, OR: [{ slaDeadlineAt: null }, { slaDeadlineAt: { gt: new Date() } }] };
            const claimData = isBuyer
                ? { buyerClaim: normalizedClaim, buyerClaimedAt: new Date() }
                : { sellerClaim: normalizedClaim, sellerClaimedAt: new Date() };
            const result = await tx.dispute.updateMany({
                where: claimWhere,
                data: claimData,
            });
            if (result.count === 0) {
                throw new common_1.BadRequestException({ code: 'CLAIM_ALREADY_SUBMITTED', message: 'A claim has already been submitted for your side of this dispute' });
            }
            const updated = await tx.dispute.findUnique({
                where: { id: freshDispute.id },
                select: {
                    disputeId: true,
                    buyerClaim: true,
                    sellerClaim: true,
                    buyerClaimedAt: true,
                    sellerClaimedAt: true,
                    status: true,
                },
            });
            return updated;
        }), 'SUBMIT_CLAIM_TX');
    }
    async submitDispute(orderId, userId, dto) {
        const normalizedClaim = dto.claim.trim();
        if (normalizedClaim.length < 20) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Claim must contain at least 20 non-whitespace characters' });
        }
        let validatedFileUrls;
        let validatedFileTypes;
        this.logger.log(`Dispute submission started: orderId=${orderId}, userId=${userId}`);
        const order = await this.prisma.order.findUnique({ where: { orderId } });
        if (!order)
            throw new common_1.NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
        if (order.buyerId !== userId && order.sellerId !== userId)
            throw new common_1.ForbiddenException({ code: ErrorCodes.NOT_ORDER_PARTICIPANT, message: 'Not authorized' });
        const isPostCompletionDispute = order.status === client_1.OrderStatus.COMPLETED
            && order.completedAt
            && (Date.now() - order.completedAt.getTime()) < app_constants_1.POST_COMPLETION_DISPUTE_WINDOW_HOURS * 60 * 60 * 1000;
        if (order.status !== client_1.OrderStatus.IN_DELIVERY && order.status !== client_1.OrderStatus.PROCESSING && !isPostCompletionDispute) {
            throw new common_1.BadRequestException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Cannot submit dispute at this stage' });
        }
        const existingDispute = await this.prisma.dispute.findUnique({ where: { orderId: order.id } });
        if (existingDispute) {
            throw new common_1.BadRequestException({ code: ErrorCodes.DISPUTE_ALREADY_EXISTS, message: 'A dispute already exists for this order' });
        }
        if (dto.fileUrls && dto.fileUrls.length > 0) {
            const MAX_EVIDENCE_FILES = 10;
            if (dto.fileUrls.length > MAX_EVIDENCE_FILES) {
                throw new common_1.BadRequestException({ code: 'VALIDATION_ERROR', message: `Maximum ${MAX_EVIDENCE_FILES} evidence files allowed` });
            }
            if (!dto.fileTypes || dto.fileTypes.length !== dto.fileUrls.length) {
                throw new common_1.BadRequestException({ code: 'VALIDATION_ERROR', message: 'fileUrls and fileTypes are both required and must have the same length' });
            }
            const fileResults = await this.uploadService.verifyEvidenceFileKeysBatch(userId, dto.fileUrls, dto.fileTypes);
            const failedFiles = fileResults.filter((result) => result.status !== 'ok');
            if (failedFiles.length > 0) {
                await this.cleanupEvidenceUploads(userId, dto.fileUrls);
                throw new common_1.BadRequestException({
                    code: ErrorCodes.UPLOAD_NOT_CONFIRMED,
                    message: 'Every opening-dispute evidence file must be a confirmed, accessible upload with a matching MIME type',
                });
            }
            validatedFileUrls = fileResults.map((result) => result.fileKey);
            validatedFileTypes = fileResults.map((result) => result.fileType);
        }
        const serial = await this.serialService.getNextForPrefix('dispute_serial');
        const disputeId = (0, id_generator_util_1.generateDisputeId)(serial);
        let freezeSerial = null;
        const nextFreezeSerial = async () => {
            if (freezeSerial === null)
                freezeSerial = await this.serialService.getNext();
            return freezeSerial;
        };
        const MAX_RETRIES = 3;
        let dispute;
        let lastError = null;
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                dispute = await this.runSubmitDisputeTx(order, userId, { claim: normalizedClaim, fileUrls: validatedFileUrls, fileTypes: validatedFileTypes }, disputeId, nextFreezeSerial);
                lastError = null;
                break;
            }
            catch (err) {
                lastError = err;
                if (!this.isRetryableDbError(err) || attempt === MAX_RETRIES) {
                    this.logger.error(`DISPUTE_SUBMIT_TX_FAILED orderId=${orderId} attempt=${attempt}/${MAX_RETRIES}`, err instanceof Error ? err.stack : String(err));
                    break;
                }
                this.logger.warn(`DISPUTE_SUBMIT_TX_RETRY orderId=${orderId} attempt=${attempt}/${MAX_RETRIES}`);
                const jitter = (0, crypto_1.randomInt)(0, 50);
                await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, attempt - 1) + jitter));
            }
        }
        if (lastError) {
            await this.cleanupEvidenceUploads(userId, validatedFileUrls ?? []);
            if (lastError instanceof common_1.BadRequestException || lastError instanceof common_1.ForbiddenException || lastError instanceof common_1.NotFoundException) {
                throw lastError;
            }
            const prismaErr = lastError;
            if (prismaErr?.code === 'P2002') {
                throw new common_1.BadRequestException({
                    code: ErrorCodes.DISPUTE_ALREADY_EXISTS,
                    message: 'A dispute already exists for this order',
                });
            }
            throw lastError;
        }
        const createdDispute = dispute;
        const counterpartId = userId === order.buyerId ? order.sellerId : order.buyerId;
        this.prisma.notification
            .create({
            data: {
                notifId: (0, id_generator_util_1.generateNotifId)(), userId: counterpartId,
                type: client_1.NotificationType.DISPUTE_SUBMITTED, category: (0, notification_category_map_1.getCategoryForType)(client_1.NotificationType.DISPUTE_SUBMITTED),
                title: 'Dispute Filed', body: `A dispute has been filed for order ${order.orderId}. Please review the dispute details.`, isRead: false,
            },
        })
            .catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
        this.runRealtimeBestEffort(() => this.prisma.emitNotificationCreated({ userId: counterpartId, title: 'Dispute Filed', body: `Dispute filed for order ${order.orderId}`, data: { type: 'DISPUTE_SUBMITTED', disputeId: createdDispute.id } }), `SUBMIT_DISPUTE_NOTIFICATION orderId=${order.orderId}`);
        this.logger.log(`Dispute created: disputeId=${createdDispute.disputeId}, orderId=${orderId}, initiator=${userId}`);
        return { disputeId: createdDispute.disputeId, status: 'OPEN' };
    }
    async runSubmitDisputeTx(order, userId, dto, disputeId, nextFreezeSerial) {
        return this.prisma.$transaction(async (tx) => {
            const existingDispute = await tx.dispute.findUnique({ where: { orderId: order.id } });
            if (existingDispute) {
                throw new common_1.BadRequestException({
                    code: ErrorCodes.DISPUTE_ALREADY_EXISTS,
                    message: 'A dispute already exists for this order',
                });
            }
            const freshOrder = await tx.order.findUnique({ where: { id: order.id } });
            if (!freshOrder) {
                throw new common_1.BadRequestException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Cannot submit dispute at this stage' });
            }
            const freshIsPostCompletion = freshOrder.status === client_1.OrderStatus.COMPLETED
                && freshOrder.completedAt
                && (Date.now() - freshOrder.completedAt.getTime()) < app_constants_1.POST_COMPLETION_DISPUTE_WINDOW_HOURS * 60 * 60 * 1000;
            if (freshOrder.status !== client_1.OrderStatus.IN_DELIVERY && freshOrder.status !== client_1.OrderStatus.PROCESSING && !freshIsPostCompletion) {
                throw new common_1.BadRequestException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Cannot submit dispute at this stage' });
            }
            const initiatedBy = userId === order.buyerId ? client_1.DisputeInitiator.BUYER : client_1.DisputeInitiator.SELLER;
            const isBuyerInitiator = userId === order.buyerId;
            const now = new Date();
            const slaDeadlineAt = new Date(now.getTime() + app_constants_1.DISPUTE_SLA_HOURS * 60 * 60 * 1000);
            const newDispute = await tx.dispute.create({
                data: {
                    disputeId,
                    orderId: order.id,
                    initiatorUserId: userId,
                    initiatedBy,
                    buyerClaim: isBuyerInitiator ? dto.claim.trim() : undefined,
                    sellerClaim: !isBuyerInitiator ? dto.claim.trim() : undefined,
                    buyerClaimedAt: isBuyerInitiator ? now : undefined,
                    sellerClaimedAt: !isBuyerInitiator ? now : undefined,
                    status: client_1.DisputeStatus.OPEN,
                    slaHours: app_constants_1.DISPUTE_SLA_HOURS,
                    slaDeadlineAt,
                },
            });
            if (dto.fileUrls && dto.fileUrls.length > 0) {
                if (!dto.fileTypes || dto.fileTypes.length !== dto.fileUrls.length) {
                    throw new common_1.BadRequestException({ code: 'VALIDATION_ERROR', message: 'Validated evidence MIME types are required' });
                }
                const submittedByRole = userId === order.buyerId ? client_1.ActorType.BUYER : client_1.ActorType.SELLER;
                await tx.disputeEvidence.create({
                    data: {
                        disputeId: newDispute.id,
                        submittedByRole,
                        submittedByUserId: userId,
                        fileUrls: dto.fileUrls,
                        fileTypes: dto.fileTypes,
                        description: dto.claim.trim(),
                    },
                });
            }
            await tx.$queryRaw `SELECT id FROM orders WHERE id = ${order.id} FOR UPDATE`;
            const allowedFromStatuses = freshIsPostCompletion
                ? [client_1.OrderStatus.COMPLETED]
                : [client_1.OrderStatus.IN_DELIVERY, client_1.OrderStatus.PROCESSING];
            const orderUpdated = await tx.order.updateMany({
                where: {
                    id: order.id,
                    status: { in: allowedFromStatuses },
                },
                data: { status: client_1.OrderStatus.DISPUTED, disputedAt: now },
            });
            if (orderUpdated.count === 0) {
                throw new common_1.BadRequestException({
                    code: ErrorCodes.INVALID_ORDER_STATUS,
                    message: 'Cannot submit dispute at this stage',
                });
            }
            await tx.orderStatusHistory.create({
                data: {
                    orderId: order.id,
                    fromStatus: freshOrder.status,
                    toStatus: client_1.OrderStatus.DISPUTED,
                    changedBy: userId,
                    changedByType: userId === order.buyerId ? client_1.ActorType.BUYER : client_1.ActorType.SELLER,
                    reason: `Dispute submitted: ${dto.claim.slice(0, 200)}`,
                },
            });
            if (!freshIsPostCompletion) {
                const activeEscrowLock = await tx.walletTransaction.findFirst({
                    where: { orderId: freshOrder.id, type: client_1.WalletTransactionType.ORDER_LOCK, status: client_1.WalletTransactionStatus.SUCCESS },
                    select: { id: true, amount: true },
                });
                if (!activeEscrowLock || activeEscrowLock.amount !== freshOrder.buyerPayAmount) {
                    throw new common_1.ConflictException({
                        code: 'ESCROW_LOCK_MISSING',
                        message: 'This order has no matching escrow lock. The dispute was not opened; manual reconciliation is required.',
                    });
                }
            }
            if (freshIsPostCompletion) {
                const freezeAmount = freshOrder.sellerReceiveAmount;
                const sellerWalletLookup = await tx.wallet.findUnique({
                    where: { userId: freshOrder.sellerId },
                    select: { id: true },
                });
                if (!sellerWalletLookup) {
                    throw new common_1.ConflictException({ code: 'POST_COMPLETION_FREEZE_FAILED', message: 'Seller wallet is unavailable; dispute was not opened and funds remain in the completed state.' });
                }
                await tx.$queryRaw `SELECT id FROM wallets WHERE id = ${sellerWalletLookup.id} FOR UPDATE`;
                const sellerWallet = await tx.wallet.findUnique({ where: { id: sellerWalletLookup.id } });
                if (!sellerWallet || sellerWallet.isLocked || sellerWallet.availableBalance < freezeAmount) {
                    throw new common_1.ConflictException({ code: 'POST_COMPLETION_FREEZE_FAILED', message: 'Seller funds cannot be secured for this post-completion dispute. Please contact support.' });
                }
                const freezeUpdated = await tx.wallet.updateMany({
                    where: { id: sellerWallet.id, version: sellerWallet.version, availableBalance: { gte: freezeAmount }, isLocked: false },
                    data: {
                        availableBalance: { decrement: freezeAmount },
                        escrowBalance: { increment: freezeAmount },
                        version: { increment: 1 },
                    },
                });
                if (freezeUpdated.count === 0) {
                    throw new common_1.ConflictException({ code: 'POST_COMPLETION_FREEZE_FAILED', message: 'Seller funds changed concurrently; dispute was not opened. Please retry.' });
                }
                const freezeTxSerial = await nextFreezeSerial();
                const freezeTxId = (0, id_generator_util_1.generateWalletTxId)(freezeTxSerial);
                await tx.walletTransaction.create({
                    data: {
                        txId: freezeTxId,
                        walletId: sellerWallet.id,
                        type: client_1.WalletTransactionType.ORDER_LOCK,
                        status: client_1.WalletTransactionStatus.SUCCESS,
                        amount: freezeAmount,
                        balanceBefore: sellerWallet.availableBalance,
                        balanceAfter: sellerWallet.availableBalance - freezeAmount,
                        orderId: freshOrder.id,
                        description: `Post-completion dispute freeze for order ${freshOrder.orderId}`,
                    },
                });
                this.logger.log(`POST_COMPLETION_FREEZE seller=${freshOrder.sellerId} order=${freshOrder.orderId} amount=${freezeAmount}`);
            }
            await tx.user.update({
                where: { id: userId },
                data: { totalOrdersDisputed: { increment: 1 } },
            });
            return newDispute;
        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable });
    }
};
exports.DisputesService = DisputesService;
exports.DisputesService = DisputesService = DisputesService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        wallet_tx_serial_service_1.WalletTxSerialService,
        upload_service_1.UploadService,
        audit_log_service_1.AuditLogService])
], DisputesService);
