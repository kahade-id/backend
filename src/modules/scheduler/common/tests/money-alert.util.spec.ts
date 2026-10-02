import { Logger } from '@nestjs/common';
import { alertAdminsOnMoneyAnomaly, alertDisbursementNeedsAttention } from '../money-alert.util';
import { PrismaService } from '../../../../prisma/prisma.service';
import { RedisService } from '../../../../redis/redis.service';

function makeDeps(opts?: { dedupFirst?: boolean; admins?: Array<{ id: string }> }) {
  const adminAuditLogCreate = jest.fn().mockResolvedValue({});
  const adminUserFindMany = jest.fn().mockResolvedValue(opts?.admins ?? [{ id: 'admin-1' }]);
  const adminUserFindFirst = jest.fn().mockResolvedValue(null);
  const prisma = {
    adminUser: { findMany: adminUserFindMany, findFirst: adminUserFindFirst },
    adminAuditLog: { create: adminAuditLogCreate },
  } as unknown as PrismaService;
  const setNx = jest.fn().mockResolvedValue(opts?.dedupFirst ?? true);
  const setex = jest.fn().mockResolvedValue('OK');
  const redis = { setNx, setex } as unknown as RedisService;
  const logger = new Logger('money-alert-test');
  return { prisma, redis, logger, adminAuditLogCreate, adminUserFindFirst, setNx, setex };
}

const baseInput = (d: ReturnType<typeof makeDeps>) => ({
  prisma: d.prisma,
  redis: d.redis,
  logger: d.logger,
  title: 'Anomali uji',
  body: 'badan anomali',
  targetType: 'PaymentTransaction',
  targetId: 'pay-1',
  redisAlertKey: 'uji_alert',
});

describe('alertAdminsOnMoneyAnomaly (SYS-B-101/301/302/303/304/306)', () => {
  it('menulis adminAuditLog + redis alert key pada alert pertama', async () => {
    const d = makeDeps();
    const sent = await alertAdminsOnMoneyAnomaly(baseInput(d));
    expect(sent).toBe(true);
    expect(d.adminAuditLogCreate).toHaveBeenCalledTimes(1);
    const data = d.adminAuditLogCreate.mock.calls[0][0].data;
    expect(data.description).toContain('[SYSTEM ALERT]');
    expect(data.description).toContain('Anomali uji');
    expect(data.targetType).toBe('PaymentTransaction');
    expect(d.setex).toHaveBeenCalledWith(
      'cron_alert:uji_alert',
      86400,
      expect.stringContaining('Anomali uji'),
    );
  });

  it('dedup: alert kedua dalam TTL tidak dikirim ulang (return false)', async () => {
    const d = makeDeps({ dedupFirst: false });
    const sent = await alertAdminsOnMoneyAnomaly({
      ...baseInput(d),
      dedupKey: 'dedupe:uji-1',
      dedupTtlSeconds: 3600,
    });
    expect(sent).toBe(false);
    expect(d.setNx).toHaveBeenCalledWith('dedupe:uji-1', expect.any(String), 3600);
    expect(d.adminAuditLogCreate).not.toHaveBeenCalled();
    expect(d.setex).not.toHaveBeenCalled();
  });

  it('fallback ke admin aktif manapun bila tak ada SUPER_ADMIN', async () => {
    const d = makeDeps({ admins: [] });
    d.adminUserFindFirst.mockResolvedValue({ id: 'admin-x' });
    await alertAdminsOnMoneyAnomaly(baseInput(d));
    expect(d.adminAuditLogCreate).toHaveBeenCalledTimes(1);
    expect(d.adminAuditLogCreate.mock.calls[0][0].data.adminId).toBe('admin-x');
  });
});

describe('alertDisbursementNeedsAttention (SYS-B-306)', () => {
  it('HELD_NO_BANK: judul, dedup key 7 hari, dan isi deskripsi benar', async () => {
    const d = makeDeps();
    const ok = await alertDisbursementNeedsAttention({
      prisma: d.prisma,
      redis: d.redis,
      logger: d.logger,
      disbursementId: 'disb-1',
      idempotencyKey: 'KEY-1',
      status: 'HELD_NO_BANK',
      reason: 'seller belum punya rekening',
    });
    expect(ok).toBe(true);
    expect(d.setNx).toHaveBeenCalledWith('disbursement_alerted:disb-1', expect.any(String), 7 * 86400);
    const data = d.adminAuditLogCreate.mock.calls[0][0].data;
    expect(data.description).toContain('HELD_NO_BANK');
    expect(data.description).toContain('disb-1');
    expect(data.targetType).toBe('EscrowDisbursement');
  });

  it('NEEDS_REVIEW: judul berbeda sesuai status', async () => {
    const d = makeDeps();
    await alertDisbursementNeedsAttention({
      prisma: d.prisma,
      redis: d.redis,
      logger: d.logger,
      disbursementId: 'disb-2',
      status: 'NEEDS_REVIEW',
      reason: 'nominal mismatch',
    });
    const data = d.adminAuditLogCreate.mock.calls[0][0].data;
    expect(data.description).toContain('NEEDS_REVIEW');
  });
});
