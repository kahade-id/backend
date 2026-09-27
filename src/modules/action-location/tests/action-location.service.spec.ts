import { Test, TestingModule } from '@nestjs/testing';
import { ActionLocationService } from '../action-location.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { ActionLocationType } from '@prisma/client';

// Unit test ActionLocationService — lapisan persistensi "lokasi presisi
// tiap aksi sensitif". Service ini best-effort: tidak pernah throw.

describe('ActionLocationService', () => {
  let service: ActionLocationService;
  const created: any[] = [];

  const mockPrisma: any = {
    actionLocation: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `al-${created.length}`, ...data, createdAt: new Date() };
        created.push(row);
        return row;
      }),
    },
  };

  beforeEach(async () => {
    created.length = 0;
    jest.clearAllMocks();
    mockPrisma.actionLocation.findFirst.mockResolvedValue(null);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ActionLocationService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get<ActionLocationService>(ActionLocationService);
  });

  const baseLocation = { latitude: -6.2, longitude: 106.85, accuracy: 12.5, source: 'gps' };

  it.each(Object.values(ActionLocationType))(
    'mencatat lokasi untuk actionType %s',
    async (actionType) => {
      await service.logAction({
        userId: 'user-1',
        actionType,
        referenceType: 'ORDER',
        referenceId: 'ref-1',
        location: baseLocation,
        ipAddress: '1.2.3.4',
        deviceId: 'dev-1',
      });
      expect(mockPrisma.actionLocation.create).toHaveBeenCalledTimes(1);
      const data = mockPrisma.actionLocation.create.mock.calls[0][0].data;
      expect(data.actionType).toBe(actionType);
      expect(data.latitude).toBe(-6.2);
      expect(data.longitude).toBe(106.85);
      expect(data.accuracy).toBe(12.5);
      expect(data.source).toBe('gps');
      expect(data.locationDenied).toBe(false);
      expect(data.suspicious).toBe(false);
      expect(data.ipAddress).toBe('1.2.3.4');
      expect(data.deviceId).toBe('dev-1');
    },
  );

  it('location null → row locationDenied=true, koordinat NULL, dan promise tetap resolve', async () => {
    await expect(
      service.logAction({
        userId: 'user-1',
        actionType: 'ORDER_PAY',
        referenceType: 'ORDER',
        referenceId: 'ord-1',
        location: null,
        ipAddress: '1.2.3.4',
      }),
    ).resolves.toBeUndefined();

    expect(mockPrisma.actionLocation.create).toHaveBeenCalledTimes(1);
    const data = mockPrisma.actionLocation.create.mock.calls[0][0].data;
    expect(data.locationDenied).toBe(true);
    expect(data.latitude).toBeUndefined();
    expect(data.longitude).toBeUndefined();
    expect(data.accuracy).toBeUndefined();
    expect(data.suspicious).toBe(false);
  });

  it('location absent (undefined) → diperlakukan sebagai denied', async () => {
    await service.logAction({ userId: 'user-1', actionType: 'WALLET_TRANSFER' });
    const data = mockPrisma.actionLocation.create.mock.calls[0][0].data;
    expect(data.locationDenied).toBe(true);
  });

  it('koordinat non-number → diperlakukan sebagai denied', async () => {
    await service.logAction({
      userId: 'user-1',
      actionType: 'DISPUTE_OPEN',
      location: { latitude: 'x', longitude: 106.8 } as any,
    });
    const data = mockPrisma.actionLocation.create.mock.calls[0][0].data;
    expect(data.locationDenied).toBe(true);
  });

  it('kegagalan tulis log tidak menggagalkan aksi (prisma reject → tetap resolve)', async () => {
    mockPrisma.actionLocation.create.mockRejectedValueOnce(new Error('DB down'));
    await expect(
      service.logAction({
        userId: 'user-1',
        actionType: 'WALLET_WITHDRAW',
        location: baseLocation,
      }),
    ).resolves.toBeUndefined();
  });

  it('kegagalan baca log terakhir tidak menggagalkan tulis', async () => {
    mockPrisma.actionLocation.findFirst.mockRejectedValueOnce(new Error('DB down'));
    await expect(
      service.logAction({ userId: 'user-1', actionType: 'ORDER_CREATE', location: baseLocation }),
    ).resolves.toBeUndefined();
  });

  it('impossible-travel: >500 km dalam <2 jam → suspicious=true', async () => {
    // Log terakhir: Jakarta, 1 jam lalu.
    mockPrisma.actionLocation.findFirst.mockResolvedValue({
      latitude: -6.2,
      longitude: 106.85,
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    // Lokasi baru: Tokyo (~5800 km).
    await service.logAction({
      userId: 'user-1',
      actionType: 'ORDER_PAY',
      location: { latitude: 35.68, longitude: 139.69 },
    });
    const data = mockPrisma.actionLocation.create.mock.calls[0][0].data;
    expect(data.suspicious).toBe(true);
  });

  it('jarak dekat → suspicious=false', async () => {
    mockPrisma.actionLocation.findFirst.mockResolvedValue({
      latitude: -6.2,
      longitude: 106.85,
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    // Bandung (~120 km) — di bawah ambang.
    await service.logAction({
      userId: 'user-1',
      actionType: 'ORDER_PAY',
      location: { latitude: -6.91, longitude: 107.6 },
    });
    const data = mockPrisma.actionLocation.create.mock.calls[0][0].data;
    expect(data.suspicious).toBe(false);
  });

  it('jarak jauh tapi >2 jam → suspicious=false', async () => {
    mockPrisma.actionLocation.findFirst.mockResolvedValue({
      latitude: -6.2,
      longitude: 106.85,
      createdAt: new Date(Date.now() - 5 * 60 * 60 * 1000),
    });
    await service.logAction({
      userId: 'user-1',
      actionType: 'ORDER_PAY',
      location: { latitude: 35.68, longitude: 139.69 },
    });
    const data = mockPrisma.actionLocation.create.mock.calls[0][0].data;
    expect(data.suspicious).toBe(false);
  });

  it('tanpa userId → no-op, tidak throw', async () => {
    await expect(
      service.logAction({ userId: '', actionType: 'ORDER_CREATE', location: baseLocation }),
    ).resolves.toBeUndefined();
    expect(mockPrisma.actionLocation.create).not.toHaveBeenCalled();
  });
});
