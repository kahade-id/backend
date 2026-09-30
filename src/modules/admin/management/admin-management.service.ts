import { Injectable, NotFoundException, ConflictException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { randomInt as cryptoRandomInt } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { RedisService } from '../../../redis/redis.service';
import { CreateAdminDto } from './dto/create-admin.dto';
import { UpdateAdminDto } from './dto/update-admin.dto';
import { SuspendAdminDto } from './dto/suspend-admin.dto';
import { ChangeAdminRoleDto } from './dto/change-admin-role.dto';
import { CreateEmergencyGrantDto } from './dto/emergency-grant.dto';
import { EMERGENCY_GRANT_SCOPE_NAMES, isKnownEmergencyGrantScope } from '../../../common/constants/emergency-grant-scopes';
import { CreateHandoffDto, HandoffQueryDto } from './dto/create-handoff.dto';
import { createPaginatedResponse } from '../../../common/dto/pagination.dto';
import { AuditAction } from '@prisma/client';
import * as ErrorCodes from '../../../common/constants/error-codes';
import { bcryptHash } from '../../../common/utils/crypto.util';
import { BCRYPT_ROUNDS_ADMIN } from '../../../common/constants/app.constants';
import { escapeLikePattern } from '../../../common/utils/search.util';
import { ADMIN_SESSION_ABSOLUTE_TTL_SECONDS } from '../../auth/token.service';
// AUT-009: kebijakan password admin terpusat (satu-satunya sumber kebenaran).
import { validateAdminPasswordPolicy } from '../admin-password-policy';
// ADM-420: epoch `admin_revoked:` harus hidup minimal sepanjang umur maksimum
// kredensial admin yang masih bisa dihormati. Refresh token dibatasi umur
// absolut sesi 24 jam (SEC-502); marker 2 jam membuka jendela 2–24 jam di mana
// refresh token curian dapat menerbitkan access token baru setelah marker
// kedaluwarsa (fail-open). Batas atas 2 jam dari jwt.config hanya untuk access
// token — bukan untuk refresh.
const ADMIN_REVOKED_MARKER_TTL_SECONDS = ADMIN_SESSION_ABSOLUTE_TTL_SECONDS;
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
              { fullName: { contains: escapeLikePattern(search), mode: 'insensitive' as const } },
              { email: { contains: escapeLikePattern(search), mode: 'insensitive' as const } },
              { adminId: { contains: escapeLikePattern(search), mode: 'insensitive' as const } },
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

    // AUT-009: validasi via kebijakan terpusat (min 12 + kompleksitas).
    validateAdminPasswordPolicy(dto.password);

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
        // AUT-011: admin baru WAJIB mengganti password bawaan saat login pertama.
        mustChangePassword: true,
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

    // GAP-E G390: alasan WAJIB bila role berubah lewat update generik ini
    // (jalur khusus PUT :id/role juga mewajibkan via ChangeAdminRoleDto).
    const roleChanged = dto.role !== undefined && dto.role !== admin.role;
    if (roleChanged && (!dto.reason || !dto.reason.trim())) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Alasan wajib diisi bila role berubah',
      });
    }

    const accessStateChanged =
      roleChanged
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

    // GAP-E G390: perubahan role lewat update generik tetap diaudit eksplisit
    // sebagai ADMIN_ROLE_CHANGED dengan before/after.
    if (roleChanged) {
      this.auditLog.logAdminAction({
        adminId: updaterId,
        action: AuditAction.ADMIN_ROLE_CHANGED,
        targetType: 'AdminUser',
        targetId: admin.id,
        description: `Changed role of admin "${admin.fullName}" (${admin.adminId}): ${admin.role} → ${dto.role}. Reason: ${dto.reason}`,
        before: { role: admin.role },
        after: { role: dto.role, reason: dto.reason },
        ipAddress,
      });
    }

    if (accessStateChanged) {
      await this.redis.setex(
        `admin_revoked:${targetId}`,
        ADMIN_REVOKED_MARKER_TTL_SECONDS,
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
      ADMIN_REVOKED_MARKER_TTL_SECONDS,
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

  /**
   * AUT-002: reset password admin oleh SUPER_ADMIN. Tidak ada alur
   * lupa-password mandiri via email/OTP untuk admin (by design: akun
   * privilese tinggi hanya dipulihkan lewat SUPER_ADMIN yang teraudit).
   *
   * - Tidak boleh me-reset password milik sendiri (pola yang sama dengan
   *   reset 2FA — `CANNOT_RESET_OWN_2FA`).
   * - Password sementara WAJIB memenuhi kebijakan admin (min 12 +
   *   kompleksitas); bila tidak diberikan, dibuat acak yang memenuhi syarat.
   * - Flag `mustChangePassword=true` (AUT-011): target WAJIB mengganti
   *   password saat login berikutnya sebelum mendapat sesi.
   * - Semua sesi target dicabut (fail-closed).
   */
  async resetAdminPassword(
    targetId: string,
    updaterId: string,
    ipAddress: string,
    temporaryPassword?: string,
  ): Promise<{ message: string; temporaryPassword: string }> {
    const admin = await this.prisma.adminUser.findFirst({ where: { id: targetId, deletedAt: null } });
    if (!admin) {
      throw new NotFoundException({ code: ErrorCodes.ADMIN_NOT_FOUND, message: 'Admin not found' });
    }

    if (targetId === updaterId) {
      throw new ForbiddenException({ code: 'CANNOT_RESET_OWN_PASSWORD', message: 'Cannot reset your own password — use change-password instead' });
    }

    const tempPassword = temporaryPassword?.trim() || this.generateTemporaryPassword();
    validateAdminPasswordPolicy(tempPassword);

    const hashedPassword = await bcryptHash(tempPassword, BCRYPT_ROUNDS_ADMIN);
    await this.prisma.adminUser.update({
      where: { id: targetId },
      data: {
        password: hashedPassword,
        mustChangePassword: true,
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });
    // Cabut semua sesi target — password lama (bila bocor) tidak bisa dipakai lagi.
    await this.redis.setex(
      `admin_revoked:${targetId}`,
      ADMIN_REVOKED_MARKER_TTL_SECONDS,
      String(Math.floor(Date.now() / 1000)),
      { throwOnError: true },
    );

    this.auditLog.logAdminAction({
      adminId: updaterId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'AdminUser',
      targetId: admin.id,
      description: `Reset password for admin "${admin.fullName}" (${admin.adminId}) — must change on next login`,
      ipAddress,
    });

    return { message: 'Password reset successfully. The admin must change it on next login.', temporaryPassword: tempPassword };
  }

  /**
   * Bangkitkan password sementara yang memenuhi kebijakan admin:
   * 16 karakter dari 4 kelas (besar/kecil/angka/simbol), CSPRNG.
   */
  private generateTemporaryPassword(): string {
    const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const lower = 'abcdefghijkmnopqrstuvwxyz';
    const digits = '23456789';
    const symbols = '!@#$%^&*()-_=+';
    const all = upper + lower + digits + symbols;
    const pick = (chars: string): string => chars[cryptoRandomInt(chars.length)];
    // Jamin tiap kelas muncul minimal sekali, lalu acak urutan.
    const chars = [pick(upper), pick(lower), pick(digits), pick(symbols)];
    for (let i = 0; i < 12; i++) chars.push(pick(all));
    for (let i = chars.length - 1; i > 0; i--) {
      const j = cryptoRandomInt(i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    return chars.join('');
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
      ADMIN_REVOKED_MARKER_TTL_SECONDS,
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
      ADMIN_REVOKED_MARKER_TTL_SECONDS,
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

  // ══════════════════════════════════════════════════════════════
  // GAP-E (G376–G400) — operasional admin & tim
  // ══════════════════════════════════════════════════════════════

  /** Menandai semua token akses admin sebagai kedaluwarsa (paksa login ulang). */
  private async revokeAdminTokens(adminId: string): Promise<void> {
    await this.redis.setex(
      `admin_revoked:${adminId}`,
      ADMIN_REVOKED_MARKER_TTL_SECONDS,
      String(Math.floor(Date.now() / 1000)),
      { throwOnError: true },
    );
  }

  private async findAdminOrThrow(id: string) {
    const admin = await this.prisma.adminUser.findFirst({ where: { id, deletedAt: null } });
    if (!admin) {
      throw new NotFoundException({ code: ErrorCodes.ADMIN_NOT_FOUND, message: 'Admin not found' });
    }
    return admin;
  }

  private async assertNotLastSuperAdmin(admin: { role: string; isActive: boolean }): Promise<void> {
    if (admin.role === 'SUPER_ADMIN' && admin.isActive) {
      const activeSuperAdmins = await this.prisma.adminUser.count({
        where: { role: 'SUPER_ADMIN', isActive: true, deletedAt: null },
      });
      if (activeSuperAdmins <= 1) {
        throw new ForbiddenException({ code: 'LAST_SUPER_ADMIN', message: 'At least one active super admin must remain.' });
      }
    }
  }

  // ── Sesi admin (G393/G394) ──────────────────────────────────────

  /** Daftar sesi login admin (aktif + yang baru dicabut). */
  async listAdminSessions(adminId: string): Promise<object> {
    await this.findAdminOrThrow(adminId);
    const sessions = await this.prisma.adminSession.findMany({
      where: { adminId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true, ipAddress: true, userAgent: true,
        createdAt: true, lastSeenAt: true, revokedAt: true, revokedBy: true,
      },
    });
    return { data: sessions, total: sessions.length };
  }

  /**
   * Cabut satu sesi admin (audit ADMIN_SESSION_REVOKED).
   *
   * Keamanan: JWT admin bersifat stateless dan tidak tertaut per-sesi di DB
   * (tidak ada kolom jti di AdminSession — perubahan schema di luar cakupan
   * GAP-E, tanpa migrasi baru), sehingga `revokedAt` saja tidak membatalkan
   * token yang sudah terbit. Sebagai fail-safe, pencabutan sesi juga
   * menaikkan epoch `admin_revoked:` untuk admin tersebut — SELURUH token
   * akses admin itu menjadi tidak valid dan ia harus login ulang.
   */
  async revokeAdminSession(adminId: string, sessionId: string, revokerId: string, ipAddress: string): Promise<{ message: string }> {
    await this.findAdminOrThrow(adminId);
    const session = await this.prisma.adminSession.findFirst({
      where: { id: sessionId, adminId, revokedAt: null },
    });
    if (!session) {
      throw new NotFoundException({ code: 'ADMIN_SESSION_NOT_FOUND', message: 'Active admin session not found' });
    }
    await this.prisma.adminSession.update({
      where: { id: sessionId },
      data: { revokedAt: new Date(), revokedBy: revokerId },
    });
    // Fail-safe: batalkan juga token JWT yang beredar milik admin ini.
    await this.revokeAdminTokens(adminId);
    this.auditLog.logAdminAction({
      adminId: revokerId,
      action: AuditAction.ADMIN_SESSION_REVOKED,
      targetType: 'AdminUser',
      targetId: adminId,
      description: `Revoked admin session ${sessionId} for admin ${adminId}`,
      before: { revokedAt: null },
      after: { revokedAt: new Date().toISOString(), revokedBy: revokerId },
      ipAddress,
    });
    return { message: 'Sesi admin dicabut.' };
  }

  // ── Suspend / reactivate (G391/G392) ────────────────────────────

  /**
   * Suspend akun admin: isActive=false + token dicabut + audit ADMIN_SUSPENDED.
   * Riwayat audit dipertahankan (bukan delete) — akun bisa di-reactivate.
   */
  async suspendAdmin(targetId: string, dto: SuspendAdminDto, actorId: string, ipAddress: string): Promise<object> {
    if (targetId === actorId) {
      throw new ForbiddenException({ code: 'CANNOT_SUSPEND_SELF', message: 'Tidak bisa men-suspend akun sendiri' });
    }
    const admin = await this.findAdminOrThrow(targetId);
    if (!admin.isActive) {
      throw new ConflictException({ code: 'ALREADY_SUSPENDED', message: 'Admin sudah dalam status suspend/nonaktif' });
    }
    await this.assertNotLastSuperAdmin(admin);

    const updated = await this.prisma.adminUser.update({
      where: { id: targetId },
      data: { isActive: false },
      select: { id: true, adminId: true, fullName: true, email: true, role: true, isActive: true },
    });

    await this.revokeAdminTokens(targetId);

    this.auditLog.logAdminAction({
      adminId: actorId,
      action: AuditAction.ADMIN_SUSPENDED,
      targetType: 'AdminUser',
      targetId: admin.id,
      description: `Suspended admin "${admin.fullName}" (${admin.adminId}). Reason: ${dto.reason}`,
      before: { isActive: true },
      after: { isActive: false, reason: dto.reason },
      ipAddress,
    });

    return updated;
  }

  /** Aktifkan kembali akun admin yang di-suspend (audit ADMIN_REACTIVATED). */
  async reactivateAdmin(targetId: string, actorId: string, ipAddress: string): Promise<object> {
    const admin = await this.findAdminOrThrow(targetId);
    if (admin.isActive) {
      throw new ConflictException({ code: 'ALREADY_ACTIVE', message: 'Admin sudah aktif' });
    }
    const updated = await this.prisma.adminUser.update({
      where: { id: targetId },
      data: { isActive: true },
      select: { id: true, adminId: true, fullName: true, email: true, role: true, isActive: true },
    });

    this.auditLog.logAdminAction({
      adminId: actorId,
      action: AuditAction.ADMIN_REACTIVATED,
      targetType: 'AdminUser',
      targetId: admin.id,
      description: `Reactivated admin "${admin.fullName}" (${admin.adminId})`,
      before: { isActive: false },
      after: { isActive: true },
      ipAddress,
    });

    return updated;
  }

  // ── Ubah role (G390) ───────────────────────────────────────────

  /**
   * Ubah role admin — alasan WAJIB, audit ADMIN_ROLE_CHANGED dengan
   * before/after. Token lama dicabut agar hak baru berlaku segera.
   */
  async changeAdminRole(targetId: string, dto: ChangeAdminRoleDto, actorId: string, ipAddress: string): Promise<object> {
    if (targetId === actorId) {
      throw new ForbiddenException({ code: 'CANNOT_CHANGE_OWN_ROLE', message: 'Cannot change your own role' });
    }
    const admin = await this.findAdminOrThrow(targetId);
    if (dto.role === admin.role) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Role baru sama dengan role saat ini' });
    }
    await this.assertNotLastSuperAdmin(admin);

    const updated = await this.prisma.adminUser.update({
      where: { id: targetId },
      data: { role: dto.role as never },
      select: { id: true, adminId: true, fullName: true, email: true, role: true, isActive: true },
    });

    await this.revokeAdminTokens(targetId);

    this.auditLog.logAdminAction({
      adminId: actorId,
      action: AuditAction.ADMIN_ROLE_CHANGED,
      targetType: 'AdminUser',
      targetId: admin.id,
      description: `Changed role of admin "${admin.fullName}" (${admin.adminId}): ${admin.role} → ${dto.role}. Reason: ${dto.reason}`,
      before: { role: admin.role },
      after: { role: dto.role, reason: dto.reason },
      ipAddress,
    });

    return updated;
  }

  // ── Akses darurat berjangka (G395) ──────────────────────────────

  /**
   * Grant akses darurat berjangka. Guard SUPER_ADMIN ada di controller
   * (@AdminRoles) — service memvalidasi ulang agar tidak bisa dilewati.
   */
  async createEmergencyGrant(dto: CreateEmergencyGrantDto, granterId: string, granterRole: string, ipAddress: string): Promise<object> {
    if (granterRole !== 'SUPER_ADMIN') {
      throw new ForbiddenException({ code: ErrorCodes.INSUFFICIENT_ADMIN_ROLE, message: 'Emergency access grant requires SUPER_ADMIN' });
    }
    const target = await this.findAdminOrThrow(dto.adminId);
    if (target.id === granterId) {
      throw new ForbiddenException({ code: 'CANNOT_GRANT_SELF', message: 'Tidak bisa memberi akses darurat ke diri sendiri' });
    }
    if (!target.isActive) {
      throw new BadRequestException({ code: ErrorCodes.ACCOUNT_INACTIVE, message: 'Target admin is not active' });
    }

    // ADM-402 (defense in depth, di samping @IsIn pada DTO): scope di luar allowlist
    // ditolak — grant tanpa scope valid tidak boleh memberi kesan akses terbatas.
    if (!isKnownEmergencyGrantScope(dto.scope)) {
      throw new BadRequestException({
        code: ErrorCodes.EMERGENCY_GRANT_UNKNOWN_SCOPE,
        message: `Unknown emergency grant scope "${dto.scope}". Allowed: ${EMERGENCY_GRANT_SCOPE_NAMES.join(', ')}`,
      });
    }

    const existing = await this.prisma.emergencyAccessGrant.findFirst({
      where: { adminId: target.id, revokedAt: null, expiresAt: { gt: new Date() } },
    });
    if (existing) {
      throw new ConflictException({ code: 'GRANT_ALREADY_ACTIVE', message: 'Admin sudah memiliki grant akses darurat yang aktif' });
    }

    const expiresAt = new Date(Date.now() + dto.expiresInMinutes * 60_000);
    const grant = await this.prisma.emergencyAccessGrant.create({
      data: {
        adminId: target.id,
        grantedBy: granterId,
        reason: dto.reason,
        scope: dto.scope,
        expiresAt,
      },
      select: { id: true, adminId: true, grantedBy: true, reason: true, scope: true, expiresAt: true, createdAt: true },
    });

    this.auditLog.logAdminAction({
      adminId: granterId,
      action: AuditAction.EMERGENCY_ACCESS_GRANTED,
      targetType: 'AdminUser',
      targetId: target.id,
      description: `Granted emergency access to admin "${target.fullName}" (${target.adminId}) for ${dto.expiresInMinutes} min. Scope: ${dto.scope}. Reason: ${dto.reason}`,
      after: { grantId: grant.id, scope: dto.scope, expiresAt: expiresAt.toISOString() },
      ipAddress,
    });

    return grant;
  }

  /** Daftar grant akses darurat yang masih aktif (belum kedaluwarsa/dicabut). */
  async listActiveEmergencyGrants(): Promise<object> {
    return this.listEmergencyGrants(true);
  }

  /**
   * GAP-E (G395, kontrak admin web `GET /v1/admin/emergency-grants`) —
   * daftar grant akses darurat; `activeOnly=false` menampilkan riwayat
   * termasuk yang kedaluwarsa/dicabut.
   *
   * AW-004 (perf-fix): riwayat grant tumbuh monoton, jadi findMany dibatasi
   * `take: 500` (grant darurat adalah aksi langka — 500 baris riwayat lebih
   * dari cukup untuk operasional). `total` dihitung via count terpisah agar
   * jujur; `hasMore` memberi tahu admin bila riwayat terpotong.
   */
  async listEmergencyGrants(activeOnly = true): Promise<object> {
    const where = activeOnly ? { revokedAt: null, expiresAt: { gt: new Date() } } : {};
    const [grants, total] = await Promise.all([
      this.prisma.emergencyAccessGrant.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 500,
        include: {
          admin: { select: { id: true, adminId: true, fullName: true, email: true, role: true } },
        },
      }),
      this.prisma.emergencyAccessGrant.count({ where }),
    ]);
    return { data: grants, total, hasMore: grants.length < total };
  }

  async revokeEmergencyGrant(grantId: string, revokerId: string, ipAddress: string): Promise<{ message: string }> {
    const grant = await this.prisma.emergencyAccessGrant.findFirst({
      where: { id: grantId, revokedAt: null, expiresAt: { gt: new Date() } },
      include: { admin: { select: { id: true, adminId: true, fullName: true } } },
    });
    if (!grant) {
      throw new NotFoundException({ code: 'GRANT_NOT_FOUND', message: 'Grant akses darurat aktif tidak ditemukan' });
    }
    await this.prisma.emergencyAccessGrant.update({
      where: { id: grantId },
      data: { revokedAt: new Date() },
    });

    this.auditLog.logAdminAction({
      adminId: revokerId,
      action: AuditAction.EMERGENCY_ACCESS_REVOKED,
      targetType: 'AdminUser',
      targetId: grant.adminId,
      description: `Revoked emergency access grant ${grantId} for admin "${grant.admin.fullName}" (${grant.admin.adminId})`,
      before: { revokedAt: null },
      after: { revokedAt: new Date().toISOString(), revokedBy: revokerId },
      ipAddress,
    });

    return { message: 'Grant akses darurat dicabut.' };
  }

  // ── Review akses periodik (G396) ─────────────────────────────────

  /** Siklus sertifikasi ulang akses (hari). Disepakati operasional: 90 hari. */
  private static readonly ACCESS_REVIEW_CYCLE_DAYS = 90;
  private static readonly ACCESS_REVIEW_MARKER = 'ACCESS_REVIEW_CERTIFIED';

  /**
   * Daftar admin + tanggal sertifikasi ulang akses terakhir.
   * Tanggal = terbaru dari: createdAt, ADMIN_ROLE_CHANGED terakhir, atau
   * penandaan "direview" terakhir (via markAccessReviewed).
   */
  async accessReview(): Promise<object> {
    const admins = await this.prisma.adminUser.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true, adminId: true, fullName: true, email: true, role: true, isActive: true, createdAt: true },
    });

    // AW-007 (perf-fix, dinilai 2026-09-29): take 2000 di sini DINILAI AMAN dan
    // DIPERTAHANKAN — "pantau" saja. Alasannya: (1) where sudah sempit
    // (targetType='AdminUser' + 2 action spesifik + targetId IN daftar admin —
    // jumlah admin hanya belasan/puluhan); (2) halaman review akses dibuka
    // jarang (sertifikasi periodik 90 hari, bukan operasional harian); (3) take
    // 2000 adalah batas keras, bukan fetch-all. Bila tim admin tumbuh >500
    // orang atau halaman ini dibuka harian, pindahkan ke agregasi server-side
    // (MAX(createdAt) per targetId GROUP BY action).
    const logs = await this.prisma.adminAuditLog.findMany({
      where: {
        targetType: 'AdminUser',
        targetId: { in: admins.map((a) => a.id) },
        action: { in: [AuditAction.ADMIN_ROLE_CHANGED, AuditAction.ADMIN_ACTION] },
      },
      orderBy: { createdAt: 'desc' },
      select: { targetId: true, action: true, description: true, createdAt: true, adminId: true },
      take: 2000,
    });

    const now = Date.now();
    const cycleMs = AdminManagementService.ACCESS_REVIEW_CYCLE_DAYS * 24 * 60 * 60 * 1000;

    const rows = admins.map((a) => {
      let lastCertifiedAt = a.createdAt;
      let certifiedBy: string | null = null;
      for (const log of logs) {
        if (log.targetId !== a.id) continue;
        const isMark = log.action === AuditAction.ADMIN_ACTION
          && (log.description ?? '').startsWith(AdminManagementService.ACCESS_REVIEW_MARKER);
        const isRoleChange = log.action === AuditAction.ADMIN_ROLE_CHANGED;
        if ((isMark || isRoleChange) && log.createdAt > lastCertifiedAt) {
          lastCertifiedAt = log.createdAt;
          certifiedBy = log.adminId;
        }
      }
      const nextDueAt = new Date(lastCertifiedAt.getTime() + cycleMs);
      return {
        id: a.id,
        adminId: a.adminId,
        fullName: a.fullName,
        email: a.email,
        role: a.role,
        isActive: a.isActive,
        lastCertifiedAt: lastCertifiedAt.toISOString(),
        certifiedBy,
        nextReviewDueAt: nextDueAt.toISOString(),
        overdue: now > nextDueAt.getTime(),
        cycleDays: AdminManagementService.ACCESS_REVIEW_CYCLE_DAYS,
      };
    });

    return { data: rows, total: rows.length };
  }

  /** Tandai akses admin sudah direview (sertifikasi ulang manual). */
  async markAccessReviewed(targetId: string, actorId: string, ipAddress: string): Promise<{ message: string }> {
    const admin = await this.findAdminOrThrow(targetId);
    const now = new Date();
    this.auditLog.logAdminAction({
      adminId: actorId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'AdminUser',
      targetId: admin.id,
      description: `${AdminManagementService.ACCESS_REVIEW_MARKER}: access of admin "${admin.fullName}" (${admin.adminId}, role ${admin.role}) certified`,
      after: {
        accessReviewedAt: now.toISOString(),
        nextReviewDueAt: new Date(now.getTime() + AdminManagementService.ACCESS_REVIEW_CYCLE_DAYS * 24 * 60 * 60 * 1000).toISOString(),
      },
      ipAddress,
    });
    return { message: 'Akses ditandai sudah direview.' };
  }

  /**
   * GAP-E (G392, kontrak admin web `GET /v1/admin/management/:id/audit-log`) —
   * histori perubahan hak akun admin (role, suspend, revoke sesi, dsb.)
   * dari AdminAuditLog, diurut terbaru dulu.
   */
  async listAdminAuditLog(targetId: string, page = 1, limit = 20): Promise<object> {
    await this.findAdminOrThrow(targetId);
    const safePage = Math.max(page, 1);
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const where = { targetType: 'AdminUser', targetId };
    const [logs, total] = await Promise.all([
      this.prisma.adminAuditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
        select: {
          id: true,
          action: true,
          description: true,
          ipAddress: true,
          createdAt: true,
          admin: { select: { id: true, adminId: true, fullName: true } },
        },
      }),
      this.prisma.adminAuditLog.count({ where }),
    ]);
    const data = logs.map((l) => ({
      id: l.id,
      action: String(l.action),
      description: l.description,
      ipAddress: l.ipAddress,
      createdAt: l.createdAt.toISOString(),
      actor: l.admin ? { id: l.admin.id, adminId: l.admin.adminId, fullName: l.admin.fullName } : null,
    }));
    return { data, total, page: safePage, limit: safeLimit, totalPages: Math.ceil(total / safeLimit) };
  }

  // ── Handoff kasus (G397) ─────────────────────────────────────────

  /** Catat handoff kasus antar petugas + audit CASE_HANDOFF_CREATED. */
  async createHandoff(dto: CreateHandoffDto, actorId: string, ipAddress: string): Promise<object> {
    if (dto.fromAdminId === dto.toAdminId) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'fromAdminId dan toAdminId tidak boleh sama' });
    }
    const [from, to] = await Promise.all([
      this.findAdminOrThrow(dto.fromAdminId),
      this.findAdminOrThrow(dto.toAdminId),
    ]);
    if (!from.isActive || !to.isActive) {
      throw new BadRequestException({ code: ErrorCodes.ACCOUNT_INACTIVE, message: 'Admin pemberi/penerima tidak aktif' });
    }

    const handoff = await this.prisma.adminCaseHandoff.create({
      data: {
        caseType: dto.caseType,
        caseId: dto.caseId,
        fromAdminId: from.id,
        toAdminId: to.id,
        note: dto.note ?? null,
      },
    });

    this.auditLog.logAdminAction({
      adminId: actorId,
      action: AuditAction.CASE_HANDOFF_CREATED,
      targetType: 'AdminUser',
      targetId: to.id,
      description: `Handoff ${dto.caseType} ${dto.caseId}: ${from.fullName} → ${to.fullName}${dto.note ? `. Note: ${dto.note}` : ''}`,
      after: { handoffId: handoff.id, caseType: dto.caseType, caseId: dto.caseId, fromAdminId: from.id, toAdminId: to.id },
      ipAddress,
    });

    return handoff;
  }

  /** Riwayat handoff untuk satu kasus (dipakai di detail kasus). */
  async listHandoffsByCase(query: HandoffQueryDto): Promise<object> {
    const handoffs = await this.prisma.adminCaseHandoff.findMany({
      where: { caseType: query.caseType, caseId: query.caseId },
      orderBy: { createdAt: 'desc' },
    });
    const adminIds = [...new Set(handoffs.flatMap((h) => [h.fromAdminId, h.toAdminId]))];
    const admins = adminIds.length > 0
      ? await this.prisma.adminUser.findMany({
          where: { id: { in: adminIds } },
          select: { id: true, fullName: true, role: true },
        })
      : [];
    const byId = new Map(admins.map((a) => [a.id, a]));
    return {
      data: handoffs.map((h) => ({
        ...h,
        fromAdmin: byId.get(h.fromAdminId) ?? null,
        toAdmin: byId.get(h.toAdminId) ?? null,
      })),
      total: handoffs.length,
    };
  }

  /**
   * Beban kasus per petugas: jumlah handoff yang DITERIMA (30 hari terakhir)
   * + jumlah kasus yang sedang di-assign (dispute aktif).
   */
  async handoffWorkload(): Promise<object> {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [received, assignedDisputes] = await Promise.all([
      this.prisma.adminCaseHandoff.groupBy({
        by: ['toAdminId'],
        where: { createdAt: { gte: since } },
        _count: { id: true },
      }),
      this.prisma.dispute.groupBy({
        by: ['assignedAdminId'],
        where: { assignedAdminId: { not: null }, status: { not: 'RESOLVED' } },
        _count: { id: true },
      }),
    ]);
    const adminIds = [...new Set([
      ...received.map((r) => r.toAdminId),
      ...assignedDisputes.map((d) => d.assignedAdminId as string),
    ])];
    const admins = adminIds.length > 0
      ? await this.prisma.adminUser.findMany({
          where: { id: { in: adminIds }, deletedAt: null },
          select: { id: true, fullName: true, role: true, isActive: true },
        })
      : [];
    const byId = new Map(admins.map((a) => [a.id, a]));
    const rows = adminIds.map((id) => ({
      adminId: id,
      admin: byId.get(id) ?? null,
      handoffsReceived30d: received.find((r) => r.toAdminId === id)?._count.id ?? 0,
      activeAssignedDisputes: assignedDisputes.find((d) => d.assignedAdminId === id)?._count.id ?? 0,
    }));
    rows.sort((a, b) => (b.handoffsReceived30d + b.activeAssignedDisputes) - (a.handoffsReceived30d + a.activeAssignedDisputes));
    return { data: rows, total: rows.length, windowDays: 30 };
  }

  // ── Jejak aktivitas admin (G399) ────────────────────────────────

  /** Retensi log aktivitas admin (hari). Operasional: 365 hari. */
  private static readonly ACTIVITY_LOG_RETENTION_DAYS = 365;
  /** Batas baris ekspor CSV aktivitas. */
  private static readonly ACTIVITY_EXPORT_MAX_ROWS = 10_000;

  private buildActivityWhere(filters: { adminId?: string; action?: string; from?: string; to?: string }) {
    const actionValues = Object.values(AuditAction) as string[];
    const where: Record<string, unknown> = {};
    if (filters.adminId) where.adminId = filters.adminId;
    if (filters.action && actionValues.includes(filters.action)) {
      where.action = filters.action as AuditAction;
    }
    const createdAt: Record<string, Date> = {};
    if (filters.from) {
      const from = new Date(filters.from);
      if (!Number.isNaN(from.getTime())) createdAt.gte = from;
    }
    if (filters.to) {
      const to = new Date(filters.to);
      if (!Number.isNaN(to.getTime())) createdAt.lte = to;
    }
    if (Object.keys(createdAt).length > 0) where.createdAt = createdAt;
    return where;
  }

  private formatActivityEntry(l: {
    id: string;
    adminId: string | null;
    action: AuditAction;
    description: string | null;
    ipAddress: string | null;
    createdAt: Date;
    admin: { adminId: string; fullName: string } | null;
  }) {
    return {
      id: l.id,
      adminId: l.adminId,
      adminName: l.admin?.fullName ?? null,
      action: String(l.action),
      description: l.description,
      ipAddress: l.ipAddress,
      createdAt: l.createdAt.toISOString(),
    };
  }

  /**
   * GAP-E (G399) — jejak aktivitas admin dengan filter admin/aksi/rentang
   * waktu. Filter `action` yang tidak dikenal diabaikan (bukan error).
   */
  async listAdminActivity(filters: {
    adminId?: string; action?: string; from?: string; to?: string; page?: number; limit?: number;
  }): Promise<object> {
    const safePage = Math.max(filters.page ?? 1, 1);
    const safeLimit = Math.min(Math.max(filters.limit ?? 20, 1), 100);
    const where = this.buildActivityWhere(filters);
    const [logs, total] = await Promise.all([
      this.prisma.adminAuditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
        select: {
          id: true, adminId: true, action: true, description: true,
          ipAddress: true, createdAt: true,
          admin: { select: { adminId: true, fullName: true } },
        },
      }),
      this.prisma.adminAuditLog.count({ where }),
    ]);
    return createPaginatedResponse(
      logs.map((l) => this.formatActivityEntry(l)),
      total,
      safePage,
      safeLimit,
    );
  }

  /**
   * GAP-E (G399) — ekspor CSV jejak aktivitas (diaudit sebagai USER_EXPORTED).
   * Tanpa PII sensitif: hanya nama admin pelaksana, bukan email.
   */
  async exportAdminActivityCsv(
    filters: { adminId?: string; action?: string; from?: string; to?: string },
    actorId: string,
    ipAddress: string,
  ): Promise<string> {
    const where = this.buildActivityWhere(filters);
    const logs = await this.prisma.adminAuditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: AdminManagementService.ACTIVITY_EXPORT_MAX_ROWS,
      select: {
        id: true, adminId: true, action: true, description: true,
        ipAddress: true, createdAt: true,
        admin: { select: { adminId: true, fullName: true } },
      },
    });
    const escapeCsv = (v: string | null | undefined) =>
      `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = 'id,admin_id,admin_name,action,description,ip_address,created_at';
    const lines = logs.map((l) =>
      [
        l.id, l.adminId, l.admin?.fullName ?? '', String(l.action),
        l.description ?? '', l.ipAddress ?? '', l.createdAt.toISOString(),
      ]
        .map((v) => escapeCsv(v))
        .join(','),
    );
    this.auditLog.logAdminAction({
      adminId: actorId,
      action: AuditAction.USER_EXPORTED,
      targetType: 'AdminAuditLog',
      targetId: 'activity-log',
      description: `Exported admin activity log CSV (${logs.length} rows)`,
      after: { rowCount: logs.length, filters },
      ipAddress,
    });
    return [header, ...lines].join('\n');
  }

  /** GAP-E (G399) — kebijakan retensi log aktivitas admin. */
  async getActivityRetention(): Promise<object> {
    return {
      retentionDays: AdminManagementService.ACTIVITY_LOG_RETENTION_DAYS,
      note: 'Log aktivitas admin disimpan 365 hari, lalu diarsip ke cold storage dan dihapus dari database operasional.',
    };
  }
}
