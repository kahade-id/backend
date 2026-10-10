/**
 * courier-admin.spec.ts — Wave 2 integritas-139: endpoint yang dipakai halaman
 * admin kurir aktif. Fokus: fail-closed (retry hanya FAILED, refund ≤ sisa
 * biaya, provider tak dikenal ditolak) + refund memakai state machine yang
 * ada tanpa menyentuh wallet.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BadRequestException } from '@nestjs/common';
import { ShipmentBookingState, ShipmentStatus, ShipmentMode, ShippingCostBearer, ShippingRefundStatus } from '@prisma/client';
import { CourierService } from '../courier.service';
import { CourierRegistry } from '../providers/courier-registry';
import { CourierConfigService } from '../courier.config';
import { PrismaService } from '../../../prisma/prisma.service';
import { LocalStorageService } from '../../upload/local-storage.service';
import { NotificationQueueService } from '../../queue/notification-queue.service';

const makeShipment = (over: Record<string, unknown> = {}) => ({
  id: 'ship-1',
  orderId: 'order-db-1',
  sellerId: 'seller-1',
  buyerId: 'buyer-1',
  providerCode: 'jne',
  serviceCode: 'REG',
  mode: ShipmentMode.PICKUP,
  bookingState: ShipmentBookingState.DRAFT,
  status: ShipmentStatus.CREATED,
  trackingNumber: 'JNE001',
  costBearer: ShippingCostBearer.SELLER,
  estimatedCost: 15000n,
  actualCost: 16000n,
  refundedAmount: 0n,
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
  updatedAt: new Date(),
  ...over,
});

describe('CourierService — admin Wave 2 (integritas-139)', () => {
  let service: CourierService;
  let prisma: Record<string, any>;
  let registry: { get: jest.Mock };

  beforeEach(async () => {
    registry = { get: jest.fn().mockReturnValue({ displayName: 'JNE' }) };
    prisma = {
      shipment: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      courierRegionFlag: {
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn().mockImplementation(async (a: any) => ({ ...a.create })),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      courierService: {
        groupBy: jest.fn().mockResolvedValue([{ providerCode: 'jne', _min: { sortOrder: 1 } }]),
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      shippingCostRefund: { create: jest.fn(), update: jest.fn() },
      // A05: resolusi orderId publik (cuid internal → ORD-…).
      order: {
        findUnique: jest.fn().mockResolvedValue({ orderId: 'ORD-20261010-001' }),
        findMany: jest.fn().mockResolvedValue([{ id: 'order-db-1', orderId: 'ORD-20261010-001' }]),
      },
      $transaction: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CourierService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        {
          provide: CourierConfigService,
          useValue: {
            getAllProviderConfigs: jest.fn().mockReturnValue([
              { code: 'jne', enabled: true, regions: ['*'], timeoutMs: 8000 },
              { code: 'jnt', enabled: false, regions: ['*'], timeoutMs: 8000 },
            ]),
            getProviderConfig: jest.fn(),
            resolveSecret: jest.fn(),
          },
        },
        { provide: CourierRegistry, useValue: registry },
        { provide: LocalStorageService, useValue: { saveFile: jest.fn(), resolvePath: jest.fn() } },
        { provide: NotificationQueueService, useValue: { enqueue: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();
    service = module.get(CourierService);
  });

  describe('listAdminShipments', () => {
    it('memetakan filter ke where prisma + shape pagination admin', async () => {
      prisma.shipment.count.mockResolvedValue(45);
      prisma.shipment.findMany.mockResolvedValue([makeShipment(), makeShipment({ id: 'ship-2' })]);
      const res = await service.listAdminShipments({ page: 2, limit: 20, bookingState: 'FAILED', search: 'JNE' });
      const where = prisma.shipment.findMany.mock.calls[0][0].where;
      expect(where.bookingState).toBe(ShipmentBookingState.FAILED);
      expect(where.AND).toHaveLength(1);
      expect(where.AND[0].OR).toHaveLength(2);
      expect(res.total).toBe(45);
      expect(res.page).toBe(2);
      expect(res.limit).toBe(20);
      expect(res.totalPages).toBe(3);
      expect(res.hasNext).toBe(true);
      expect(res.hasPrev).toBe(true);
      expect(res.data).toHaveLength(2);
    });

    it('bookingState tak dikenal → 400 (fail-closed)', async () => {
      await expect(service.listAdminShipments({ bookingState: 'NOPE' })).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.shipment.findMany).not.toHaveBeenCalled();
    });

    it('staleHours membatasi lastEventAt', async () => {
      await service.listAdminShipments({ staleHours: 48 });
      const where = prisma.shipment.findMany.mock.calls[0][0].where;
      expect(where.AND[0].OR[0].lastEventAt.lt).toBeInstanceOf(Date);
    });
  });

  describe('listAdminProviders / updateAdminProviderFlag', () => {
    it('menggabungkan config + flag wilayah + prioritas katalog', async () => {
      prisma.courierRegionFlag.findMany.mockResolvedValue([
        { providerCode: 'jne', region: '*', enabled: true },
        { providerCode: 'jne', region: 'ID-JKT', enabled: true },
        { providerCode: 'jne', region: 'ID-SBY', enabled: false },
      ]);
      const res = await service.listAdminProviders();
      const jne = res.find((p) => p.providerCode === 'jne')!;
      expect(jne.enabled).toBe(true);
      expect(jne.regionWhitelist).toEqual(['ID-JKT']);
      expect(jne.regionBlacklist).toEqual(['ID-SBY']);
      expect(jne.priority).toBe(1);
      expect(jne.name).toBe('JNE');
    });

    it('provider tak dikenal → 400, tanpa tulis DB', async () => {
      await expect(
        service.updateAdminProviderFlag('dhl', { enabled: true }, 'admin-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.courierRegionFlag.upsert).not.toHaveBeenCalled();
    });

    it('update flag menulis upsert + whitelist definitif + prioritas', async () => {
      prisma.courierRegionFlag.findMany.mockResolvedValue([]);
      const res: any = await service.updateAdminProviderFlag(
        'jne',
        { enabled: false, regionWhitelist: ['ID-JKT'], priority: 5 },
        'admin-1',
      );
      expect(prisma.courierRegionFlag.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { providerCode_region: { providerCode: 'jne', region: '*' } } }),
      );
      expect(prisma.courierRegionFlag.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ providerCode: 'jne' }) }),
      );
      expect(prisma.courierService.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { providerCode: 'jne' }, data: { sortOrder: 5 } }),
      );
      expect(res.providerCode).toBe('jne');
    });
  });

  describe('retryShipmentBookingAdmin', () => {
    it('bukan FAILED → 400 tanpa memanggil provider', async () => {
      prisma.shipment.findUnique.mockResolvedValue(makeShipment({ bookingState: ShipmentBookingState.BOOKED }));
      const spy = jest.spyOn(service, 'bookShipment');
      await expect(service.retryShipmentBookingAdmin('ship-1', 'admin-1')).rejects.toBeInstanceOf(BadRequestException);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('FAILED → reuse bookShipment dengan sellerId shipment', async () => {
      prisma.shipment.findUnique.mockResolvedValue(makeShipment({ bookingState: ShipmentBookingState.FAILED }));
      const spy = jest.spyOn(service, 'bookShipment').mockResolvedValue({ id: 'ship-1' } as never);
      await service.retryShipmentBookingAdmin('ship-1', 'admin-1');
      expect(spy).toHaveBeenCalledWith('seller-1', 'ship-1', {});
      spy.mockRestore();
    });
  });

  describe('getShippingReconciliation', () => {
    const setupRecon = (rows: Array<Record<string, string>>, total: number) => {
      prisma.$queryRaw = jest.fn().mockImplementation((sql: unknown) => {
        const text = String((sql as { sql?: string }).sql ?? sql);
        if (/COUNT\(\*\)/i.test(text)) return Promise.resolve([{ count: BigInt(total) }]);
        return Promise.resolve(rows);
      });
    };

    it('menghitung diff (RUPIAH) di SQL + filter onlyMismatch + pagination DB', async () => {
      const rows = [
        { shipmentId: 's1', orderId: 'ORD-20261010-001', providerCode: 'jne', estimatedCost: '15000', actualCost: '16000', diff: '1000' },
      ];
      setupRecon(rows, 1);
      const res: any = await service.getShippingReconciliation({ page: 1, limit: 20 });
      expect(res.total).toBe(1);
      // A06: nama field rupiah (bukan *Sen) — admin tidak lagi membagi 100.
      expect(res.data[0]).toMatchObject({ shipmentId: 's1', diff: '1000', estimatedCost: '15000' });
      expect(res.data[0]).not.toHaveProperty('diffSen');
      // A05: orderId publik di-join dari tabel orders.
      const pageSqlJoin = String((prisma.$queryRaw.mock.calls[1][0] as { sql: string }).sql);
      expect(pageSqlJoin).toMatch(/LEFT JOIN "orders"/);
      expect(res.totalPages).toBe(1);
      // COUNT + page query dijalankan paralel.
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
      const pageSql = String((prisma.$queryRaw.mock.calls[1][0] as { sql: string }).sql);
      expect(pageSql).toContain('LIMIT');
      expect(pageSql).toContain('OFFSET');

      // onlyMismatch=true → klausa filter diff di SQL.
      setupRecon(rows, 1);
      await service.getShippingReconciliation({ page: 1, limit: 20, onlyMismatch: true });
      const mismatchSql = String((prisma.$queryRaw.mock.calls[1][0] as { sql: string }).sql);
      expect(mismatchSql).toMatch(/<>\s*0/);
    });
  });

  describe('approveShippingRefund', () => {
    const setupTx = () => {
      const inner = {
        shippingCostRefund: {
          create: jest.fn().mockImplementation(async (a: any) => ({ id: 'ref-1', ...a.data })),
          update: jest.fn().mockImplementation(async (a: any) => ({ id: 'ref-1', status: ShippingRefundStatus.APPROVED, amount: 5000n, ...a.data })),
        },
      };
      prisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(inner));
      return inner;
    };

    it('nominal melebihi sisa biaya → 400, tanpa tulis refund', async () => {
      prisma.shipment.findUnique.mockResolvedValue(makeShipment({ actualCost: 16000n, refundedAmount: 12000n }));
      await expect(
        service.approveShippingRefund('ship-1', { amount: 5000, reason: 'kelebihan ongkir' }, 'admin-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('valid → REQUESTED lalu APPROVED dalam satu transaksi, wallet tidak disentuh', async () => {
      prisma.shipment.findUnique.mockResolvedValue(makeShipment({ actualCost: 16000n, refundedAmount: 2000n }));
      const inner = setupTx();
      const res: any = await service.approveShippingRefund('ship-1', { amount: 5000, reason: 'kelebihan ongkir' }, 'admin-1');
      expect(inner.shippingCostRefund.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: ShippingRefundStatus.REQUESTED, amount: 5000n }) }),
      );
      expect(inner.shippingCostRefund.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: ShippingRefundStatus.APPROVED, decidedBy: 'admin-1' }) }),
      );
      expect(res.amount).toBe('5000');
      // Tidak ada akses wallet sama sekali di method ini.
      expect((service as any).prisma.wallet).toBeUndefined();
    });

    it('shipment hilang → 404', async () => {
      prisma.shipment.findUnique.mockResolvedValue(null);
      await expect(
        service.approveShippingRefund('nope', { amount: 1000, reason: 'alasan cukup panjang' }, 'admin-1'),
      ).rejects.toMatchObject({ status: 404 });
    });
  });
});
