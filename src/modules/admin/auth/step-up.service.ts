import { Injectable, Logger, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { bcryptCompare } from '../../../common/utils/crypto.util';
import { AuditAction } from '@prisma/client';
import * as ErrorCodes from '../../../common/constants/error-codes';

/** SEC-503: TTL token step-up — 3 menit, sesuai rekomendasi audit. */
export const STEP_UP_TTL_MS = 3 * 60 * 1000;

export interface ConsumeStepUpOptions {
  adminId: string;
  action: string;
  targetId?: string;
}

/**
 * SEC-503: step-up re-auth server-side untuk aksi admin sensitif.
 *
 * - `issueStepUpToken`: verifikasi password (bcrypt) lalu terbitkan token
 *   crypto-random 32 byte; yang disimpan hanya hash SHA-256-nya.
 * - `consumeStepUpToken`: validasi (hash cocok, milik admin pemanggil, belum
 *   kedaluwarsa, belum dipakai, action & targetId cocok) lalu hanguskan
 *   secara atomik (updateMany where usedAt null) — token sekali pakai.
 */
@Injectable()
export class AdminStepUpService {
  private readonly logger = new Logger(AdminStepUpService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  static hashToken(rawToken: string): string {
    return createHash('sha256').update(rawToken).digest('hex');
  }

  async issueStepUpToken(
    adminId: string,
    password: string,
    action: string,
    targetId: string | undefined,
    ipAddress: string,
  ): Promise<{ stepUpToken: string; expiresAt: string }> {
    const admin = await this.prisma.adminUser.findUnique({ where: { id: adminId } });
    if (!admin || !admin.isActive || admin.deletedAt) {
      throw new UnauthorizedException({
        code: ErrorCodes.UNAUTHORIZED,
        message: 'Admin not found or inactive',
      });
    }
    if (!password) {
      throw new UnauthorizedException({
        code: ErrorCodes.REAUTH_PASSWORD_REQUIRED,
        message: 'Password is required for step-up authentication',
      });
    }
    const ok = await bcryptCompare(password, admin.password);
    if (!ok) {
      this.auditLog.logAdminAction({
        adminId,
        action: AuditAction.ADMIN_ACTION,
        targetType: 'AdminStepUp',
        description: `Failed step-up password verification for action "${action}"`,
        ipAddress,
      });
      throw new UnauthorizedException({
        code: ErrorCodes.REAUTH_INVALID_PASSWORD,
        message: 'Invalid password for step-up authentication',
      });
    }

    const stepUpToken = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + STEP_UP_TTL_MS);
    await this.prisma.adminStepUpToken.create({
      data: {
        tokenHash: AdminStepUpService.hashToken(stepUpToken),
        adminId,
        action,
        targetId: targetId ?? null,
        expiresAt,
      },
    });

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'AdminStepUp',
      description: `Step-up token issued for action "${action}"${targetId ? ` (target ${targetId})` : ''}`,
      ipAddress,
    });

    return { stepUpToken, expiresAt: expiresAt.toISOString() };
  }

  /**
   * Validasi + hanguskan token secara atomik. Idempoten-safe terhadap
   * pemakaian ganda konkuren: hanya SATU pemanggil yang menang
   * (updateMany where usedAt null → count 1).
   */
  async consumeStepUpToken(rawToken: string | undefined, opts: ConsumeStepUpOptions): Promise<void> {
    if (!rawToken) {
      throw new ForbiddenException({
        code: ErrorCodes.STEP_UP_REQUIRED,
        message: 'X-Step-Up-Token header is required for this action',
      });
    }
    const tokenHash = AdminStepUpService.hashToken(rawToken);
    const now = new Date();

    const rec = await this.prisma.adminStepUpToken.findUnique({ where: { tokenHash } });
    if (!rec || rec.adminId !== opts.adminId) {
      throw new ForbiddenException({
        code: ErrorCodes.STEP_UP_INVALID,
        message: 'Step-up token is invalid',
      });
    }
    if (rec.usedAt) {
      throw new ForbiddenException({
        code: ErrorCodes.STEP_UP_INVALID,
        message: 'Step-up token has already been used',
      });
    }
    if (rec.expiresAt <= now) {
      throw new ForbiddenException({
        code: ErrorCodes.STEP_UP_EXPIRED,
        message: 'Step-up token has expired — request a new one',
      });
    }
    if (rec.action !== opts.action) {
      throw new ForbiddenException({
        code: ErrorCodes.STEP_UP_MISMATCH,
        message: `Step-up token was issued for action "${rec.action}", not "${opts.action}"`,
      });
    }
    if (rec.targetId && rec.targetId !== opts.targetId) {
      throw new ForbiddenException({
        code: ErrorCodes.STEP_UP_MISMATCH,
        message: 'Step-up token was issued for a different target',
      });
    }

    // Tandai usedAt ATOMIK — hanya pemanggil pertama yang menang.
    const consumed = await this.prisma.adminStepUpToken.updateMany({
      where: { tokenHash, usedAt: null },
      data: { usedAt: now },
    });
    if (consumed.count === 0) {
      throw new ForbiddenException({
        code: ErrorCodes.STEP_UP_INVALID,
        message: 'Step-up token has already been used',
      });
    }
  }

  /** Bersihkan token kedaluwarsa (housekeeping harian). */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async purgeExpiredTokens(): Promise<void> {
    try {
      const res = await this.prisma.adminStepUpToken.deleteMany({
        where: { expiresAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
      });
      if (res.count > 0) this.logger.log(`Purged ${res.count} expired step-up tokens`);
    } catch (err) {
      this.logger.warn(`Step-up token purge failed: ${(err as Error).message}`);
    }
  }
}
