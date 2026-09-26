/**
 * Push audit fixes — regression tests (2026-09-26).
 *
 * Mencakup:
 *  - Voucher/cashback/bonus topup/reminder dipetakan ke marketingPush
 *    (opt-out dihormati).
 *  - Quiet hours WIB ditegakkan di jalur push nyata; SECURITY_* lolos.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PushService } from '../push.service';
import { PrismaService } from '../../../prisma/prisma.service';

jest.mock('firebase-admin', () => ({
  apps: [],
  initializeApp: jest.fn(),
  credential: { cert: jest.fn() },
  messaging: jest.fn(),
}));

const mockPrisma = {
  notification: { findFirst: jest.fn(), update: jest.fn() },
  notificationPreference: { findUnique: jest.fn() },
  userDevice: { findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  onNotificationCreated: jest.fn(),
};
const mockConfig = { get: jest.fn() };

describe('PushService audit fixes', () => {
  let service: PushService;

  beforeEach(async () => {
    jest.resetAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PushService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();
    service = module.get<PushService>(PushService);
  });

  describe('preference mapping (marketing opt-out)', () => {
    const cases: Array<[string, string]> = [
      ['VOUCHER_ISSUED', 'marketingPush'],
      ['CAMPAIGN_CASHBACK_CREDITED', 'marketingPush'],
      ['TOPUP_BONUS_CREDITED', 'marketingPush'],
      ['QUESTION_UNANSWERED_REMINDER', 'marketingPush'],
    ];
    it.each(cases)('%s → %s', (type, expected) => {
      expect((service as any).getPushPrefFieldForType(type)).toBe(expected);
    });

    it('tipe transaksi/chat tetap memakai kunci masing-masing', () => {
      expect((service as any).getPushPrefFieldForType('ORDER_NEW')).toBe('orderPush');
      expect((service as any).getPushPrefFieldForType('CHAT_NEW_MESSAGE')).toBe('chatPush');
      expect((service as any).getPushPrefFieldForType('SECURITY_NEW_LOGIN')).toBe('securityPush');
    });
  });

  describe('quiet hours', () => {
    // 2026-09-26 16:00 UTC = 23:00 WIB (dalam quiet hours 22:00–07:00).
    const QUIET_DATE = new Date('2026-09-26T16:00:00Z');
    // 2026-09-26 03:00 UTC = 10:00 WIB (di luar quiet hours).
    const DAY_DATE = new Date('2026-09-26T03:00:00Z');

    beforeEach(() => {
      jest.useFakeTimers().setSystemTime(QUIET_DATE);
      mockPrisma.notificationPreference.findUnique.mockResolvedValue({
        quietHoursEnabled: true,
        quietHoursStart: '22:00',
        quietHoursEnd: '07:00',
      });
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('menahan push non-keamanan saat quiet hours', async () => {
      const allowed = await (service as any).shouldSendPush('u1', { notificationType: 'ORDER_NEW' });
      expect(allowed).toBe(false);
    });

    it('meloloskan SECURITY_* saat quiet hours', async () => {
      const allowed = await (service as any).shouldSendPush('u1', { notificationType: 'SECURITY_NEW_LOGIN' });
      expect(allowed).toBe(true);
    });

    it('mengirim normal di luar quiet hours', async () => {
      jest.setSystemTime(DAY_DATE);
      mockPrisma.notificationPreference.findUnique.mockResolvedValue({
        quietHoursEnabled: true,
        quietHoursStart: '22:00',
        quietHoursEnd: '07:00',
        orderPush: true,
      });
      const allowed = await (service as any).shouldSendPush('u1', { notificationType: 'ORDER_NEW' });
      expect(allowed).toBe(true);
    });

    it('nonaktif bila preferensi quiet hours mati', async () => {
      mockPrisma.notificationPreference.findUnique.mockResolvedValue({
        quietHoursEnabled: false,
        orderPush: true,
      });
      const allowed = await (service as any).shouldSendPush('u1', { notificationType: 'ORDER_NEW' });
      expect(allowed).toBe(true);
    });
  });
});
