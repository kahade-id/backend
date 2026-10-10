/**
 * courier-webhook.spec.ts — G235/G237/G250:
 * - signature invalid → ditolak (fail-closed)
 * - event sama 2x (idempotency key) → 1 efek
 * - event tak dikenal → UNKNOWN + tercatat
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { createHmac } from 'crypto';
import { Prisma, ShipmentStatus } from '@prisma/client';
import { CourierService } from '../courier.service';
import { CourierRegistry } from '../providers/courier-registry';
import { CourierConfigService } from '../courier.config';
import { MockCourierProvider } from '../providers/mock-courier.provider';
import { PrismaService } from '../../../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { LocalStorageService } from '../../upload/local-storage.service';
import { NotificationQueueService } from '../../queue/notification-queue.service';

const HMAC_SECRET = 'test-webhook-secret';

function sign(body: Buffer): string {
  return 'sha256=' + createHmac('sha256', HMAC_SECRET).update(body).digest('hex');
}

describe('CourierService — webhook (G235/G237/G250)', () => {
  let service: CourierService;
  let prisma: {
    shipment: { findFirst: jest.Mock; findUnique: jest.Mock; update: jest.Mock };
    shipmentEvent: { create: jest.Mock };
    courierWebhookLog: { create: jest.Mock; findFirst: jest.Mock };
  };
  let courierConfig: { getProviderConfig: jest.Mock; resolveSecret: jest.Mock };

  const shipment = {
    id: 'ship-1',
    orderId: 'ord-1',
    buyerId: 'buyer-1',
    sellerId: 'seller-1',
    providerCode: 'mock',
    trackingNumber: 'MOCK123',
    status: ShipmentStatus.IN_TRANSIT,
  };

  beforeEach(async () => {
    prisma = {
      shipment: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
      shipmentEvent: { create: jest.fn() },
      courierWebhookLog: { create: jest.fn(), findFirst: jest.fn() },
      // A05: resolusi orderId publik untuk notifikasi.
      order: { findUnique: jest.fn().mockResolvedValue({ orderId: 'ORD-20261010-001' }) },
    };
    courierConfig = {
      getProviderConfig: jest.fn().mockReturnValue({ code: 'mock', hmacSecretRef: 'MOCK_HMAC' }),
      resolveSecret: jest.fn().mockReturnValue(HMAC_SECRET),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CourierService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: CourierConfigService, useValue: courierConfig },
        { provide: CourierRegistry, useValue: { get: jest.fn(), has: jest.fn(), listCodes: jest.fn(() => ['mock']) } },
        { provide: LocalStorageService, useValue: { saveFile: jest.fn(), resolvePath: jest.fn() } },
        { provide: NotificationQueueService, useValue: { enqueue: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();
    service = module.get(CourierService);

    prisma.shipment.findFirst.mockResolvedValue(shipment);
    prisma.shipment.findUnique.mockResolvedValue(shipment);
    prisma.shipmentEvent.create.mockImplementation(async (args: { data: Record<string, unknown> }) => ({ id: 'evt-1', ...args.data }));
    prisma.courierWebhookLog.findFirst.mockResolvedValue(null);
    prisma.courierWebhookLog.create.mockResolvedValue({ id: 'log-1' });
  });

  function payload(overrides: Record<string, unknown> = {}) {
    return Buffer.from(JSON.stringify({
      trackingNumber: 'MOCK123',
      eventId: 'evt-provider-1',
      status: 'OUT_FOR_DELIVERY',
      location: 'Surabaya Timur Hub',
      description: 'Paket sedang diantar',
      occurredAt: new Date().toISOString(),
      ...overrides,
    }));
  }

  it('menolak webhook dengan signature invalid (fail-closed)', async () => {
    const body = payload();
    await expect(
      service.handleWebhook('mock', body, 'sha256=deadbeef', undefined),
    ).rejects.toBeInstanceOf(ForbiddenException);
    // Event tidak boleh diproses.
    expect(prisma.shipmentEvent.create).not.toHaveBeenCalled();
    expect(prisma.courierWebhookLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ signatureValid: false, outcome: 'REJECTED' }) }),
    );
  });

  it('menolak webhook bila secret belum dikonfigurasi (fail-closed)', async () => {
    courierConfig.resolveSecret.mockReturnValueOnce(undefined);
    const body = payload();
    await expect(service.handleWebhook('mock', body, sign(body), undefined)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.shipmentEvent.create).not.toHaveBeenCalled();
  });

  it('event sama 2x dengan idempotency key → hanya 1 efek (G237)', async () => {
    const body = payload();
    const sig = sign(body);

    const first = await service.handleWebhook('mock', body, sig, 'idem-key-1');
    expect(first.outcome).toBe('processed');
    expect(prisma.shipmentEvent.create).toHaveBeenCalledTimes(1);

    // Webhook kedua: log sudah mencatat PROCESSED untuk kunci ini.
    prisma.courierWebhookLog.findFirst.mockResolvedValueOnce({ id: 'log-1' });
    const second = await service.handleWebhook('mock', body, sig, 'idem-key-1');
    expect(second.outcome).toBe('duplicate');
    expect(prisma.shipmentEvent.create).toHaveBeenCalledTimes(1);
  });

  it('duplikat tanpa idempotency key terdeteksi via hash payload', async () => {
    const body = payload({ eventId: 'evt-x' });
    const sig = sign(body);
    await service.handleWebhook('mock', body, sig, undefined);
    expect(prisma.shipmentEvent.create).toHaveBeenCalledTimes(1);

    prisma.courierWebhookLog.findFirst.mockResolvedValueOnce({ id: 'log-1' });
    const second = await service.handleWebhook('mock', body, sig, undefined);
    expect(second.outcome).toBe('duplicate');
    expect(prisma.shipmentEvent.create).toHaveBeenCalledTimes(1);
  });

  it('event tak dikenal → UNKNOWN dan tercatat (G236)', async () => {
    const body = payload({ eventId: 'evt-weird', status: 'TELEPORTED_TO_MARS' });
    const result = await service.handleWebhook('mock', body, sign(body), 'idem-weird');
    expect(result.outcome).toBe('processed');
    expect(prisma.shipmentEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ rawStatus: 'TELEPORTED_TO_MARS', status: ShipmentStatus.UNKNOWN }),
      }),
    );
  });

  it('event duplikat (providerEventId sama) tidak menggandakan efek', async () => {
    // P2002 nyata = unique violation (shipmentId, providerEventId).
    const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: '5.22.0',
    });
    prisma.shipmentEvent.create.mockRejectedValueOnce(p2002);
    const applied = await service.applyProviderEvent('ship-1', 'mock', {
      providerEventId: 'evt-dup',
      rawStatus: 'DELIVERED',
    });
    expect(applied).toBe(false);
  });
});
