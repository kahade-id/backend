import { Test, TestingModule } from '@nestjs/testing';
import { WalletService } from '../../wallet/wallet.service';
import { ActionLocationService } from '../action-location.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { ConfigService } from '@nestjs/config';
import { WalletTxSerialService } from '../../../common/services/wallet-tx-serial.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { MidtransService } from '../../payment/midtrans.service';
import { OtpService } from '../../auth/otp.service';
import { OtpGatewayService } from '../../auth/otp-gateway.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { EMAIL_QUEUE } from '../../queue/processors/email.processor';
import { getQueueToken } from '@nestjs/bull';
import { bcryptHash, getBcryptRounds } from '../../../common/utils/crypto.util';

// Chain test: aksi wallet tetap sukses walau tulis log lokasi gagal.
// WalletService.setPin memakai ActionLocationService ASLI (bukan mock) +
// PrismaService mock — membuktikan best-effort end-to-end di service layer.

describe('WalletService + ActionLocationService (best-effort chain)', () => {
  let walletService: WalletService;
  const created: any[] = [];

  const mockPrisma: any = {
    user: {
      findUnique: jest.fn(),
    },
    wallet: {
      findUnique: jest.fn(async () => ({ id: 'w-1', userId: 'user-1', walletPinHash: null })),
      update: jest.fn(async () => ({})),
    },
    actionLocation: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `al-${created.length}`, ...data, createdAt: new Date() };
        created.push(row);
        return row;
      }),
    },
  };

  const mockConfig: any = {
    get: jest.fn((key: string) => {
      if (key === 'app.walletPinPepper' || key === 'WALLET_PIN_PEPPER') return 'test-pepper-32-chars-minimum-ok';
      return undefined;
    }),
  };

  beforeEach(async () => {
    created.length = 0;
    jest.clearAllMocks();
    // Password user asli (bcrypt) agar bcryptCompare('secretpw', hash) lolos.
    mockPrisma.user.findUnique.mockResolvedValue({
      password: await bcryptHash('secretpw', getBcryptRounds()),
    });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletService,
        ActionLocationService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: {} },
        { provide: ConfigService, useValue: mockConfig },
        { provide: WalletTxSerialService, useValue: {} },
        { provide: AuditLogService, useValue: {} },
        { provide: MidtransService, useValue: {} },
        { provide: OtpService, useValue: {} },
        { provide: OtpGatewayService, useValue: {} },
        { provide: RealtimeService, useValue: {} },
        { provide: getQueueToken(EMAIL_QUEUE), useValue: {} },
      ],
    }).compile();
    walletService = module.get<WalletService>(WalletService);
  });

  it('setPin sukses + lokasi tercatat (WALLET_PIN_CHANGE)', async () => {
    const result = await walletService.setPin('user-1', '482915', undefined, 'secretpw', '1.2.3.4', {
      location: { latitude: -6.2, longitude: 106.85, accuracy: 10, source: 'gps' },
      ipAddress: '1.2.3.4',
      deviceId: 'dev-1',
    });
    expect(result.message).toMatch(/set successfully/);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      userId: 'user-1',
      actionType: 'WALLET_PIN_CHANGE',
      referenceType: 'WALLET',
      referenceId: 'user-1',
      latitude: -6.2,
      longitude: 106.85,
      locationDenied: false,
      ipAddress: '1.2.3.4',
      deviceId: 'dev-1',
      suspicious: false,
    });
  });

  it('setPin sukses walau prisma.actionLocation.create reject', async () => {
    mockPrisma.actionLocation.create.mockRejectedValueOnce(new Error('DB down'));
    const result = await walletService.setPin('user-1', '482915', undefined, 'secretpw', '1.2.3.4', {
      location: { latitude: -6.2, longitude: 106.85 },
      ipAddress: '1.2.3.4',
    });
    expect(result.message).toMatch(/set successfully/);
    expect(created).toHaveLength(0);
  });

  it('setPin sukses dengan location null → row locationDenied=true', async () => {
    const result = await walletService.setPin('user-1', '482915', undefined, 'secretpw', '1.2.3.4', {
      location: null,
      ipAddress: '1.2.3.4',
    });
    expect(result.message).toMatch(/set successfully/);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      actionType: 'WALLET_PIN_CHANGE',
      locationDenied: true,
      suspicious: false,
    });
    expect(created[0].latitude).toBeUndefined();
  });
});
