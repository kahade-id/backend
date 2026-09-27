/**
 * SH-B-011 — asal etalase pada OrderLink → Order.
 *
 * - createLink menerima `showcaseId` opsional; kepemilikan item diverifikasi
 *   server-side; priceSnapshot dibaca dari data item (rupiah integer), BUKAN
 *   dari input client.
 * - showcaseId milik user lain / item terhapus → 400 SHOWCASE_NOT_FOUND.
 * - acceptLink menyalin showcaseId + priceSnapshot dari link ke Order.
 * - getLinkByToken mengekspos showcaseId + priceSnapshot (rupiah).
 */
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { OrderLinksService } from '../order-links.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { FeeCalculatorService } from '../fee-calculator.service';
import { NotificationQueueService } from '../../queue/notification-queue.service';
import * as ErrorCodes from '../../../common/constants/error-codes';

const CREATOR_ID = 'creator-1';
const OTHER_ID = 'other-1';
const ITEM_ID = 'cshowcase000000000000001';

function buildMocks() {
  return {
    mockPrisma: {
      user: { findUnique: jest.fn() },
      userShowcase: { findFirst: jest.fn() },
      orderLink: { create: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn() },
      blockList: { findFirst: jest.fn() },
      $transaction: jest.fn(),
    } as any,
    mockRedis: { getClient: jest.fn(), getPrefix: jest.fn().mockReturnValue('test:') } as any,
    mockFees: {} as any,
    mockNotif: { enqueue: jest.fn().mockResolvedValue(undefined) } as any,
  };
}

async function buildService(mocks: ReturnType<typeof buildMocks>) {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      OrderLinksService,
      { provide: PrismaService, useValue: mocks.mockPrisma },
      { provide: RedisService, useValue: mocks.mockRedis },
      { provide: FeeCalculatorService, useValue: mocks.mockFees },
      { provide: NotificationQueueService, useValue: mocks.mockNotif },
    ],
  }).compile();
  return module.get<OrderLinksService>(OrderLinksService);
}

function validDto(overrides: Record<string, unknown> = {}) {
  return {
    role: 'SELLER',
    title: 'Komisi ilustrasi',
    description: 'Komisi ilustrasi full body dengan dua kali revisi, pengerjaan 7 hari.',
    orderType: 'DIGITAL_GOODS',
    orderValue: 250000,
    feeResponsibility: 'BUYER',
    deliveryDeadlineDays: 7,
    ...overrides,
  } as any;
}

function mockHealthyCreator(mocks: ReturnType<typeof buildMocks>) {
  mocks.mockPrisma.user.findUnique.mockResolvedValue({ id: CREATOR_ID, username: 'seller', isActive: true, isBanned: false });
  mocks.mockPrisma.blockList.findFirst.mockResolvedValue(null);
}

