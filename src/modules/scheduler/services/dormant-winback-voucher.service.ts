import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomBytes, randomUUID } from 'crypto';
import { NotificationType, OrderStatus, Prisma, VoucherApplicability, VoucherType } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { NotificationQueueService } from '../../queue/notification-queue.service';
import { cronJitter } from '../../../common/utils/cron-jitter.util';
import { ensureRedisAvailable } from '../../../common/utils/redis-health.util';

const DORMANT_DAYS = 30;
const DORMANT_WINBACK_AMOUNT = BigInt(10_000 * 100);
const DORMANT_WINBACK_VALID_DAYS = 30;
const DORMANT_BATCH_SIZE = 200;

@Injectable()
export class DormantWinbackVoucherService {
  private readonly logger = new Logger(DormantWinbackVoucherService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private notificationQueue: NotificationQueueService,
  ) {}

  @Cron('0 3 1 * *', { name: 'dormant-winback-vouchers' })
  async issueMonthlyWinbackVouchers(): Promise<void> {
    await cronJitter(30_000);
    if (!(await ensureRedisAvailable(this.redis, 'dormant-winback-vouchers'))) return;

    const lockKey = 'cron_lock:dormant_winback_vouchers';
    const lockToken = randomUUID();
    const acquired = await this.redis.setNx(lockKey, lockToken, 3600);
    if (!acquired) return;

    try {
      const now = new Date();
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const cutoff = new Date(now.getTime() - DORMANT_DAYS * 24 * 60 * 60 * 1000);
      let cursor: string | undefined;
      let issued = 0;

      while (true) {
        const users = await this.prisma.user.findMany({
          where: {
            isActive: true,
            isBanned: false,
            deletedAt: null,
            totalOrdersCompleted: { gt: 0 },
            ordersAsBuyer: { none: { status: OrderStatus.COMPLETED, deletedAt: null, completedAt: { gte: cutoff } } },
            ordersAsSeller: { none: { status: OrderStatus.COMPLETED, deletedAt: null, completedAt: { gte: cutoff } } },
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          take: DORMANT_BATCH_SIZE,
          select: { id: true, userId: true },
        });
        if (users.length === 0) break;
        cursor = users[users.length - 1].id;

        for (const user of users) {
          const existing = await this.prisma.voucher.findFirst({
            where: {
              assignedToUserId: user.id,
              createdBy: 'SYSTEM_DORMANT_WINBACK',
              createdAt: { gte: monthStart },
            },
            select: { id: true },
          });
          if (existing) continue;

          const validUntil = new Date(now.getTime() + DORMANT_WINBACK_VALID_DAYS * 24 * 60 * 60 * 1000);
          const code = `DORMANT-${user.userId.replace(/[^A-Z0-9]/gi, '').slice(-8).toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`.slice(0, 50);
          try {
            const voucher = await this.prisma.voucher.create({
              data: {
                voucherId: `VCH-${code}`,
                code,
                name: 'Dormant Win-back Voucher',
                description: 'Voucher win-back untuk pengguna yang belum menyelesaikan order lebih dari 30 hari.',
                voucherType: VoucherType.FEE_DISCOUNT_FLAT,
                discountAmount: DORMANT_WINBACK_AMOUNT,
                discountPercent: null,
                maxDiscountAmount: null,
                maxUsageTotal: 1,
                maxUsagePerUser: 1,
                currentUsage: 0,
                applicableTo: VoucherApplicability.DORMANT_USER,
                isActive: true,
                validFrom: now,
                validUntil,
                createdBy: 'SYSTEM_DORMANT_WINBACK',
                assignedToUserId: user.id,
              },
            });
            issued++;
            await this.notificationQueue.enqueue({
              userId: user.id,
              type: NotificationType.VOUCHER_ISSUED,
              title: 'Voucher Win-back untuk Anda',
              body: `Voucher ${voucher.code} sudah ditambahkan untuk transaksi berikutnya. Berlaku sampai ${validUntil.toLocaleDateString('id-ID')}.`,
              pushData: { type: 'VOUCHER_ISSUED', voucherCode: voucher.code },
            });
          } catch (error: unknown) {
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') continue;
            this.logger.error(`Failed to issue dormant voucher for user ${user.userId}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (users.length < DORMANT_BATCH_SIZE) break;
      }

      if (issued > 0) this.logger.log(`Issued ${issued} dormant win-back voucher(s)`);
    } finally {
      await this.redis.releaseLock(lockKey, lockToken).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
    }
  }
}
