import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { cronJitter } from '../../../common/utils/cron-jitter.util';
import { alertMoneyCronSkippedRedisDown, ensureRedisAvailable } from '../../../common/utils/redis-health.util';
import { toIdr } from '../../../common/utils/currency.util';
import { safeErrorMessage } from '../../../common/utils/background-reliability.util';
import { alertAdminsOnMoneyAnomaly } from '../common/money-alert.util';

/** APPROVED lebih tua dari ini (tanpa EXECUTED) dianggap yatim. */
const STALE_APPROVED_MS = 15 * 60 * 1000;

/**
 * SYS-B-303 (audit sistemik ronde 3): pemulih untuk claim-state
 * `admin_action_approvals.APPROVED` yang macet.
 *
 * Klaim atomik PENDING→APPROVED dilakukan SEBELUM executor berjalan;
 * exception mengembalikan ke PENDING, tetapi crash proses di tengah executor
 * → APPROVED selamanya. `listPending()` hanya menampilkan PENDING dan tidak
 * ada cron → aksi uang admin yang sudah disetujui hilang dari antrean.
 *
 * Sweep tiap 10 menit: APPROVED dengan decidedAt basi (>15 mnt) → kembalikan
 * ke PENDING + audit log + alert. Batas 15 menit mengasumsikan eksekusi
 * approval berjalan cepat; eksekutor yang sah namun lambat akan di-reset dan
 * dijemput ulang — dapat diterima karena executor dirancang idempoten per
 * actionType/idempotencyKey, dan setiap reset ter-alert sehingga terlihat.
 *
 * SYS-B-306 (hygiene): expiry approval 24 jam selama ini hanya lazy di
 * `listPending()`/`assertPending()`. Cron per jam menandai PENDING yang
 * expiresAt-nya lewat menjadi EXPIRED + audit + alert (semantik sama dengan
 * lazy-marking yang ada).
 *
 * File `approvals.service.ts` TIDAK diubah — sweep via Prisma langsung.
 */
@Injectable()
export class AdminApprovalSweepService {
  private readonly logger = new Logger(AdminApprovalSweepService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
  ) {}

  // Tiap 10 menit — aksi uang yang disetujui tak boleh menggantung lama.
  @Cron('*/10 * * * *', { name: 'stale-approval-recovery', timeZone: 'Asia/Jakarta' })
  async recoverStaleApproved(): Promise<void> {
    await cronJitter(10_000);
    if (!(await ensureRedisAvailable(this.redis, 'stale-approval-recovery', {
        onRedisDown: () => alertMoneyCronSkippedRedisDown('stale-approval-recovery'),
      }))) return;

    const lockKey = 'cron_lock:stale_approval_recovery';
    const lockToken = randomUUID();
    if (!(await this.redis.setNx(lockKey, lockToken, 480))) return;

    try {
      const staleBefore = new Date(Date.now() - STALE_APPROVED_MS);
      const stale = await this.prisma.adminActionApproval.findMany({
        where: { status: 'APPROVED', decidedAt: { lt: staleBefore }, executedAt: null },
        select: {
          id: true,
          actionType: true,
          targetId: true,
          amountSen: true,
          proposedBy: true,
          decidedBy: true,
          decidedAt: true,
        },
        orderBy: { decidedAt: 'asc' },
        take: 100,
      });

      let recovered = 0;
      for (const row of stale) {
        const reset = await this.prisma.adminActionApproval.updateMany({
          where: { id: row.id, status: 'APPROVED', executedAt: null },
          data: { status: 'PENDING', decidedBy: null, decidedAt: null },
        });
        if (reset.count === 0) continue;
        recovered++;

        const amount = row.amountSen != null ? ` amount=${toIdr(row.amountSen)}` : '';
        this.logger.error(
          `STALE_APPROVAL dipulihkan: ${row.id} action=${row.actionType} target=${row.targetId ?? '-'}${amount} ` +
            `decidedBy=${row.decidedBy ?? '-'} sejak ${row.decidedAt?.toISOString()} → PENDING`,
        );
        await alertAdminsOnMoneyAnomaly({
          prisma: this.prisma,
          redis: this.redis,
          logger: this.logger,
          title: `Stale approval dipulihkan: ${row.actionType}`,
          body:
            `AdminActionApproval ${row.id} (action=${row.actionType}, target=${row.targetId ?? '-'}${amount}) ` +
            `macet di APPROVED sejak ${row.decidedAt?.toISOString()} (kemungkinan crash di tengah executor) ` +
            `→ dikembalikan ke PENDING agar bisa dieksekusi ulang. Pengusul: ${row.proposedBy}, ` +
            `penyetuju: ${row.decidedBy ?? '-'}. Verifikasi tidak terjadi eksekusi ganda sebelum menyetujui ulang.`,
          targetType: 'AdminActionApproval',
          targetId: row.id,
          redisAlertKey: 'stale_approval_recovered',
          dedupKey: `stale_approval_alerted:${row.id}`,
          dedupTtlSeconds: 86400,
        });
      }

      if (stale.length > 0 || recovered > 0) {
        this.logger.log(`stale-approval-recovery: stale=${stale.length} recovered=${recovered}`);
      }
    } catch (error) {
      this.logger.error(`stale-approval-recovery gagal: ${safeErrorMessage(error)}`);
    } finally {
      await this.redis.releaseLock(lockKey, lockToken).catch(() => undefined);
    }
  }

