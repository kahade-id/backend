/**
 * courier-tracking.spec.ts — G239/G240/G241/G250:
 * - refresh tracking manual (pull)
 * - provider timeout → UNKNOWN (jangan mengarang status)
 * - fallback resi manual
 * - normalisasi status mentah
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ShipmentBookingState, ShipmentStatus } from '@prisma/client';
import { CourierService, normalizeRawStatus } from '../courier.service';
import { CourierRegistry } from '../providers/courier-registry';
import { CourierConfigService } from '../courier.config';
import { MockCourierProvider } from '../providers/mock-courier.provider';
import { PrismaService } from '../../../prisma/prisma.service';
import { LocalStorageService } from '../../upload/local-storage.service';
import { NotificationQueueService } from '../../queue/notification-queue.service';

describe('normalisasi event provider (G236)', () => {
  it.each([
    ['DELIVERED', ShipmentStatus.DELIVERED],
    ['delivered', ShipmentStatus.DELIVERED],
    ['PICKED_UP', ShipmentStatus.PICKED_UP],
    ['OUT_FOR_DELIVERY', ShipmentStatus.OUT_FOR_DELIVERY],
    ['IN_TRANSIT', ShipmentStatus.IN_TRANSIT],
    ['EXCEPTION', ShipmentStatus.EXCEPTION],
    ['RETURNED', ShipmentStatus.RETURNED],
    ['RTO', ShipmentStatus.RETURNED],
  ])('"%s" → %s', (raw, expected) => {
    const { status, known } = normalizeRawStatus(raw);
    expect(status).toBe(expected);
    expect(known).toBe(true);
  });

  it('status tak dikenal → UNKNOWN (known=false)', () => {
    const { status, known } = normalizeRawStatus('WARP_DRIVE_ENGAGED');
    expect(status).toBe(ShipmentStatus.UNKNOWN);
    expect(known).toBe(false);
  });
});

describe('CourierService — refresh tracking & fallback manual', () => {
  let service: CourierService;
  let prisma: {
    shipment: { findFirst: jest.Mock; findUnique: jest.Mock; update: jest.Mock };
    shipmentEvent: { create: jest.Mock };
    order: { update: jest.Mock };
    courierWebhookLog: { create: jest.Mock; findFirst: jest.Mock };
  };
  let mockProvider: MockCourierProvider;

  const shipment = {
    id: 'ship-1',
    orderId: 'ord-internal-1',
    buyerId: 'buyer-1',
    sellerId: 'seller-1',
    providerCode: 'mock',
    serviceCode: 'STD',
    mode: 'PICKUP',
    trackingNumber: 'MOCK0000000001',
    status: ShipmentStatus.IN_TRANSIT,
    // Draf shipment: G241 fallback resi manual hanya valid bila BELUM ada
    // booking provider aktif. Uji penolakan memakai mockResolvedValueOnce
    // dengan BOOKED secara eksplisit.
    bookingState: ShipmentBookingState.DRAFT,
    costBearer: 'SELLER',
    estimatedCost: BigInt(15000),
    actualCost: BigInt(15500),
    currency: 'IDR',
    etaMinDays: 1,
    etaMaxDays: 3,
    slaDueAt: null,
    isManual: false,
    manualCourierName: null,
    originCity: 'Jakarta',
    originPostalCode: '10110',
    destCity: 'Bandung',
    destPostalCode: '40111',
    lastEventAt: null,
    createdAt: new Date(),
  };

  beforeEach(async () => {
    mockProvider = new MockCourierProvider('mock');
    mockProvider.artificialLatencyMs = 0;
    prisma = {
      shipment: {
        findFirst: jest.fn(),
        findUnique: jest.fn().mockResolvedValue(shipment),
        update: jest.fn().mockImplementation(async (args: { data: unknown }) => ({ ...shipment, ...(args.data as object) })),
      },
      shipmentEvent: { create: jest.fn().mockResolvedValue({ id: 'evt-1' }) },
      order: { update: jest.fn().mockResolvedValue({}) },
      courierWebhookLog: { create: jest.fn(), findFirst: jest.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CourierService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: CourierConfigService, useValue: { getProviderConfig: jest.fn(), resolveSecret: jest.fn() } },
        { provide: CourierRegistry, useValue: { get: jest.fn().mockReturnValue(mockProvider), has: jest.fn().mockReturnValue(true), listCodes: jest.fn(() => ['mock']) } },
        { provide: LocalStorageService, useValue: { saveFile: jest.fn(), resolvePath: jest.fn() } },
        { provide: NotificationQueueService, useValue: { enqueue: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();
    service = module.get(CourierService);
  });

  it('refresh manual menerapkan event provider (G239)', async () => {
    const result = await service.refreshTracking('seller-1', 'ship-1');
    expect(result.timeout).toBe(false);
    expect(result.events).toBeGreaterThan(0);
    expect(prisma.shipmentEvent.create).toHaveBeenCalled();
  });

  it('provider timeout → status UNKNOWN, bukan status karangan (G240)', async () => {
    mockProvider.simulateTimeout = true;
    const result = await service.refreshTracking('seller-1', 'ship-1');
    expect(result.timeout).toBe(true);
    expect(result.status).toBe(ShipmentStatus.UNKNOWN);
    expect(prisma.shipment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: ShipmentStatus.UNKNOWN }) }),
    );
    // Event timeout tercatat sebagai UNKNOWN.
    expect(prisma.shipmentEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ rawStatus: 'PROVIDER_TIMEOUT', status: ShipmentStatus.UNKNOWN }),
      }),
    );
  });

  it('timeout tidak menimpa status terminal DELIVERED', async () => {
    prisma.shipment.findUnique.mockResolvedValueOnce({ ...shipment, status: ShipmentStatus.DELIVERED });
    mockProvider.simulateTimeout = true;
    const result = await service.refreshTracking('seller-1', 'ship-1');
    expect(result.timeout).toBe(true);
    // Update dipanggil dengan data kosong (tidak downgrade).
    expect(prisma.shipment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: {} }),
    );
  });

  it('fallback resi manual menyimpan resi + mirror ke order (G241)', async () => {
    const updated = await service.setManualResi('seller-1', 'ship-1', {
      trackingNumber: 'MANUAL123',
      courierName: 'Kurir Lokal',
    });
    expect(updated.isManual).toBe(true);
    expect(updated.trackingNumber).toBe('MANUAL123');
    expect(prisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ trackingNumber: 'MANUAL123', courierName: 'Kurir Lokal' }),
      }),
    );
  });

  it('resi manual ditolak bila booking provider aktif', async () => {
    prisma.shipment.findUnique.mockResolvedValueOnce({ ...shipment, bookingState: ShipmentBookingState.BOOKED });
    await expect(
      service.setManualResi('seller-1', 'ship-1', { trackingNumber: 'X', courierName: 'Y' }),
    ).rejects.toThrow('Booking provider aktif');
  });
});

describe('MockCourierProvider — sandbox deterministik (G250)', () => {
  const provider = new MockCourierProvider('jne');

  it('quote deterministik & menolak kode pos invalid', async () => {
    const q1 = await provider.getQuote({ originPostalCode: '10110', destinationPostalCode: '40111', weightGrams: 1500 });
    const q2 = await provider.getQuote({ originPostalCode: '10110', destinationPostalCode: '40111', weightGrams: 1500 });
    expect(q1).toEqual(q2);
    expect(q1.length).toBe(2);
    expect(q1[0].cost).toBeGreaterThan(0);
    await expect(
      provider.getQuote({ originPostalCode: 'ABC', destinationPostalCode: '40111', weightGrams: 1000 }),
    ).rejects.toThrow('Kode pos');
  });

  it('validasi alamat menolak kode pos bukan 5 digit (G229)', async () => {
    const result = await provider.validateAddress({
      name: 'Budi', phone: '+6281234567890', address: 'Jl. Merdeka No. 10, Kecamatan Senen',
      city: 'Jakarta', postalCode: '1234',
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/kode pos/i);
  });

  it('bookPickup menghasilkan bookingId, resi, dan label PDF', async () => {
    const addr = { name: 'Budi', phone: '+6281234567890', address: 'Jl. Merdeka No. 10, Kecamatan Senen', city: 'Jakarta', postalCode: '10110' };
    const result = await provider.bookPickup({
      orderId: 'ord-1', serviceCode: 'STD', mode: 'PICKUP', origin: addr, destination: { ...addr, city: 'Bandung', postalCode: '40111' }, weightGrams: 1000,
    });
    expect(result.providerBookingId).toMatch(/^MOCK-JNE-/);
    expect(result.trackingNumber).toMatch(/^JNE/);
    expect(result.label.subarray(0, 5).toString()).toBe('%PDF-');
    expect(result.actualCost).toBeGreaterThan(0);
  });

  it('masking lokasi tidak membocorkan detail (G238)', async () => {
    const { maskLocation } = await import('../providers/mock-courier.provider');
    expect(maskLocation('Jakarta Selatan Hub')).toBe('Jakarta S*** H***');
    expect(maskLocation(undefined)).toBeUndefined();
  });
});
