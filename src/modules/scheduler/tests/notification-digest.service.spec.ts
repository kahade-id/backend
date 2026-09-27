import { NotificationDigestService, DigestPrefs } from '../services/notification-digest.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';

/**
 * Item 8 (batch 2026-09-28) — Digest notifikasi.
 * - Jatuh tempo: daily sekali sehari ≥07:00 waktu lokal; weekly tiap Senin ≥07:00.
 * - Quiet hours: dilewati (status 'quiet'), tetap jatuh tempo di tick berikut.
 * - Hanya kirim bila ada konten; tanpa konten → lastDigestSentAt tetap maju.
 *
 * Acuan waktu: Senin 2026-09-28. WIB = UTC+7.
 */
describe('NotificationDigestService', () => {
  const mockPrisma = {
    notificationPreference: { findMany: jest.fn(), update: jest.fn() },
    follow: { findMany: jest.fn(), count: jest.fn() },
    showcaseLike: { count: jest.fn() },
    notification: { count: jest.fn(), create: jest.fn() },
    emitNotificationCreated: jest.fn(),
  };
  const mockRedis = {
    isHealthy: jest.fn().mockResolvedValue(true),
    setNx: jest.fn(),
    get: jest.fn(),
    del: jest.fn(),
  };

  let service: NotificationDigestService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRedis.isHealthy.mockResolvedValue(true);
    service = new NotificationDigestService(
      mockPrisma as unknown as PrismaService,
      mockRedis as unknown as RedisService,
    );
  });

  const basePrefs = (overrides: Partial<DigestPrefs> = {}): DigestPrefs => ({
    userId: 'user-1',
    digestFrequency: 'daily',
    lastDigestSentAt: null,
    quietHoursEnabled: false,
    quietHoursStart: '22:00',
    quietHoursEnd: '07:00',
    quietHoursTimezone: 'Asia/Jakarta',
    ...overrides,
  });

  describe('isDigestDue', () => {
    it('daily: jatuh tempo bila belum pernah dikirim (Senin 09:00 WIB)', () => {
      const now = new Date('2026-09-28T02:00:00Z'); // 09:00 WIB
      expect(service.isDigestDue(basePrefs(), now)).toBe('due');
    });

    it('daily: tidak jatuh tempo bila sudah dikirim hari ini', () => {
      const now = new Date('2026-09-28T02:00:00Z'); // 09:00 WIB Senin
      const prefs = basePrefs({ lastDigestSentAt: new Date('2026-09-28T00:30:00Z') }); // 07:30 WIB
      expect(service.isDigestDue(prefs, now)).toBe('not-due');
    });

    it('daily: jatuh tempo bila terakhir dikirim kemarin', () => {
      const now = new Date('2026-09-28T02:00:00Z'); // 09:00 WIB Senin
      const prefs = basePrefs({ lastDigestSentAt: new Date('2026-09-27T10:00:00Z') }); // 17:00 WIB Minggu
      expect(service.isDigestDue(prefs, now)).toBe('due');
    });

    it('daily: belum jatuh tempo sebelum 07:00 waktu lokal', () => {
      const now = new Date('2026-09-27T23:00:00Z'); // 06:00 WIB Senin
      const prefs = basePrefs({ lastDigestSentAt: new Date('2026-09-27T10:00:00Z') });
      expect(service.isDigestDue(prefs, now)).toBe('not-due');
    });

    it('weekly: jatuh tempo tiap Senin bila terakhir dikirim pekan lalu', () => {
      const now = new Date('2026-09-28T02:00:00Z'); // Senin 09:00 WIB
      const prefs = basePrefs({ digestFrequency: 'weekly', lastDigestSentAt: new Date('2026-09-21T02:00:00Z') });
      expect(service.isDigestDue(prefs, now)).toBe('due');
    });

    it('weekly: tidak jatuh tempo di hari Selasa', () => {
      const now = new Date('2026-09-29T02:00:00Z'); // Selasa 09:00 WIB
      const prefs = basePrefs({ digestFrequency: 'weekly', lastDigestSentAt: new Date('2026-09-21T02:00:00Z') });
      expect(service.isDigestDue(prefs, now)).toBe('not-due');
    });

    it('off: tidak pernah jatuh tempo', () => {
      const now = new Date('2026-09-28T02:00:00Z');
      expect(service.isDigestDue(basePrefs({ digestFrequency: 'off' }), now)).toBe('not-due');
      expect(service.isDigestDue(basePrefs({ digestFrequency: null }), now)).toBe('not-due');
    });

    it('quiet hours: dilewati walau jatuh tempo (Minggu 23:00 WIB)', () => {
      const now = new Date('2026-09-27T16:00:00Z'); // 23:00 WIB
      const prefs = basePrefs({ quietHoursEnabled: true });
      expect(service.isDigestDue(prefs, now)).toBe('quiet');
    });

    it('di luar quiet hours: tetap dikirim (Senin 09:00 WIB)', () => {
      const now = new Date('2026-09-28T02:00:00Z'); // 09:00 WIB
      const prefs = basePrefs({ quietHoursEnabled: true });
      expect(service.isDigestDue(prefs, now)).toBe('due');
    });
  });

  describe('processUserDigest', () => {
    const noContent = () => {
      mockPrisma.follow.findMany.mockResolvedValue([]);
      mockPrisma.follow.count.mockResolvedValue(0);
      mockPrisma.showcaseLike.count.mockResolvedValue(0);
      mockPrisma.notification.count.mockResolvedValue(0);
      mockPrisma.notificationPreference.update.mockResolvedValue({});
    };

    it('melewati user yang sedang quiet hours tanpa memajukan penanda', async () => {
      const now = new Date('2026-09-27T16:00:00Z'); // 23:00 WIB
      const result = await service.processUserDigest(basePrefs({ quietHoursEnabled: true }), now);
      expect(result).toBe('skipped');
      expect(mockPrisma.notificationPreference.update).not.toHaveBeenCalled();
      expect(mockPrisma.notification.create).not.toHaveBeenCalled();
    });

    it('tidak mengirim bila tidak ada konten, tapi memajukan lastDigestSentAt', async () => {
      noContent();
      const now = new Date('2026-09-28T02:00:00Z');
      const result = await service.processUserDigest(basePrefs(), now);
      expect(result).toBe('empty');
      expect(mockPrisma.notification.create).not.toHaveBeenCalled();
      expect(mockPrisma.notificationPreference.update).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        data: { lastDigestSentAt: now },
      });
    });

    it('mengirim digest berisi follower baru + like + update order', async () => {
      mockPrisma.follow.findMany.mockResolvedValue([
        { follower: { username: 'budi', fullName: 'Budi Santoso' } },
        { follower: { username: 'siti', fullName: null } },
      ]);
      mockPrisma.follow.count.mockResolvedValue(2);
      mockPrisma.showcaseLike.count.mockResolvedValue(5);
      mockPrisma.notification.count.mockResolvedValue(3);
      mockPrisma.notification.create.mockResolvedValue({});
      mockPrisma.notificationPreference.update.mockResolvedValue({});

      const now = new Date('2026-09-28T02:00:00Z');
      const result = await service.processUserDigest(basePrefs(), now);

      expect(result).toBe('sent');
      expect(mockPrisma.notification.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'user-1',
          type: 'DIGEST_SUMMARY',
          title: 'Ringkasan Harian',
          body: expect.stringContaining('2 pengikut baru'),
        }),
      });
      const body = mockPrisma.notification.create.mock.calls[0][0].data.body as string;
      expect(body).toContain('5 suka baru di etalase Anda');
      expect(body).toContain('3 update order');
    });
  });

  describe('sendDigests (cron)', () => {
    it('melewati tick bila lock tidak didapat', async () => {
      mockRedis.setNx.mockResolvedValue(false);
      await service.sendDigests();
      expect(mockPrisma.notificationPreference.findMany).not.toHaveBeenCalled();
    });

    it('memproses batch dan melepas lock milik sendiri', async () => {
      mockRedis.setNx.mockResolvedValue(true);
      // get mengembalikan token yang tadi ditulis setNx → del dipanggil.
      mockRedis.get.mockImplementation(async () => mockRedis.setNx.mock.calls[0][1] as string);
      mockPrisma.notificationPreference.findMany.mockResolvedValue([
        basePrefs({ userId: 'user-1' }),
        basePrefs({ userId: 'user-2', digestFrequency: 'off' }),
      ]);
      mockPrisma.follow.findMany.mockResolvedValue([]);
      mockPrisma.follow.count.mockResolvedValue(0);
      mockPrisma.showcaseLike.count.mockResolvedValue(0);
      mockPrisma.notification.count.mockResolvedValue(0);
      mockPrisma.notificationPreference.update.mockResolvedValue({});

      // Freeze waktu ke Senin 09:00 WIB via spy pada isDigestDue? — pakai waktu nyata;
      // user-1 lastDigestSentAt null → due kapan pun di luar quiet hours (quiet off).
      await service.sendDigests();

      expect(mockPrisma.notificationPreference.update).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        data: { lastDigestSentAt: expect.any(Date) },
      });
      // user-2 digest off → tidak diproses
      expect(mockPrisma.notificationPreference.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'user-2' } }),
      );
      expect(mockRedis.del).toHaveBeenCalledWith('cron_lock:notification_digest');
    });
  });
});
