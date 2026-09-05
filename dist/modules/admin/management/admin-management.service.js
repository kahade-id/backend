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
exports.AdminManagementService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../../prisma/prisma.service");
const audit_log_service_1 = require("../../../common/services/audit-log.service");
const redis_service_1 = require("../../../redis/redis.service");
const pagination_dto_1 = require("../../../common/dto/pagination.dto");
const client_1 = require("@prisma/client");
const ErrorCodes = __importStar(require("../../../common/constants/error-codes"));
const crypto_util_1 = require("../../../common/utils/crypto.util");
const app_constants_1 = require("../../../common/constants/app.constants");
const ADMIN_ACCESS_TOKEN_TTL_SECONDS = 2 * 60 * 60;
const MAX_ADMIN_PAGE = 100_000;
let AdminManagementService = class AdminManagementService {
    constructor(prisma, auditLog, redis) {
        this.prisma = prisma;
        this.auditLog = auditLog;
        this.redis = redis;
    }
    async listAdmins(page, limit, search) {
        const safeLimit = Math.min(limit, 100);
        const safePage = Math.min(Math.max(page, 1), MAX_ADMIN_PAGE);
        const where = {
            deletedAt: null,
            ...(search
                ? {
                    OR: [
                        { fullName: { contains: search, mode: 'insensitive' } },
                        { email: { contains: search, mode: 'insensitive' } },
                        { adminId: { contains: search, mode: 'insensitive' } },
                    ],
                }
                : {}),
        };
        const [admins, total] = await Promise.all([
            this.prisma.adminUser.findMany({
                where,
                select: {
                    id: true,
                    adminId: true,
                    fullName: true,
                    email: true,
                    role: true,
                    isActive: true,
                    isMfaEnabled: true,
                    lastLoginAt: true,
                    lastLoginIp: true,
                    createdBy: true,
                    createdAt: true,
                    updatedAt: true,
                },
                orderBy: { createdAt: 'desc' },
                skip: (safePage - 1) * safeLimit,
                take: safeLimit,
            }),
            this.prisma.adminUser.count({ where }),
        ]);
        return (0, pagination_dto_1.createPaginatedResponse)(admins, total, safePage, safeLimit);
    }
    async getAdmin(adminId) {
        const admin = await this.prisma.adminUser.findFirst({
            where: { id: adminId, deletedAt: null },
            select: {
                id: true,
                adminId: true,
                fullName: true,
                email: true,
                role: true,
                isActive: true,
                isMfaEnabled: true,
                lastLoginAt: true,
                lastLoginIp: true,
                failedLoginAttempts: true,
                lockedUntil: true,
                createdBy: true,
                createdAt: true,
                updatedAt: true,
            },
        });
        if (!admin) {
            throw new common_1.NotFoundException({ code: ErrorCodes.ADMIN_NOT_FOUND, message: 'Admin not found' });
        }
        return admin;
    }
    async createAdmin(dto, creatorId, ipAddress) {
        const normalizedEmail = dto.email.toLowerCase();
        const existing = await this.prisma.adminUser.findUnique({ where: { email: normalizedEmail } });
        if (existing) {
            throw new common_1.ConflictException({ code: ErrorCodes.EMAIL_ALREADY_EXISTS, message: 'Email already registered as admin' });
        }
        const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()\-_=+{};:,<.>/?\\|'"`~[\]@])/;
        if (dto.password.length < 12) {
            throw new common_1.BadRequestException({ code: ErrorCodes.PASSWORD_TOO_WEAK, message: 'Password must be at least 12 characters' });
        }
        if (!passwordRegex.test(dto.password)) {
            throw new common_1.BadRequestException({ code: ErrorCodes.PASSWORD_TOO_WEAK, message: 'Password must contain uppercase, lowercase, digit, and special character' });
        }
        const hashedPassword = await (0, crypto_util_1.bcryptHash)(dto.password, app_constants_1.BCRYPT_ROUNDS_ADMIN);
        const { nanoid } = await Promise.resolve().then(() => __importStar(require('nanoid')));
        const adminId = `ADMIN-${nanoid(12)}`;
        const admin = await this.prisma.adminUser.create({
            data: {
                adminId,
                fullName: dto.fullName,
                email: normalizedEmail,
                password: hashedPassword,
                role: dto.role,
                isActive: true,
                createdBy: creatorId,
            },
            select: {
                id: true,
                adminId: true,
                fullName: true,
                email: true,
                role: true,
                isActive: true,
                isMfaEnabled: true,
                createdAt: true,
            },
        });
        this.auditLog.logAdminAction({
            adminId: creatorId,
            action: client_1.AuditAction.ADMIN_ACTION,
            targetType: 'AdminUser',
            targetId: admin.id,
            description: `Created admin "${dto.fullName}" (${normalizedEmail}) with role ${dto.role}`,
            ipAddress,
        });
        return admin;
    }
    async updateAdmin(targetId, dto, updaterId, ipAddress) {
        const admin = await this.prisma.adminUser.findFirst({ where: { id: targetId, deletedAt: null } });
        if (!admin) {
            throw new common_1.NotFoundException({ code: ErrorCodes.ADMIN_NOT_FOUND, message: 'Admin not found' });
        }
        if (targetId === updaterId && dto.role !== undefined && dto.role !== admin.role) {
            throw new common_1.ForbiddenException({ code: 'CANNOT_CHANGE_OWN_ROLE', message: 'Cannot change your own role' });
        }
        if (targetId === updaterId && dto.isActive === false) {
            throw new common_1.ForbiddenException({ code: 'CANNOT_DEACTIVATE_SELF', message: 'Cannot deactivate your own account' });
        }
        const accessStateChanged = (dto.role !== undefined && dto.role !== admin.role)
            || (dto.isActive !== undefined && dto.isActive !== admin.isActive);
        if (admin.role === 'SUPER_ADMIN' && admin.isActive && accessStateChanged) {
            const activeSuperAdmins = await this.prisma.adminUser.count({ where: { role: 'SUPER_ADMIN', isActive: true, deletedAt: null } });
            if (activeSuperAdmins <= 1) {
                throw new common_1.ForbiddenException({ code: 'LAST_SUPER_ADMIN', message: 'At least one active super admin must remain.' });
            }
        }
        const changes = [];
        if (dto.fullName !== undefined && dto.fullName !== admin.fullName)
            changes.push(`name: "${admin.fullName}" → "${dto.fullName}"`);
        if (dto.role !== undefined && dto.role !== admin.role)
            changes.push(`role: ${admin.role} → ${dto.role}`);
        if (dto.isActive !== undefined && dto.isActive !== admin.isActive)
            changes.push(`isActive: ${admin.isActive} → ${dto.isActive}`);
        const updated = await this.prisma.adminUser.update({
            where: { id: targetId },
            data: {
                ...(dto.fullName !== undefined && { fullName: dto.fullName }),
                ...(dto.role !== undefined && { role: dto.role }),
                ...(dto.isActive !== undefined && { isActive: dto.isActive }),
            },
            select: {
                id: true,
                adminId: true,
                fullName: true,
                email: true,
                role: true,
                isActive: true,
                isMfaEnabled: true,
                lastLoginAt: true,
                createdAt: true,
                updatedAt: true,
            },
        });
        if (changes.length > 0) {
            this.auditLog.logAdminAction({
                adminId: updaterId,
                action: client_1.AuditAction.ADMIN_ACTION,
                targetType: 'AdminUser',
                targetId: admin.id,
                description: `Updated admin "${admin.fullName}" (${admin.adminId}): ${changes.join(', ')}`,
                before: { fullName: admin.fullName, role: admin.role, isActive: admin.isActive },
                after: { fullName: updated.fullName, role: updated.role, isActive: updated.isActive },
                ipAddress,
            });
        }
        if (accessStateChanged) {
            await this.redis.setex(`admin_revoked:${targetId}`, ADMIN_ACCESS_TOKEN_TTL_SECONDS, String(Math.floor(Date.now() / 1000)), { throwOnError: true });
        }
        return updated;
    }
    async resetAdmin2fa(targetId, updaterId, ipAddress) {
        const admin = await this.prisma.adminUser.findFirst({ where: { id: targetId, deletedAt: null } });
        if (!admin) {
            throw new common_1.NotFoundException({ code: ErrorCodes.ADMIN_NOT_FOUND, message: 'Admin not found' });
        }
        if (targetId === updaterId) {
            throw new common_1.ForbiddenException({ code: 'CANNOT_RESET_OWN_2FA', message: 'Cannot reset your own 2FA' });
        }
        if (!admin.isMfaEnabled && !admin.mfaSecret) {
            throw new common_1.ConflictException({ code: 'MFA_NOT_ENABLED', message: '2FA is not enabled for this admin' });
        }
        await this.prisma.adminUser.update({
            where: { id: targetId },
            data: { isMfaEnabled: false, mfaSecret: null },
        });
        await this.redis.setex(`admin_revoked:${targetId}`, ADMIN_ACCESS_TOKEN_TTL_SECONDS, String(Math.floor(Date.now() / 1000)), { throwOnError: true });
        this.auditLog.logAdminAction({
            adminId: updaterId,
            action: client_1.AuditAction.ADMIN_ACTION,
            targetType: 'AdminUser',
            targetId: admin.id,
            description: `Reset 2FA for admin "${admin.fullName}" (${admin.adminId})`,
            ipAddress,
        });
        return { message: '2FA reset successfully' };
    }
    async unlockAdmin(targetId, updaterId, ipAddress) {
        const admin = await this.prisma.adminUser.findFirst({ where: { id: targetId, deletedAt: null } });
        if (!admin) {
            throw new common_1.NotFoundException({ code: ErrorCodes.ADMIN_NOT_FOUND, message: 'Admin not found' });
        }
        if (!admin.lockedUntil && admin.failedLoginAttempts === 0) {
            throw new common_1.ConflictException({ code: 'NOT_LOCKED', message: 'Admin account is not locked' });
        }
        await this.prisma.adminUser.update({
            where: { id: targetId },
            data: { lockedUntil: null, failedLoginAttempts: 0 },
        });
        await this.redis.setex(`admin_revoked:${targetId}`, ADMIN_ACCESS_TOKEN_TTL_SECONDS, String(Math.floor(Date.now() / 1000)), { throwOnError: true });
        this.auditLog.logAdminAction({
            adminId: updaterId,
            action: client_1.AuditAction.ADMIN_ACTION,
            targetType: 'AdminUser',
            targetId: admin.id,
            description: `Unlocked admin "${admin.fullName}" (${admin.adminId})`,
            ipAddress,
        });
        return { message: 'Admin account unlocked successfully' };
    }
    async deleteAdmin(targetId, deleterId, ipAddress) {
        if (targetId === deleterId) {
            throw new common_1.ForbiddenException({ code: 'CANNOT_DELETE_SELF', message: 'Cannot delete your own account' });
        }
        const admin = await this.prisma.adminUser.findFirst({ where: { id: targetId, deletedAt: null } });
        if (!admin) {
            throw new common_1.NotFoundException({ code: ErrorCodes.ADMIN_NOT_FOUND, message: 'Admin not found' });
        }
        if (admin.role === 'SUPER_ADMIN' && admin.isActive) {
            const activeSuperAdmins = await this.prisma.adminUser.count({ where: { role: 'SUPER_ADMIN', isActive: true, deletedAt: null } });
            if (activeSuperAdmins <= 1) {
                throw new common_1.ForbiddenException({ code: 'LAST_SUPER_ADMIN', message: 'At least one active super admin must remain.' });
            }
        }
        await this.prisma.adminUser.update({
            where: { id: targetId },
            data: { deletedAt: new Date(), isActive: false },
        });
        await this.redis.setex(`admin_revoked:${targetId}`, ADMIN_ACCESS_TOKEN_TTL_SECONDS, String(Math.floor(Date.now() / 1000)), { throwOnError: true });
        this.auditLog.logAdminAction({
            adminId: deleterId,
            action: client_1.AuditAction.ADMIN_ACTION,
            targetType: 'AdminUser',
            targetId: admin.id,
            description: `Soft-deleted admin "${admin.fullName}" (${admin.adminId})`,
            ipAddress,
        });
        return { message: 'Admin deleted successfully' };
    }
};
exports.AdminManagementService = AdminManagementService;
exports.AdminManagementService = AdminManagementService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        audit_log_service_1.AuditLogService,
        redis_service_1.RedisService])
], AdminManagementService);