  // Tiap jam — expiry 24 jam selama ini hanya lazy di listPending().
  @Cron('5 * * * *', { name: 'approval-expiry', timeZone: 'Asia/Jakarta' })
  async expireOverdueApprovals(): Promise<void> {
    await cronJitter(10_000);
    if (!(await ensureRedisAvailable(this.redis, 'approval-expiry'))) return;

    const lockKey = 'cron_lock:approval_expiry';
    const lockToken = randomUUID();
    if (!(await this.redis.setNx(lockKey, lockToken, 480))) return;

    try {
      const now = new Date();
      const overdue = await this.prisma.adminActionApproval.findMany({
        where: { status: 'PENDING', expiresAt: { lte: now } },
        select: { id: true, actionType: true, targetId: true, amountSen: true, proposedBy: true, expiresAt: true },
        orderBy: { expiresAt: 'asc' },
        take: 200,
      });

      let expired = 0;
      for (const row of overdue) {
        const marked = await this.prisma.adminActionApproval.updateMany({
          where: { id: row.id, status: 'PENDING' },
          data: { status: 'EXPIRED' },
        });
        if (marked.count === 0) continue;
        expired++;
        this.logger.log(
          `approval-expiry: ${row.id} action=${row.actionType} target=${row.targetId ?? '-'} → EXPIRED (24 jam terlewati)`,
        );
      }

      if (expired > 0) {
        await alertAdminsOnMoneyAnomaly({
          prisma: this.prisma,
          redis: this.redis,
          logger: this.logger,
          title: `Approval kedaluwarsa: ${expired} usulan`,
          body:
            `${expired} usulan aksi admin melewati batas 24 jam tanpa keputusan → EXPIRED. ` +
            `Contoh: ${overdue.slice(0, 5).map(r => `${r.actionType}(${r.id})`).join(', ')}. ` +
            `Buat usulan baru bila aksi masih diperlukan.`,
          targetType: 'AdminActionApproval',
          targetId: 'approval-expiry',
          redisAlertKey: 'approval_expired',
        });
        this.logger.log(`approval-expiry: expired=${expired}`);
      }

      await this.redis
        .setex('cron_heartbeat:approval_expiry', 86400, JSON.stringify({ ranAt: now.toISOString(), expired }))
        .catch(() => undefined);
    } catch (error) {
      this.logger.error(`approval-expiry gagal: ${safeErrorMessage(error)}`);
    } finally {
      await this.redis.releaseLock(lockKey, lockToken).catch(() => undefined);
    }
  }
}
