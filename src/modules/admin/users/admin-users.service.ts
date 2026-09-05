import { Injectable, NotFoundException, ForbiddenException, BadRequestException, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { Prisma, AuditAction, OrderStatus, WalletTransactionType, WalletTransactionStatus, OtpType, NotificationType } from '@prisma/client';
import { getCategoryForType } from '../../notifications/notification-category.map';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { SESSION_REVOKED_KEY } from '../../../common/constants/redis-keys';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { WalletAdjustDto, WalletAdjustType } from './dto/wallet-adjust.dto';
import { WalletTxSerialService } from '../../../common/services/wallet-tx-serial.service';
import { toSen, toIdr } from '../../../common/utils/currency.util';
import { createPaginatedResponse } from '../../../common/dto/pagination.dto';
import * as ErrorCodes from '../../../common/constants/error-codes';
import { OtpService } from '../../auth/otp.service';
import { EMAIL_QUEUE, EmailJobData } from '../../queue/processors/email.processor';
import { generateNotifId, generateWalletTxId } from '../../../common/utils/id-generator.util';
import { parseJwtTtl } from '../../../common/utils/jwt.util';
import { decryptPiiSafe, hashPhoneNumber, normalizePhoneNumber } from '../../../common/utils/pii.util';

@Injectable()
export class AdminUsersService {
  private readonly logger = new Logger(AdminUsersService.name);
  private readonly accessTokenTtlSeconds: number;

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private configService: ConfigService,
    private auditLog: AuditLogService,
    private walletTxSerial: WalletTxSerialService,
    private otpService: OtpService,
    @InjectQueue(EMAIL_QUEUE) private readonly emailQueue: Queue<EmailJobData>,
  ) {
    this.accessTokenTtlSeconds = parseJwtTtl(
      this.configService.get<string>('jwt.expiresIn') ?? '15m',
    );
  }


  async listUsers(page = 1, limit = 20, search?: string, status?: string, sortBy?: string, sortOrder?: 'asc' | 'desc'): Promise<object> {
    const safeLimit = Math.min(limit, 100);
    const skip = (page - 1) * safeLimit;
    const where: Prisma.UserWhereInput = { deletedAt: null };

    if (search) {
      const orClauses: Prisma.UserWhereInput[] = [
        { email: { contains: search, mode: 'insensitive' } },
        { fullName: { contains: search, mode: 'insensitive' } },
        { userId: { contains: search, mode: 'insensitive' } },
        { username: { contains: search, mode: 'insensitive' } },
      ];
      const digitsOnly = search.replace(/\D/g, '');
      if (digitsOnly.length >= 8) {
        try {
          const normalized = normalizePhoneNumber(search);
          orClauses.push({ phoneNumberHash: hashPhoneNumber(normalized) });
        } catch {
          /* ignore — invalid phone format, fall back to other fields */
        }
      }
      where.OR = orClauses;
    }
    if (status === 'banned') where.isBanned = true;
    if (status === 'active') where.isBanned = false;
    if (status === 'kyc_approved') where.kycStatus = 'APPROVED';
    if (status === 'kyc_pending') where.kycStatus = 'PENDING';

    const allowedSortFields = ['createdAt', 'lastLoginAt', 'email', 'fullName'];
    const orderField = sortBy && allowedSortFields.includes(sortBy) ? sortBy : 'createdAt';
    const orderDir = sortOrder === 'asc' ? 'asc' : 'desc';

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip,
        take: safeLimit,
        orderBy: { [orderField]: orderDir },
        select: {
          id: true, userId: true, email: true, fullName: true,
          kycStatus: true, isBanned: true, banReason: true,
          emailVerified: true, isActive: true, isKahadePlus: true,
          membershipRank: true, averageRating: true,
          totalOrdersAsBuyer: true, totalOrdersAsSeller: true, totalOrdersCompleted: true,
          createdAt: true, lastLoginAt: true,
          wallet: { select: { totalBalance: true, availableBalance: true } },
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    const serialized = users.map((u) => ({
      ...u,
      wallet: u.wallet ? {
        totalBalance: toIdr(u.wallet.totalBalance),
        availableBalance: toIdr(u.wallet.availableBalance),
      } : null,
    }));
    return createPaginatedResponse(serialized, total, page, safeLimit);
  }

  async getUserDetail(userId: string, adminId?: string, ipAddress?: string): Promise<object> {
    const user = await this.prisma.user.findFirst({
      where: { OR: [{ id: userId }, { userId }], deletedAt: null },
      select: {
        id: true, userId: true, email: true, fullName: true, username: true,
        avatarUrl: true, accountType: true,
        phoneNumber: true, phoneVerified: true,
        kycStatus: true, isBanned: true, banReason: true,
        emailVerified: true, isActive: true, isKahadePlus: true, membershipRank: true,
        averageRating: true,
        totalOrdersAsBuyer: true, totalOrdersAsSeller: true,
        totalOrdersCompleted: true, totalOrdersDisputed: true,
        createdAt: true, updatedAt: true, lastLoginAt: true, lastLoginIp: true,
        bio: true, headerUrl: true, usernameChangedAt: true,
        contactEmail: true, contactPhone: true,
        showContactEmail: true, showContactPhone: true,
        wallet: { select: { totalBalance: true, availableBalance: true, escrowBalance: true } },
        kycRequests: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { kycId: true, status: true, createdAt: true, reviewedAt: true, rejectionReason: true },
        },
        links: {
          orderBy: { displayOrder: 'asc' },
          select: { id: true, platform: true, url: true, label: true, displayOrder: true },
        },
        _count: {
          select: {
            followers: true,
            following: true,
            blockedUsers: true,
            reportsReceived: true,
          },
        },
      },
    });
    if (!user) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });

    // Fire-and-forget audit log — never block or fail the response
    if (adminId) {
      this.auditLog.logAdminAction({
        adminId,
        action: AuditAction.ADMIN_ACTION,
        targetType: 'User',
        targetId: user.id,
        description: `Admin viewed user detail for ${user.userId} (${user.email})`,
        ipAddress: ipAddress ?? 'unknown',
      });
    }

    const { _count, phoneNumber, ...userData } = user;
    const decryptedPhone = await decryptPiiSafe(phoneNumber);
    return {
      ...userData,
      phoneNumber: decryptedPhone,
      followersCount: _count.followers,
      followingCount: _count.following,
      blockedUsersCount: _count.blockedUsers,
      reportsReceivedCount: _count.reportsReceived,
      wallet: userData.wallet ? {
        totalBalance: toIdr(userData.wallet.totalBalance),
        availableBalance: toIdr(userData.wallet.availableBalance),
        escrowBalance: toIdr(userData.wallet.escrowBalance),
      } : null,
    };
  }

  async banUser(userId: string, reason: string, adminId: string, ipAddress: string = 'internal'): Promise<object> {
    const user = await this.prisma.user.findFirst({
      where: { OR: [{ id: userId }, { userId }], deletedAt: null },
    });
    if (!user) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    if (user.isBanned) throw new ForbiddenException({ code: ErrorCodes.USER_ALREADY_BANNED, message: 'User is already banned' });

    const now = new Date();
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        isBanned: true,
        banReason: reason,
        bannedAt: now,
        bannedBy: adminId,
      },
      select: { userId: true, isBanned: true, banReason: true, bannedAt: true, bannedBy: true },
    });

    const activeSessions = await this.prisma.userSession.findMany({
      where: { userId: user.id, isRevoked: false },
      select: { id: true },
    });

    if (activeSessions.length > 0) {
      await this.prisma.userSession.updateMany({
        where: { userId: user.id, isRevoked: false },
        data: { isRevoked: true, revokedAt: now, revokedReason: 'user_banned' },
      });

      await Promise.all(
        activeSessions.map((s) =>
          this.redis.setex(SESSION_REVOKED_KEY(s.id), this.accessTokenTtlSeconds, 'revoked'),
        ),
      );
    }

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.USER_BANNED,
      targetType: 'User',
      targetId: user.id,
      description: `Admin banned user ${user.id}. Reason: ${reason}`,
      before: { isBanned: false },
      after: { isBanned: true, banReason: reason },
      ipAddress,
    });

    return updated;
  }

  async unbanUser(userId: string, adminId: string, ipAddress: string = 'internal'): Promise<object> {
    const user = await this.prisma.user.findFirst({
      where: { OR: [{ id: userId }, { userId }], deletedAt: null },
    });
    if (!user) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    if (!user.isBanned) throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'User is not currently banned' });

    const result = await this.prisma.user.update({
      where: { id: user.id },
      data: { isBanned: false, banReason: null, bannedAt: null, bannedBy: null },
      select: { userId: true, isBanned: true },
    });

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.USER_RESTORED,
      targetType: 'User',
      targetId: user.id,
      description: `Admin unbanned user ${user.id}`,
      before: { isBanned: true },
      after: { isBanned: false },
      ipAddress,
    });

    return result;
  }

  private async resolveUserId(userId: string): Promise<string> {
    const user = await this.prisma.user.findFirst({
      where: { OR: [{ id: userId }, { userId }], deletedAt: null },
      select: { id: true },
    });
    if (!user) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    return user.id;
  }

  async getUserOrders(userId: string, page = 1, limit = 20, status?: string, adminId?: string, ipAddress?: string): Promise<object> {
    const id = await this.resolveUserId(userId);
    if (adminId) {
      this.auditLog.logAdminAction({ adminId, action: AuditAction.ADMIN_ACTION, targetType: 'User', targetId: id, description: `Viewed user orders (page=${page})`, ipAddress: ipAddress || 'unknown' });
    }
    const safeLimit = Math.min(limit, 100);
    const skip = (page - 1) * safeLimit;

    const where: Prisma.OrderWhereInput = {
      OR: [{ buyerId: id }, { sellerId: id }],
    };
    if (status) {
      where.status = status as OrderStatus;
    }

    const [orders, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        skip,
        take: safeLimit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, orderId: true, title: true, orderType: true,
          status: true, orderValue: true, feeAmount: true,
          buyerId: true, sellerId: true,
          createdAt: true, completedAt: true, cancelledAt: true,
        },
      }),
      this.prisma.order.count({ where }),
    ]);

    const serializedOrders = orders.map((o) => ({
      ...o,
      orderValue: toIdr(o.orderValue),
      feeAmount: toIdr(o.feeAmount),
    }));
    return createPaginatedResponse(serializedOrders, total, page, safeLimit);
  }

  async getUserWallet(userId: string, adminId?: string, ipAddress?: string): Promise<object> {
    const id = await this.resolveUserId(userId);
    if (adminId) {
      this.auditLog.logAdminAction({ adminId, action: AuditAction.ADMIN_ACTION, targetType: 'Wallet', targetId: id, description: 'Viewed user wallet details', ipAddress: ipAddress || 'unknown' });
    }

    const wallet = await this.prisma.wallet.findUnique({
      where: { userId: id },
      select: {
        id: true, availableBalance: true, escrowBalance: true, totalBalance: true,
        todayTopupAmount: true, todayWithdrawAmount: true,
        isLocked: true, lockedAt: true, lockReason: true,
        createdAt: true, updatedAt: true,
        transactions: {
          take: 10,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true, txId: true, type: true, status: true,
            amount: true, balanceBefore: true, balanceAfter: true,
            description: true, createdAt: true,
          },
        },
      },
    });

    if (!wallet) throw new NotFoundException({ code: ErrorCodes.WALLET_NOT_FOUND, message: 'User wallet not found' });

    return {
      ...wallet,
      availableBalance: toIdr(wallet.availableBalance),
      escrowBalance: toIdr(wallet.escrowBalance),
      totalBalance: toIdr(wallet.totalBalance),
      todayTopupAmount: toIdr(wallet.todayTopupAmount),
      todayWithdrawAmount: toIdr(wallet.todayWithdrawAmount),
      transactions: wallet.transactions.map((tx) => ({
        ...tx,
        amount: toIdr(tx.amount),
        balanceBefore: toIdr(tx.balanceBefore),
        balanceAfter: toIdr(tx.balanceAfter),
      })),
    };
  }

  async getUserSessions(userId: string, page: number = 1, limit: number = 20, adminId?: string, ipAddress?: string): Promise<object> {
    const id = await this.resolveUserId(userId);
    if (adminId) {
      this.auditLog.logAdminAction({ adminId, action: AuditAction.ADMIN_ACTION, targetType: 'UserSession', targetId: id, description: `Viewed user sessions (page=${page})`, ipAddress: ipAddress || 'unknown' });
    }
    const safeLimit = Math.min(limit, 100);
    const skip = (page - 1) * safeLimit;

    const where = { userId: id, isRevoked: false };
    const [sessions, total] = await Promise.all([
      this.prisma.userSession.findMany({
        where,
        orderBy: { lastActiveAt: 'desc' },
        skip,
        take: safeLimit,
        select: {
          id: true, deviceInfo: true, ipAddress: true,
          lastActiveAt: true, expiresAt: true, createdAt: true,
        },
      }),
      this.prisma.userSession.count({ where }),
    ]);

    return createPaginatedResponse(sessions, total, page, safeLimit);
  }

  async adjustWallet(userId: string, dto: WalletAdjustDto, adminId: string, ipAddress: string = 'internal'): Promise<{ txId: string; type: string; amount: number; reason: string; balanceAfter: number }> {
    const id = await this.resolveUserId(userId);

    const amountInSen = toSen(dto.amount);
    const isCredit = dto.type === WalletAdjustType.CREDIT;
    const txType = isCredit ? WalletTransactionType.ADMIN_CREDIT : WalletTransactionType.ADMIN_DEBIT;

    // Serial generated before the transaction to avoid Redis incr gaps on rollback.
    const serial = await this.walletTxSerial.getNext();
    const txId = generateWalletTxId(serial);

    let balanceBefore!: bigint;
    let balanceAfter!: bigint;
    let walletId!: string;

    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const wallet = await tx.wallet.findUnique({ where: { userId: id } });
      if (!wallet) throw new NotFoundException({ code: ErrorCodes.WALLET_NOT_FOUND, message: 'User wallet not found' });

      if (wallet.isLocked) {
        throw new BadRequestException({ code: ErrorCodes.WALLET_LOCKED, message: `Wallet is locked${wallet.lockReason ? `: ${wallet.lockReason}` : ''}. Unlock the wallet before adjusting.` });
      }

      if (!isCredit && wallet.availableBalance < amountInSen) {
        throw new BadRequestException({ code: ErrorCodes.INSUFFICIENT_BALANCE, message: 'Insufficient available balance for debit' });
      }

      balanceBefore = wallet.availableBalance;
      balanceAfter = isCredit ? wallet.availableBalance + amountInSen : wallet.availableBalance - amountInSen;
      walletId = wallet.id;

      const updated = await tx.wallet.updateMany({
        where: { id: wallet.id, version: wallet.version },
        data: {
          availableBalance: balanceAfter,
          totalBalance: isCredit ? wallet.totalBalance + amountInSen : wallet.totalBalance - amountInSen,
          version: { increment: 1 },
        },
      });

      if (updated.count === 0) {
        throw new ConflictException({ code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT, message: 'Concurrent wallet update detected, please retry' });
      }

      await tx.walletTransaction.create({
        data: {
          txId,
          walletId: wallet.id,
          type: txType,
          status: WalletTransactionStatus.SUCCESS,
          amount: amountInSen,
          balanceBefore,
          balanceAfter,
          description: `Admin ${dto.type.toLowerCase()}: ${dto.reason}`,
          completedAt: new Date(),
        },
      });

      const notifType = isCredit ? NotificationType.WALLET_TOPUP_SUCCESS : NotificationType.WALLET_WITHDRAW_SUCCESS;
      await tx.notification.create({
        data: {
          notifId: generateNotifId(),
          userId: id,
          type: notifType,
          category: getCategoryForType(notifType),
          title: isCredit ? 'Balance Credited by Admin' : 'Balance Debited by Admin',
          body: isCredit
            ? `Rp ${dto.amount.toLocaleString('id-ID')} has been added to your wallet balance. Reason: ${dto.reason}`
            : `Rp ${dto.amount.toLocaleString('id-ID')} has been deducted from your wallet balance. Reason: ${dto.reason}`,
          isRead: false,
        },
      });

    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    const notifTitle = isCredit ? 'Balance Credited by Admin' : 'Balance Debited by Admin';
    const notifBody = isCredit
      ? `Rp ${dto.amount.toLocaleString('id-ID')} has been added to your wallet balance. Reason: ${dto.reason}`
      : `Rp ${dto.amount.toLocaleString('id-ID')} has been deducted from your wallet balance. Reason: ${dto.reason}`;
    this.prisma.emitNotificationCreated({ userId: id, title: notifTitle, body: notifBody, data: { type: 'WALLET_ADJUSTED' } });

    const auditAction = isCredit ? AuditAction.WALLET_CREDIT : AuditAction.WALLET_DEBIT;
    this.auditLog.logAdminAction({
      adminId,
      action: auditAction,
      targetType: 'Wallet',
      targetId: walletId,
      description: `Admin ${dto.type.toLowerCase()} ${dto.amount} IDR to user ${id}. Reason: ${dto.reason}`,
      before: { availableBalance: balanceBefore.toString() },
      after: { availableBalance: balanceAfter.toString() },
      ipAddress,
    });

    return { txId, type: dto.type, amount: dto.amount, reason: dto.reason, balanceAfter: toIdr(balanceAfter) };
  }

  async getUserAuditLog(userId: string, page = 1, limit = 20, adminId?: string, ipAddress?: string): Promise<object> {
    const id = await this.resolveUserId(userId);
    if (adminId) {
      this.auditLog.logAdminAction({ adminId, action: AuditAction.ADMIN_ACTION, targetType: 'AuditLog', targetId: id, description: `Viewed user audit log (page=${page})`, ipAddress: ipAddress || 'unknown' });
    }
    const safeLimit = Math.min(limit, 100);
    const skip = (page - 1) * safeLimit;

    const [logs, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where: { userId: id },
        skip,
        take: safeLimit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, action: true, entityType: true, entityId: true,
          description: true, ipAddress: true, createdAt: true,
        },
      }),
      this.prisma.auditLog.count({ where: { userId: id } }),
    ]);

    return createPaginatedResponse(logs, total, page, safeLimit);
  }

  async forceLogout(userId: string, adminId: string, ipAddress: string = 'internal'): Promise<{ message: string; revokedCount: number }> {
    const id = await this.resolveUserId(userId);
    const now = new Date();

    const activeSessions = await this.prisma.userSession.findMany({
      where: { userId: id, isRevoked: false },
      select: { id: true },
    });

    if (activeSessions.length === 0) {
      return { message: 'No active sessions found', revokedCount: 0 };
    }

    await this.prisma.userSession.updateMany({
      where: { userId: id, isRevoked: false },
      data: { isRevoked: true, revokedAt: now, revokedReason: 'admin_force_logout' },
    });

    await Promise.all(
      activeSessions.map((s) =>
        this.redis.setex(SESSION_REVOKED_KEY(s.id), this.accessTokenTtlSeconds, 'revoked').catch((error: unknown) => {
          // DB revocation above is durable and is checked by JwtAuthGuard. Redis is
          // only an acceleration layer here; do not report a successful force logout
          // as failed merely because cache propagation is temporarily unavailable.
          this.logger.warn(`Admin force logout Redis propagation failed for session ${s.id}: ${error instanceof Error ? error.message : String(error)}`);
        }),
      ),
    );

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'User',
      targetId: id,
      description: `Admin force-logged out user ${id}. ${activeSessions.length} session(s) revoked.`,
      ipAddress,
    });

    return { message: 'All sessions revoked', revokedCount: activeSessions.length };
  }

  async revokeUserSession(userId: string, sessionId: string, adminId: string, ipAddress: string = 'internal'): Promise<{ message: string }> {
    const id = await this.resolveUserId(userId);

    const session = await this.prisma.userSession.findFirst({
      where: { id: sessionId, userId: id, isRevoked: false },
    });

    if (!session) {
      throw new NotFoundException({ code: ErrorCodes.SESSION_NOT_FOUND, message: 'Active session not found for this user' });
    }

    await this.prisma.userSession.update({
      where: { id: sessionId },
      data: { isRevoked: true, revokedAt: new Date(), revokedReason: 'admin_revoke_session' },
    });

    await this.redis.setex(SESSION_REVOKED_KEY(sessionId), this.accessTokenTtlSeconds, 'revoked').catch((error: unknown) => {
      // The session is already revoked durably in PostgreSQL and JwtAuthGuard
      // checks that record. Redis propagation is best-effort acceleration only.
      this.logger.warn(`Admin session Redis propagation failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    });

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'UserSession',
      targetId: sessionId,
      description: `Admin revoked session ${sessionId} for user ${id}`,
      ipAddress,
    });

    return { message: 'Session revoked' };
  }

  async resetUserPassword(userId: string, adminId: string, ipAddress: string = 'internal'): Promise<{ message: string }> {
    const id = await this.resolveUserId(userId);

    const user = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, email: true, isActive: true, isBanned: true },
    });

    if (!user) {
      throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    }
    if (!user.isActive || user.isBanned) {
      throw new BadRequestException({ code: ErrorCodes.ACCOUNT_INACTIVE, message: 'Cannot reset password for inactive or banned account' });
    }

    // Phone-only accounts (phoneRegister) have no email. The old `user.email ?? ''`
    // fallback made every emailless account share the '' OTP bucket (see auth.service
    // requestDisable2faOtp for full explanation) and sent mail to '', a silent dead end.
    // Admin-initiated resets need email delivery; reject explicitly if none exists.
    if (!user.email) {
      throw new BadRequestException({
        code: 'EMAIL_NOT_CONFIGURED',
        message: 'User has no email address on file — cannot send password reset.',
      });
    }

    await this.otpService.invalidateOtps(user.email, OtpType.PASSWORD_RESET);
    const otp = await this.otpService.generateOtp(user.email, OtpType.PASSWORD_RESET, user.id);

    await this.emailQueue.add('send', {
      to: user.email,
      subject: 'Kahade - Reset Password (Admin Request)',
      templateName: 'admin-password-reset',
      templateContext: { otp },
    }, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } });

    this.auditLog.logAdminAction({
      adminId,
      action: AuditAction.ADMIN_ACTION,
      targetType: 'User',
      targetId: id,
      description: `Admin triggered password reset OTP for user ${id}`,
      ipAddress,
    });

    return { message: 'Password reset email sent to user' };
  }
}
