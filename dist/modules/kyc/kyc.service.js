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
Object.defineProperty(exports, "__esModule", { value: true });
exports.KycService = void 0;
const common_1 = require("@nestjs/common");
const client_1 = require("@prisma/client");
const prisma_service_1 = require("../../prisma/prisma.service");
const audit_log_service_1 = require("../../common/services/audit-log.service");
const wallet_tx_serial_service_1 = require("../../common/services/wallet-tx-serial.service");
const id_generator_util_1 = require("../../common/utils/id-generator.util");
const crypto_util_1 = require("../../common/utils/crypto.util");
const pagination_dto_1 = require("../../common/dto/pagination.dto");
const ErrorCodes = __importStar(require("../../common/constants/error-codes"));
const client_2 = require("@prisma/client");
const upload_service_1 = require("../upload/upload.service");
let KycService = class KycService {
    constructor(prisma, serialService, auditLog, uploadService) {
        this.prisma = prisma;
        this.serialService = serialService;
        this.auditLog = auditLog;
        this.uploadService = uploadService;
    }
    async getNextKycSerial() {
        return this.serialService.getNextForPrefix('kyc_serial');
    }
    isRetryableDbError(error) {
        if (error instanceof client_1.Prisma.PrismaClientKnownRequestError && error.code === 'P2034')
            return true;
        if (error instanceof client_1.Prisma.PrismaClientUnknownRequestError) {
            const message = error.message.toLowerCase();
            return message.includes('40001') || message.includes('serialization') || message.includes('40p01') || message.includes('deadlock');
        }
        return false;
    }
    async withSerializableRetry(operation, label) {
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            try {
                return await operation();
            }
            catch (error) {
                if (!this.isRetryableDbError(error) || attempt === 3)
                    throw error;
                await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** (attempt - 1)));
            }
        }
        throw new Error(`${label} exhausted retry loop`);
    }
    async verifyKycFilesConfirmed(userId, ktpFileKey, selfieFileKey) {
        const [ktpConfirmed, selfieConfirmed] = await Promise.all([
            this.uploadService.isConfirmedUploadKey(userId, ktpFileKey),
            this.uploadService.isConfirmedUploadKey(userId, selfieFileKey),
        ]);
        if (!ktpConfirmed || !selfieConfirmed) {
            throw new common_1.BadRequestException({
                code: 'UPLOAD_NOT_CONFIRMED',
                message: 'Both KTP and selfie files must be confirmed via /upload/confirm before submitting KYC',
            });
        }
    }
    async canonicalizeLegacyNik(tx, nik, nikHash, userId) {
        const legacyArgonHash = await (0, crypto_util_1.argon2HashNik)(nik);
        const legacyRows = await tx.kycRequest.findMany({
            where: {
                status: { in: [client_1.KycStatus.PENDING, client_1.KycStatus.APPROVED, client_1.KycStatus.REVOKED] },
                ktpNumberHash: legacyArgonHash,
            },
            select: { id: true, userId: true, ktpNumberHash: true },
        });
        for (const row of legacyRows) {
            await tx.kycRequest.update({ where: { id: row.id }, data: { ktpNumberHash: nikHash } });
            return row.userId === userId ? null : row.userId;
        }
        return null;
    }
    async submit(userId, ktpFileKey, selfieFileKey, nik, ipAddress) {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { phoneVerified: true },
        });
        if (!user || !user.phoneVerified) {
            throw new common_1.ForbiddenException({
                code: ErrorCodes.PHONE_NOT_VERIFIED,
                message: 'Your phone number must be verified before submitting KYC',
            });
        }
        await this.verifyKycFilesConfirmed(userId, ktpFileKey, selfieFileKey);
        const latestKyc = await this.prisma.kycRequest.findFirst({
            where: { userId },
            orderBy: { createdAt: 'desc' },
            select: { status: true, reviewedAt: true },
        });
        if (latestKyc) {
            if (latestKyc.status === client_1.KycStatus.PENDING) {
                throw new common_1.BadRequestException({
                    code: ErrorCodes.KYC_ALREADY_PENDING,
                    message: 'You already have a pending KYC request',
                });
            }
            if (latestKyc.status === client_1.KycStatus.APPROVED) {
                throw new common_1.BadRequestException({
                    code: ErrorCodes.KYC_ALREADY_APPROVED,
                    message: 'Your KYC has already been approved',
                });
            }
            if (latestKyc.status === client_1.KycStatus.REVOKED) {
                throw new common_1.ForbiddenException({
                    code: ErrorCodes.KYC_REVOKED,
                    message: 'Your KYC verification has been revoked. Please contact support to resolve this.',
                });
            }
            if (latestKyc.status === client_1.KycStatus.REJECTED) {
                const COOLDOWN_HOURS = 24;
                const hoursSinceReview = latestKyc.reviewedAt
                    ? (Date.now() - latestKyc.reviewedAt.getTime()) / 3_600_000
                    : Infinity;
                if (hoursSinceReview < COOLDOWN_HOURS) {
                    const hoursRemaining = Math.ceil(COOLDOWN_HOURS - hoursSinceReview);
                    throw new common_1.BadRequestException({
                        code: ErrorCodes.KYC_COOLDOWN_ACTIVE,
                        message: `KYC resubmission available in ${hoursRemaining} hour(s). Please use /kyc/resubmit.`,
                    });
                }
                throw new common_1.BadRequestException({
                    code: ErrorCodes.KYC_USE_RESUBMIT,
                    message: 'Your previous KYC was rejected. Please use /kyc/resubmit to submit a new request.',
                });
            }
        }
        const nikHash = (0, crypto_util_1.hmacSHA256)(nik);
        const encryptedKtpUrl = await (0, crypto_util_1.encryptKycKtp)(ktpFileKey);
        const encryptedSelfieUrl = await (0, crypto_util_1.encryptKycSelfie)(selfieFileKey);
        const encryptedNik = await (0, crypto_util_1.encryptKycNik)(nik);
        const serial = await this.getNextKycSerial();
        const kycId = (0, id_generator_util_1.generateKycId)(serial);
        let kycRequest;
        try {
            kycRequest = await this.withSerializableRetry(() => this.prisma.$transaction(async (tx) => {
                const concurrentPending = await tx.kycRequest.findFirst({
                    where: { userId, status: client_1.KycStatus.PENDING },
                });
                if (concurrentPending) {
                    throw new common_1.BadRequestException({
                        code: ErrorCodes.KYC_ALREADY_PENDING,
                        message: 'You already have a pending KYC request',
                    });
                }
                const concurrentApproved = await tx.kycRequest.findFirst({
                    where: { userId, status: client_1.KycStatus.APPROVED },
                });
                if (concurrentApproved) {
                    throw new common_1.BadRequestException({
                        code: ErrorCodes.KYC_ALREADY_APPROVED,
                        message: 'Your KYC has already been approved',
                    });
                }
                const existingNik = await tx.kycRequest.findFirst({ where: { ktpNumberHash: nikHash, status: { in: [client_1.KycStatus.APPROVED, client_1.KycStatus.PENDING, client_1.KycStatus.REVOKED] } } });
                const legacyOwnerId = existingNik ? null : await this.canonicalizeLegacyNik(tx, nik, nikHash, userId);
                if ((existingNik && existingNik.userId !== userId) || (legacyOwnerId && legacyOwnerId !== userId)) {
                    throw new common_1.BadRequestException({
                        code: ErrorCodes.KYC_DUPLICATE_NIK,
                        message: 'This NIK has already been used for KYC verification',
                    });
                }
                const attemptCount = await tx.kycRequest.count({
                    where: { userId },
                });
                const MAX_KYC_ATTEMPTS = 10;
                if (attemptCount >= MAX_KYC_ATTEMPTS) {
                    throw new common_1.BadRequestException({
                        code: ErrorCodes.KYC_MAX_ATTEMPTS_REACHED,
                        message: 'Maximum KYC submission attempts reached. Please contact support.',
                    });
                }
                const created = await tx.kycRequest.create({
                    data: {
                        kycId,
                        userId,
                        ktpPhotoUrl: encryptedKtpUrl,
                        selfiePhotoUrl: encryptedSelfieUrl,
                        ktpNumber: encryptedNik,
                        ktpNumberHash: nikHash,
                        submittedIp: ipAddress,
                        attemptNumber: attemptCount + 1,
                    },
                });
                await tx.user.update({
                    where: { id: userId },
                    data: { kycStatus: client_1.KycStatus.PENDING },
                });
                return created;
            }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable }), 'KYC_SUBMIT_TX');
        }
        catch (error) {
            if (error instanceof client_1.Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
                throw new common_1.ConflictException({ code: ErrorCodes.KYC_DUPLICATE_NIK, message: 'This NIK has already been used for an active KYC request' });
            }
            throw error;
        }
        this.auditLog.logUserAction({
            userId,
            action: client_2.UserAuditAction.KYC_SUBMITTED,
            entityType: 'KycRequest',
            entityId: kycRequest.id,
            description: `KYC request submitted (${kycId})`,
            ipAddress,
        });
        return {
            kycId: kycRequest.kycId,
            status: kycRequest.status,
            attemptNumber: kycRequest.attemptNumber,
            createdAt: kycRequest.createdAt,
        };
    }
    async getStatus(userId) {
        const latestKyc = await this.prisma.kycRequest.findFirst({
            where: { userId },
            orderBy: { createdAt: 'desc' },
            select: {
                kycId: true,
                status: true,
                rejectionReason: true,
                attemptNumber: true,
                createdAt: true,
                reviewedAt: true,
            },
        });
        if (!latestKyc) {
            return {
                status: client_1.KycStatus.UNVERIFIED,
                latestRequest: null,
            };
        }
        return {
            status: latestKyc.status,
            latestRequest: latestKyc,
        };
    }
    async getHistory(userId, page, limit) {
        const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
        const safeLimit = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.floor(limit))) : 20;
        const skip = (safePage - 1) * safeLimit;
        const [data, total] = await Promise.all([
            this.prisma.kycRequest.findMany({
                where: { userId },
                orderBy: { createdAt: 'desc' },
                skip,
                take: safeLimit,
                select: {
                    kycId: true,
                    status: true,
                    rejectionReason: true,
                    attemptNumber: true,
                    createdAt: true,
                    reviewedAt: true,
                },
            }),
            this.prisma.kycRequest.count({ where: { userId } }),
        ]);
        return (0, pagination_dto_1.createPaginatedResponse)(data, total, safePage, safeLimit);
    }
    async resubmit(userId, ktpFileKey, selfieFileKey, nik, ipAddress) {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { phoneVerified: true },
        });
        if (!user || !user.phoneVerified) {
            throw new common_1.ForbiddenException({
                code: ErrorCodes.PHONE_NOT_VERIFIED,
                message: 'Your phone number must be verified before resubmitting KYC',
            });
        }
        const latestKyc = await this.prisma.kycRequest.findFirst({
            where: { userId },
            orderBy: { createdAt: 'desc' },
        });
        if (latestKyc && latestKyc.status === client_1.KycStatus.REVOKED) {
            throw new common_1.ForbiddenException({
                code: 'KYC_REVOKED',
                message: 'Your KYC verification has been revoked. Please contact support to resolve this.',
            });
        }
        if (!latestKyc || latestKyc.status !== client_1.KycStatus.REJECTED) {
            throw new common_1.BadRequestException({
                code: 'KYC_RESUBMIT_NOT_ALLOWED',
                message: 'KYC resubmission is only allowed after a rejection',
            });
        }
        const COOLDOWN_HOURS = 24;
        if (latestKyc.reviewedAt) {
            const hoursSinceReview = (Date.now() - latestKyc.reviewedAt.getTime()) / 3_600_000;
            if (hoursSinceReview < COOLDOWN_HOURS) {
                const hoursRemaining = Math.ceil(COOLDOWN_HOURS - hoursSinceReview);
                throw new common_1.BadRequestException({
                    code: ErrorCodes.KYC_COOLDOWN_ACTIVE,
                    message: `KYC resubmission available in ${hoursRemaining} hour(s)`,
                });
            }
        }
        await this.verifyKycFilesConfirmed(userId, ktpFileKey, selfieFileKey);
        const nikHash = (0, crypto_util_1.hmacSHA256)(nik);
        const encryptedKtpUrl = await (0, crypto_util_1.encryptKycKtp)(ktpFileKey);
        const encryptedSelfieUrl = await (0, crypto_util_1.encryptKycSelfie)(selfieFileKey);
        const encryptedNik = await (0, crypto_util_1.encryptKycNik)(nik);
        const resubmitSerial = await this.getNextKycSerial();
        const resubmitKycId = (0, id_generator_util_1.generateKycId)(resubmitSerial);
        let updated;
        try {
            updated = await this.withSerializableRetry(() => this.prisma.$transaction(async (tx) => {
                const attemptCount = await tx.kycRequest.count({ where: { userId } });
                const MAX_KYC_ATTEMPTS = 10;
                if (attemptCount >= MAX_KYC_ATTEMPTS) {
                    throw new common_1.BadRequestException({
                        code: ErrorCodes.KYC_MAX_ATTEMPTS_REACHED,
                        message: 'Maximum KYC submission attempts reached. Please contact support.',
                    });
                }
                const concurrentPending = await tx.kycRequest.findFirst({
                    where: { userId, status: client_1.KycStatus.PENDING },
                });
                if (concurrentPending) {
                    throw new common_1.BadRequestException({
                        code: ErrorCodes.KYC_ALREADY_PENDING,
                        message: 'You already have a pending KYC request',
                    });
                }
                const concurrentApproved = await tx.kycRequest.findFirst({
                    where: { userId, status: client_1.KycStatus.APPROVED },
                });
                if (concurrentApproved) {
                    throw new common_1.BadRequestException({
                        code: ErrorCodes.KYC_ALREADY_APPROVED,
                        message: 'Your KYC has already been approved',
                    });
                }
                const existingNikOwner = await tx.kycRequest.findFirst({ where: { ktpNumberHash: nikHash, status: { in: [client_1.KycStatus.APPROVED, client_1.KycStatus.PENDING, client_1.KycStatus.REVOKED] } } });
                const legacyOwnerId = existingNikOwner ? null : await this.canonicalizeLegacyNik(tx, nik, nikHash, userId);
                if ((existingNikOwner && existingNikOwner.userId !== userId) || (legacyOwnerId && legacyOwnerId !== userId)) {
                    throw new common_1.BadRequestException({
                        code: ErrorCodes.KYC_DUPLICATE_NIK,
                        message: 'This NIK has already been used for KYC verification',
                    });
                }
                const locked = await tx.kycRequest.findFirst({
                    where: { id: latestKyc.id, status: client_1.KycStatus.REJECTED },
                });
                if (!locked) {
                    throw new common_1.ConflictException({
                        code: 'KYC_STATE_CHANGED',
                        message: 'KYC status changed concurrently. Please reload and try again.',
                    });
                }
                const result = await tx.kycRequest.create({
                    data: {
                        kycId: resubmitKycId,
                        userId,
                        status: client_1.KycStatus.PENDING,
                        ktpPhotoUrl: encryptedKtpUrl,
                        selfiePhotoUrl: encryptedSelfieUrl,
                        ktpNumber: encryptedNik,
                        ktpNumberHash: nikHash,
                        submittedIp: ipAddress ?? null,
                        attemptNumber: attemptCount + 1,
                    },
                });
                await tx.user.update({
                    where: { id: userId },
                    data: { kycStatus: client_1.KycStatus.PENDING },
                });
                return result;
            }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable }), 'KYC_RESUBMIT_TX');
        }
        catch (error) {
            if (error instanceof client_1.Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
                throw new common_1.ConflictException({ code: ErrorCodes.KYC_DUPLICATE_NIK, message: 'This NIK has already been used for an active KYC request' });
            }
            throw error;
        }
        this.auditLog.logUserAction({
            userId,
            action: client_2.UserAuditAction.KYC_SUBMITTED,
            entityType: 'KycRequest',
            entityId: updated.id,
            description: 'User resubmitted KYC after rejection',
            ipAddress,
        });
        return { kycId: updated.kycId, status: updated.status };
    }
};
exports.KycService = KycService;
exports.KycService = KycService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        wallet_tx_serial_service_1.WalletTxSerialService,
        audit_log_service_1.AuditLogService,
        upload_service_1.UploadService])
], KycService);
