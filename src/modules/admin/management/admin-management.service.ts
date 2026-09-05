import { Injectable, NotFoundException, ConflictException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { RedisService } from '../../../redis/redis.service';
import { CreateAdminDto } from './dto/create-admin.dto';
import { UpdateAdminDto } from './dto/update-admin.dto';
import { createPaginatedResponse } from '../../../common/dto/pagination.dto';
import { AuditAction } from '@prisma/client';
import * as ErrorCodes from '../../../common/constants/error-codes';
import { bcryptHash } from '../../../common/utils/crypto.util';
import { BCRYPT_ROUNDS_ADMIN } from '../../../common/constants/app.constants';
// jwt.config clamps admin access tokens to at most two hours.
// Keep revocation markers alive for that full bound so a revoked token cannot
// become usable merely because the marker expired before the token.
const ADMIN_ACCESS_TOKEN_TTL_SECONDS = 2 * 60 * 60;
const MAX_ADMIN_PAGE = 100_000;

@Injectable()
export class AdminManagementService {
  constructor(
    private prisma: PrismaService,
    private auditLog: AuditLogService,
    private redis: RedisService,
  ) {}

  async listAdmins(page: number, limit: number, search?: string): Promise<object> {
    const safeLimit = Math.min(limit, 100);
    const safePage = Math.min(Math.max(page, 1), MAX_ADMIN_PAGE);
    const where = {
      deletedAt: null,
      ...(search
        ? {
            OR: [
              { fullName: { contains: search, mode: 'insensitive' as const } },
              { email: { contains: search, mode: 'insensitive' as const } },
              { adminId: { contains: search, mode: 'insensitive' as const } },
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

    return createPaginatedResponse(admins, total, safePage, safeLimit);
  }

  async getAdmin(adminId: string): Promise<object> {
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
      throw new NotFoundException({ code: ErrorCodes.ADMIN_NOT_FOUND, message: 'Admin not found' });
    }
    return admin;
  }

  async createAdmin(dto: CreateAdminDto, creatorId: string, ipAddress: string): Promise<object> {
    const normalizedEmail = dto.email.toLowerCase();
    const existing = await this.prisma.adminUser.findUnique({ where: { email: normalizedEmail } });
    if (existing) {
      throw new ConflictException({ code: ErrorCodes.EMAIL_ALREADY_EXISTS, message: 'Email already registered as admin' });
    }

    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()\-_=+{};:,<.>/?\\|'"`~[\]@])/;
    if (dto.password.length < 12) {
      throw new BadRequestException({ code: ErrorCodes.PASSWORD_TOO_WEAK, message: 'Password must be at least 12 characters' });
    }
    if (!passwordRegex.test(dto.password)) {
      throw new BadRequestException({ code: ErrorCodes.PASSWORD_TOO_WEAK, message: 'Password must contain uppercase, lowercase, digit, and special character' });
    }

    const hashedPassword = await bcryptHash(dto.password, BCRYPT_ROUNDS_ADMIN);
    const { nanoid } = await import('nanoid');
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
      action: AuditAction.ADMIN_ACTION,
      targetType: 'AdminUser',
      targetId: admin.id,
      description: `Created admin "${dto.fullName}" (${normalizedEmail}) with role ${dto.role}`,
      ipAddress,
    });

    return admin;
  }

  async updateAdmin(targetId: string, dto: UpdateAdminDto, updaterId: string, ipAddress: string): Promise<object> {
    const admin = await this.prisma.adminUser.findFirst({ where: { id: targetId, deletedAt: null } });
    if (!admin) {
      throw new NotFoundException({ code: ErrorCodes.ADMIN_NOT_FOUND, message: 'Admin not found' });
    }

    if (targetId === updaterId && dto.role !== undefined && dto.role !== admin.role) {
      throw new ForbiddenException({ code: 'CANNOT_CHANGE_OWN_ROLE', message: 'Cannot change your own role' });
    }
    if (targetId === updaterId && dto.isActive === false) {
      throw new ForbiddenException({ code: 'CANNOT_DEACTIVATE_SELF', message: 'Cannot deactivate your own account' });
    }

    const accessStateChanged =
      (dto.role !== undefined && dto.role !== admin.role)
      || (dto.isActive !== undefined && dto.isActive !== admin.isActive);
    if (admin.role === 'SUPER_ADMIN' && admin.isActive && accessStateChanged) {
      const activeSuperAdmins = await this.prisma.adminUser.count({ where: { role: 'SUPER_ADMIN', isActive: true, deletedAt: null } });
      if (activeSuperAdmins <= 1) {
        throw new ForbiddenException({ code: 'LAST_SUPER_ADMIN', message: 'At least one active super admin must remain.' });
      }
    }

    const changes: string[] = [];
    if (dto.fullName !== undefined && dto.fullName !== admin.fullName) changes.push(`name: "${admin.fullName}" → "${dto.fullName}"`);
    if (dto.role !== undefined && dto.role !== admin.role) changes.push(`role: ${admin.role} → ${dto.role}`);
    if (dto.isActive !== undefined && dto.isActive !== admin.isActive) changes.push(`isActive: ${admin.isActive} → ${dto.isActive}`);

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
        action: AuditAction.ADMIN_ACTION,
        targetType: 'AdminUser',
        targetId: admin.id,
        description: `Updated admin "${admin.fullName}" (${admin.adminId}): ${changes.join(', ')}`,
        before: { fullName: admin.fullName, role: admin.role, isActive: admin.isActive },
        after: { fullName: updated.fullName, role: updated.role, isActive: updated.isActive },
        ipAddress,
      });
    }

    if (accessStateChanged) {
      await this.redis.setex(
        `admin_revoked:${targetId}`,
        ADMIN_ACCESS_TOKEN_TTL_SECONDS,
        String(Math.floor(Date.now() / 1000)),
        { throwOnError: true },
      );
    }

    return updated;
  }

  async resetAdmin2fa(targetId: string, updaterId: string, ipAddress: string): Promise<{ message: string }> {
    const admin = await this.prisma.adminUser.findFirst({ where: { id: targetId, deletedAt: null } });
    if (!admin) {
      throw new NotFoundException({ code: ErrorCodes.ADMIN_NOT_FOUND, message: 'Admin not found' });
    }

    if (targetId === updaterId) {
      throw new ForbiddenException({ code: 'CANNOT_RESET_OWN_2FA', message: 'Cannot reset your own 2FA' });
    }
    if (!admin.isMfaEnabled && !admin.mfaSecret) {
      throw new ConflictException({ code: 'MFA_NOT_ENABLED', message: '2FA is not enabled for this admin' });
    }

    await this.prisma.adminUser.update({
      where: { id: targetId },
      data: { isMfaEnabled: false, mfaSecret: null },
    });
    await this.redis.setex(
      `admin_revoked:${targetId}`,
      ADMIN_ACCESS_TOKEN_TTL_SECONDS,
      String(Math.floor(Date.now() / 1000)),
      { throwOnError: true },
    );

    this.auditLog.logAdminAction({
      adminId: updaterId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'AdminUser',
      targetId: admin.id,
      description: `Reset 2FA for admin "${admin.fullName}" (${admin.adminId})`,
      ipAddress,
    });

    return { message: '2FA reset successfully' };
  }

  async unlockAdmin(targetId: string, updaterId: string, ipAddress: string): Promise<{ message: string }> {
    const admin = await this.prisma.adminUser.findFirst({ where: { id: targetId, deletedAt: null } });
    if (!admin) {
      throw new NotFoundException({ code: ErrorCodes.ADMIN_NOT_FOUND, message: 'Admin not found' });
    }

    if (!admin.lockedUntil && admin.failedLoginAttempts === 0) {
      throw new ConflictException({ code: 'NOT_LOCKED', message: 'Admin account is not locked' });
    }

    await this.prisma.adminUser.update({
      where: { id: targetId },
      data: { lockedUntil: null, failedLoginAttempts: 0 },
    });
    await this.redis.setex(
      `admin_revoked:${targetId}`,
      ADMIN_ACCESS_TOKEN_TTL_SECONDS,
      String(Math.floor(Date.now() / 1000)),
      { throwOnError: true },
    );

    this.auditLog.logAdminAction({
      adminId: updaterId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'AdminUser',
      targetId: admin.id,
      description: `Unlocked admin "${admin.fullName}" (${admin.adminId})`,
      ipAddress,
    });

    return { message: 'Admin account unlocked successfully' };
  }

  async deleteAdmin(targetId: string, deleterId: string, ipAddress: string): Promise<{ message: string }> {
    if (targetId === deleterId) {
      throw new ForbiddenException({ code: 'CANNOT_DELETE_SELF', message: 'Cannot delete your own account' });
    }

    const admin = await this.prisma.adminUser.findFirst({ where: { id: targetId, deletedAt: null } });
    if (!admin) {
      throw new NotFoundException({ code: ErrorCodes.ADMIN_NOT_FOUND, message: 'Admin not found' });
    }

    if (admin.role === 'SUPER_ADMIN' && admin.isActive) {
      const activeSuperAdmins = await this.prisma.adminUser.count({ where: { role: 'SUPER_ADMIN', isActive: true, deletedAt: null } });
      if (activeSuperAdmins <= 1) {
        throw new ForbiddenException({ code: 'LAST_SUPER_ADMIN', message: 'At least one active super admin must remain.' });
      }
    }

    await this.prisma.adminUser.update({
      where: { id: targetId },
      data: { deletedAt: new Date(), isActive: false },
    });

    await this.redis.setex(
      `admin_revoked:${targetId}`,
      ADMIN_ACCESS_TOKEN_TTL_SECONDS,
      String(Math.floor(Date.now() / 1000)),
      { throwOnError: true },
    );

    this.auditLog.logAdminAction({
      adminId: deleterId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'AdminUser',
      targetId: admin.id,
      description: `Soft-deleted admin "${admin.fullName}" (${admin.adminId})`,
      ipAddress,
    });

    return { message: 'Admin deleted successfully' };
  }
}