describe('SH-B-011 — showcase origin on OrderLink/Order', () => {
  let mocks: ReturnType<typeof buildMocks>;

  beforeEach(() => {
    mocks = buildMocks();
    jest.clearAllMocks();
    mockHealthyCreator(mocks);
    mocks.mockRedis.getClient.mockReturnValue({ eval: jest.fn().mockResolvedValue(1) });
  });

  it('createLink records priceSnapshot from the SERVER item data (rupiah integer), ignoring any client price', async () => {
    mocks.mockPrisma.userShowcase.findFirst.mockResolvedValue({
      id: ITEM_ID,
      priceMin: 150000n,
      priceMax: 350000n,
    });
    mocks.mockPrisma.orderLink.create.mockImplementation(async (args: any) => ({ id: 'ol-1', linkId: 'KD-1', token: 'tok', expiresAt: new Date(), ...args.data }));

    const service = await buildService(mocks);
    // SEC-101: orderValue harus SAMA PERSIS dengan harga etalase (toleransi 0).
    const result = (await service.createLink(CREATOR_ID, validDto({ showcaseId: ITEM_ID, orderValue: 150000 }))) as any;

    // Kepemilikan diverifikasi: item milik creator, belum dihapus.
    expect(mocks.mockPrisma.userShowcase.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ITEM_ID, userId: CREATOR_ID, deletedAt: null } }),
    );
    // Snapshot = priceMin item dalam rupiah integer (bukan cents).
    expect(mocks.mockPrisma.orderLink.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ showcaseId: ITEM_ID, priceSnapshot: 150000n }) }),
    );
    expect(result.showcaseId).toBe(ITEM_ID);
    expect(result.priceSnapshot).toBe('150000');
  });

  it('createLink falls back to priceMax when priceMin is null, and rejects priceless showcases (fail-closed)', async () => {
    const service = await buildService(mocks);
    mocks.mockPrisma.userShowcase.findFirst.mockResolvedValue({ id: ITEM_ID, priceMin: null, priceMax: 99999n });
    mocks.mockPrisma.orderLink.create.mockImplementation(async (args: any) => ({ id: 'ol-1', linkId: 'KD-1', token: 'tok', expiresAt: new Date(), ...args.data }));
    // SEC-101: sama persis dengan snapshot (priceMax bila priceMin null).
    await service.createLink(CREATOR_ID, validDto({ showcaseId: ITEM_ID, orderValue: 99999 }));
    expect(mocks.mockPrisma.orderLink.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ priceSnapshot: 99999n }) }),
    );

    jest.clearAllMocks();
    mockHealthyCreator(mocks);
    // Etalase tanpa harga (snapshot 0) → orderValue valid apa pun mismatch → tolak tertutup.
    mocks.mockPrisma.userShowcase.findFirst.mockResolvedValue({ id: ITEM_ID, priceMin: null, priceMax: null });
    mocks.mockPrisma.orderLink.create.mockImplementation(async (args: any) => ({ id: 'ol-1', linkId: 'KD-1', token: 'tok', expiresAt: new Date(), ...args.data }));
    await expect(
      service.createLink(CREATOR_ID, validDto({ showcaseId: ITEM_ID, orderValue: 250000 })),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: ErrorCodes.VALIDATION_ERROR }),
    });
    expect(mocks.mockPrisma.orderLink.create).not.toHaveBeenCalled();
  });

  it('SEC-101: createLink menolak orderValue yang berbeda dari harga etalase (manipulasi harga)', async () => {
    mocks.mockPrisma.userShowcase.findFirst.mockResolvedValue({
      id: ITEM_ID,
      priceMin: 150000n,
      priceMax: 350000n,
    });
    const service = await buildService(mocks);
    // Lebih murah dari harga etalase.
    await expect(
      service.createLink(CREATOR_ID, validDto({ showcaseId: ITEM_ID, orderValue: 149999 })),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: ErrorCodes.VALIDATION_ERROR }),
    });
    // Lebih mahal dari harga etalase.
    await expect(
      service.createLink(CREATOR_ID, validDto({ showcaseId: ITEM_ID, orderValue: 150001 })),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: ErrorCodes.VALIDATION_ERROR }),
    });
    expect(mocks.mockPrisma.orderLink.create).not.toHaveBeenCalled();
  });

  it('createLink rejects a showcaseId that belongs to another user or is deleted', async () => {
    mocks.mockPrisma.userShowcase.findFirst.mockResolvedValue(null);
    const service = await buildService(mocks);
    await expect(service.createLink(CREATOR_ID, validDto({ showcaseId: ITEM_ID }))).rejects.toMatchObject({
      response: expect.objectContaining({ code: ErrorCodes.SHOWCASE_NOT_FOUND }),
    });
    expect(mocks.mockPrisma.orderLink.create).not.toHaveBeenCalled();
  });

  it('createLink without showcaseId stores no origin (backward compatible)', async () => {
    mocks.mockPrisma.orderLink.create.mockImplementation(async (args: any) => ({ id: 'ol-1', linkId: 'KD-1', token: 'tok', expiresAt: new Date(), ...args.data }));
    const service = await buildService(mocks);
    const result = (await service.createLink(CREATOR_ID, validDto())) as any;
    expect(mocks.mockPrisma.userShowcase.findFirst).not.toHaveBeenCalled();
    const data = mocks.mockPrisma.orderLink.create.mock.calls[0][0].data;
    expect(data.showcaseId).toBeUndefined();
    expect(result.showcaseId).toBeUndefined();
  });

  it('getLinkByToken exposes showcaseId + priceSnapshot as rupiah number', async () => {
    mocks.mockPrisma.orderLink.findUnique.mockResolvedValue({
      id: 'ol-1',
      linkId: 'KD-1',
      token: 'tok',
      status: 'ACTIVE',
      expiresAt: new Date(Date.now() + 3600_000),
      creator: { userId: 'USR-1', username: 'seller', fullName: 'Seller', avatarUrl: null, membershipRank: 'BASIC', averageRating: 0, totalRatingCount: 0, kycStatus: 'APPROVED' },
      creatorRole: 'SELLER',
      title: 'Komisi',
      description: 'desc',
      orderType: 'DIGITAL_GOODS',
      orderValue: 25000000n,
      feeResponsibility: 'BUYER',
      deliveryDeadlineDays: 7,
      counterpartUsername: null,
      showcaseId: ITEM_ID,
      priceSnapshot: 150000n,
    });
    const service = await buildService(mocks);
    const result = (await service.getLinkByToken('tok')) as any;
    expect(result.showcaseId).toBe(ITEM_ID);
    expect(result.priceSnapshot).toBe(150000);
  });

  it('acceptLink copies showcaseId + priceSnapshot from the link onto the order', async () => {
    const link = {
      id: 'ol-1',
      linkId: 'KD-1',
      token: 'tok',
      status: 'ACTIVE',
      creatorId: CREATOR_ID,
      creatorRole: 'SELLER',
      title: 'Komisi',
      description: 'desc',
      orderType: 'DIGITAL_GOODS',
      orderValue: 25000000n,
      feeResponsibility: 'BUYER',
      deliveryDeadlineDays: 7,
      deliveryDeadlineAt: null,
      counterpartUsername: null,
      showcaseId: ITEM_ID,
      priceSnapshot: 150000n,
    };
    mocks.mockPrisma.orderLink.findUnique.mockResolvedValue(link);
    // acceptLink memanggil this.prisma.user.findUnique 3x (buyer/seller/acceptor).
    mocks.mockPrisma.user.findUnique.mockImplementation(async (args: any) => {
      const id = args?.where?.id;
      if (id === OTHER_ID) return { id, isActive: true, isBanned: false, membershipRank: 'BASIC' };
      return { id, kycStatus: 'APPROVED', isKahadePlus: false, isActive: true, isBanned: false };
    });
    let orderCreateData: any = null;
    mocks.mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      const tx = {
        ...mocks.mockPrisma,
        user: { findUnique: jest.fn().mockResolvedValue({ id: 'x', username: 'u', isActive: true, isBanned: false, kycStatus: 'APPROVED' }) },
        blockList: { findFirst: jest.fn().mockResolvedValue(null) },
        orderLink: {
          findUnique: jest.fn().mockResolvedValue(link),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        order: {
          create: jest.fn().mockImplementation(async (args: any) => {
            orderCreateData = args.data;
            return { id: 'order-1', orderId: 'KD-2026-1', status: 'WAITING_CONFIRMATION', buyerId: 'b', sellerId: 's' };
          }),
        },
        chatRoom: { create: jest.fn().mockResolvedValue({ id: 'room-1' }) },
        orderStatusHistory: { create: jest.fn().mockResolvedValue({}) },
      };
      return fn(tx);
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrderLinksService,
        { provide: PrismaService, useValue: mocks.mockPrisma },
        { provide: RedisService, useValue: mocks.mockRedis },
        {
          provide: FeeCalculatorService,
          useValue: {
            getFeeConfig: jest.fn().mockResolvedValue({}),
            calculateFee: jest.fn().mockReturnValue({
              feeAmount: 0n, buyerFeeAmount: 0n, sellerFeeAmount: 0n,
              buyerPayAmount: 25000000n, sellerReceiveAmount: 25000000n,
              voucherDiscount: 0n, membershipRankDiscount: 0n, feeRate: 0,
            }),
          },
        },
        { provide: NotificationQueueService, useValue: mocks.mockNotif },
      ],
    }).compile();
    const service = module.get<OrderLinksService>(OrderLinksService);
    await service.acceptLink('tok', OTHER_ID);
    expect(orderCreateData).toMatchObject({ showcaseId: ITEM_ID, priceSnapshot: 150000n });
  });
});
