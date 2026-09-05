import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { DeliveryProofService } from '../delivery-proof.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { UploadService } from '../../upload/upload.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { OrderStateService } from '../order-state.service';
import { NotificationQueueService } from '../../queue/notification-queue.service';
import { WalletTxSerialService } from '../../../common/services/wallet-tx-serial.service';

/*
 * C-08 regression: `getProofs` signed every file key inside a bare `Promise.all`.
 * `generateDownloadUrl` throws when R2 is unconfigured and `getSignedUrl` can reject
 * transiently, so a single unreadable key rejected the whole batch and turned the
 * buyer's proof list into a 500 — hiding the description and link evidence that signed
 * fine, on the screen the buyer uses to decide whether to confirm or reject delivery.
 */

const mockPrisma = {
  order: { findFirst: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn() },
  deliveryProof: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), count: jest.fn(), updateMany: jest.fn(), create: jest.fn() },
  dispute: { findUnique: jest.fn(), create: jest.fn() },
  orderStatusHistory: { create: jest.fn() },
  user: { update: jest.fn() },
  $queryRaw: jest.fn().mockResolvedValue([]),
  $transaction: jest.fn(),
};
const mockUpload = { generateDownloadUrl: jest.fn() };
const mockAuditLog = { logUserAction: jest.fn() };
const mockOrderState = { handleCompleteOrder: jest.fn(), completeOrder: jest.fn() };
const mockQueue = { enqueue: jest.fn() };
const mockSerial = { getNextForPrefix: jest.fn().mockResolvedValue(1) };
const mockConfig = { get: jest.fn() };

const ORDER = { id: 'ord-1', orderId: 'ORD-1', buyerId: 'buyer', sellerId: 'seller', status: 'IN_DELIVERY', title: 'Jasa' };

describe('DeliveryProofService', () => {
  let service: DeliveryProofService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.$queryRaw.mockResolvedValue([]);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeliveryProofService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ConfigService, useValue: mockConfig },
        { provide: UploadService, useValue: mockUpload },
        { provide: AuditLogService, useValue: mockAuditLog },
        { provide: OrderStateService, useValue: mockOrderState },
        { provide: NotificationQueueService, useValue: mockQueue },
        { provide: WalletTxSerialService, useValue: mockSerial },
      ],
    }).compile();
    service = module.get<DeliveryProofService>(DeliveryProofService);
  });

  describe('getProofs — signature failure isolation (C-08)', () => {
    beforeEach(() => {
      mockPrisma.order.findFirst.mockResolvedValue(ORDER);
      mockPrisma.deliveryProof.findMany.mockResolvedValue([
        {
          id: 'dp-1',
          description: 'Sudah dikirim',
          fileUrls: ['uploads/delivery-proof/seller/a.jpg', 'uploads/delivery-proof/seller/b.jpg'],
          linkUrls: ['https://tracking.example/1'],
          status: 'SUBMITTED',
          reviewWindowEnd: new Date(),
          rejectionNote: null,
          createdAt: new Date(),
        },
      ]);
    });

    it('returns the proof with the keys that signed when one key fails', async () => {
      mockUpload.generateDownloadUrl.mockImplementation((key: string) =>
        key.endsWith('b.jpg') ? Promise.reject(new Error('R2 private bucket name is not configured')) : Promise.resolve(`https://signed/${key}`),
      );

      const res = (await service.getProofs('ORD-1', 'buyer')) as { fileUrls: string[]; description: string; linkUrls: string[] }[];

      expect(res).toHaveLength(1);
      expect(res[0].fileUrls).toEqual(['https://signed/uploads/delivery-proof/seller/a.jpg']);
      // The evidence that does not depend on R2 must survive a signing outage.
      expect(res[0].description).toBe('Sudah dikirim');
      expect(res[0].linkUrls).toEqual(['https://tracking.example/1']);
    });

    it('returns an empty fileUrls list rather than throwing when every key fails', async () => {
      mockUpload.generateDownloadUrl.mockRejectedValue(new Error('R2 not configured'));

      const res = (await service.getProofs('ORD-1', 'buyer')) as { fileUrls: string[]; description: string }[];

      expect(res[0].fileUrls).toEqual([]);
      expect(res[0].description).toBe('Sudah dikirim');
    });

    it('never emits a null into fileUrls', async () => {
      mockUpload.generateDownloadUrl.mockImplementation((key: string) =>
        key.endsWith('a.jpg') ? Promise.reject(new Error('boom')) : Promise.resolve(`https://signed/${key}`),
      );

      const res = (await service.getProofs('ORD-1', 'buyer')) as { fileUrls: (string | null)[] }[];

      expect(res[0].fileUrls).not.toContain(null);
      expect(res[0].fileUrls).toEqual(['https://signed/uploads/delivery-proof/seller/b.jpg']);
    });

    it('signs every key normally when R2 is healthy', async () => {
      mockUpload.generateDownloadUrl.mockImplementation((key: string) => Promise.resolve(`https://signed/${key}`));

      const res = (await service.getProofs('ORD-1', 'buyer')) as { fileUrls: string[] }[];

      expect(res[0].fileUrls).toEqual([
        'https://signed/uploads/delivery-proof/seller/a.jpg',
        'https://signed/uploads/delivery-proof/seller/b.jpg',
      ]);
    });

    it('leaves non-upload keys untouched without calling the signer', async () => {
      mockPrisma.deliveryProof.findMany.mockResolvedValue([
        {
          id: 'dp-2',
          description: 'Link saja',
          fileUrls: ['https://external.example/file.jpg'],
          linkUrls: [],
          status: 'SUBMITTED',
          reviewWindowEnd: new Date(),
          rejectionNote: null,
          createdAt: new Date(),
        },
      ]);

      const res = (await service.getProofs('ORD-1', 'buyer')) as { fileUrls: string[] }[];

      expect(res[0].fileUrls).toEqual(['https://external.example/file.jpg']);
      expect(mockUpload.generateDownloadUrl).not.toHaveBeenCalled();
    });
  });

  /*
   * C-24: all three transactions in this file are Serializable and none had a retry wrapper, so a
   * 40001 surfaced as an opaque 500. `confirmDelivery` and `rejectDelivery` race the auto-complete
   * cron, which touches the same order rows once the review window lapses.
   *
   * The serial test is the one that matters most: `getNextForPrefix` is a Redis INCR, so it does
   * NOT roll back with the PG transaction. Drawing it inside the retried body would burn one
   * `dispute_serial` per attempt.
   */
  describe('C-24 — Serializable retry wrapper', () => {
    const serializationFailure = () =>
      new Prisma.PrismaClientUnknownRequestError(
        'could not serialize access due to read/write dependencies among transactions (SQLSTATE 40001)',
        { clientVersion: 'test' },
      );

    beforeEach(() => {
      mockPrisma.$transaction.mockReset();
      mockSerial.getNextForPrefix.mockReset().mockResolvedValue(1);
      // The escalation branch writes through these; `clearAllMocks` strips their return values, so
      // re-arm them or the body throws a TypeError instead of exercising the retry.
      mockPrisma.deliveryProof.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.order.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.orderStatusHistory.create.mockResolvedValue({});
      mockPrisma.user.update.mockResolvedValue({});
      mockPrisma.dispute.create.mockResolvedValue({ id: 'dsp-1' });
      const logger = (service as unknown as { logger?: Logger }).logger;
      if (logger) {
        jest.spyOn(logger, 'error').mockImplementation(() => undefined);
        jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
      }
    });

    describe('confirmDelivery — atomic proof review and escrow completion', () => {
      beforeEach(() => {
        mockPrisma.order.findFirst.mockResolvedValue(ORDER);
        mockPrisma.order.findUnique.mockResolvedValue(ORDER);
        mockPrisma.deliveryProof.findFirst.mockResolvedValue({ id: 'dp-1', status: 'SUBMITTED', orderId: 'ord-1' });
        mockOrderState.completeOrder.mockResolvedValue(undefined);
      });

      it('delegates proof acceptance and escrow release atomically with the proof ID', async () => {
        await expect(service.confirmDelivery('ORD-1', 'buyer')).resolves.toBeTruthy();
        expect(mockOrderState.completeOrder).toHaveBeenCalledWith('ORD-1', 'buyer', 'dp-1');
        expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      });

      it('targets the requested proofId when multiple proofs exist', async () => {
        await expect(service.confirmDelivery('ORD-1', 'buyer', 'dp-specific')).resolves.toBeTruthy();
        expect(mockPrisma.deliveryProof.findFirst).toHaveBeenCalledWith({ where: { id: 'dp-specific', orderId: 'ord-1', status: 'SUBMITTED' } });
        expect(mockOrderState.completeOrder).toHaveBeenCalledWith('ORD-1', 'buyer', 'dp-1');
      });

      it('does not emit completion success when atomic settlement fails', async () => {
        mockOrderState.completeOrder.mockRejectedValue(serializationFailure());

        await expect(service.confirmDelivery('ORD-1', 'buyer')).rejects.toBeInstanceOf(Prisma.PrismaClientUnknownRequestError);
        expect(mockQueue.enqueue).not.toHaveBeenCalled();
      });

      it('does not retry a domain rejection in the proof service', async () => {
        mockOrderState.completeOrder.mockRejectedValue(
          new BadRequestException({ code: 'DELIVERY_PROOF_NOT_FOUND', message: 'already reviewed' }),
        );

        await expect(service.confirmDelivery('ORD-1', 'buyer')).rejects.toBeInstanceOf(BadRequestException);
        expect(mockOrderState.completeOrder).toHaveBeenCalledTimes(1);
      });
    });

    describe('rejectDelivery', () => {
      beforeEach(() => {
        mockPrisma.order.findFirst.mockResolvedValue(ORDER);
        mockPrisma.deliveryProof.findFirst.mockResolvedValue({ id: 'dp-1', status: 'SUBMITTED', orderId: 'ord-1' });
        mockPrisma.deliveryProof.findUnique.mockResolvedValue({ id: 'dp-1', status: 'SUBMITTED', orderId: 'ord-1' });
        mockPrisma.deliveryProof.count.mockResolvedValue(5); // 5th rejection → escalation draws a serial
        mockPrisma.dispute.findUnique.mockResolvedValue(null);
      });

      it('draws the dispute serial EXACTLY ONCE across 3 attempts', async () => {
        // Each attempt runs the real body, so a draw inside it would fire three times.
        mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
          await fn(mockPrisma);
          throw serializationFailure();
        });

        await expect(service.rejectDelivery('ORD-1', 'buyer', 'tidak sesuai')).rejects.toBeTruthy();

        expect(mockPrisma.$transaction).toHaveBeenCalledTimes(3);
        // Pre-fix: 3 draws, so two `dispute_serial` values were burned and left gaps in the day's
        // dispute sequence for a rejection that never committed.
        expect(mockSerial.getNextForPrefix).toHaveBeenCalledTimes(1);
      });

      it('reuses the same disputeId on a retry that succeeds', async () => {
        let attempt = 0;
        mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
          attempt += 1;
          await fn(mockPrisma);
          if (attempt === 1) throw serializationFailure();
          return undefined;
        });

        await service.rejectDelivery('ORD-1', 'buyer', 'tidak sesuai');

        expect(mockSerial.getNextForPrefix).toHaveBeenCalledTimes(1);
        const ids = mockPrisma.dispute.create.mock.calls.map((c) => (c[0] as { data: { disputeId: string } }).data.disputeId);
        expect(new Set(ids).size).toBe(1);
      });

      it('targets the requested proofId when rejecting a proof', async () => {
        mockPrisma.deliveryProof.count.mockResolvedValue(0);
        mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma));
        await expect(service.rejectDelivery('ORD-1', 'buyer', 'tidak sesuai', 'dp-specific')).resolves.toBeTruthy();
        expect(mockPrisma.deliveryProof.findFirst).toHaveBeenCalledWith({ where: { id: 'dp-specific', orderId: 'ord-1', status: 'SUBMITTED' } });
      });

      it('never draws a serial when the rejection does not escalate', async () => {
        mockPrisma.deliveryProof.count.mockResolvedValue(2); // below the escalation threshold
        mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma));

        await service.rejectDelivery('ORD-1', 'buyer', 'tidak sesuai');

        // Memoizing rather than hoisting unconditionally: the draw is conditional, so the four
        // earlier rejections must not consume a serial at all.
        expect(mockSerial.getNextForPrefix).not.toHaveBeenCalled();
        expect(mockPrisma.dispute.create).not.toHaveBeenCalled();
      });

      it('retries a serialization failure and succeeds on the next attempt', async () => {
        mockPrisma.$transaction.mockRejectedValueOnce(serializationFailure()).mockResolvedValueOnce(undefined);

        await expect(service.rejectDelivery('ORD-1', 'buyer', 'tidak sesuai')).resolves.toBeTruthy();
        expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);
      });
    });

    describe('submitProof', () => {
      it('rejects a description that becomes empty after trimming', async () => {
        await expect(service.submitProof('ORD-1', 'seller', { description: '          ' })).rejects.toBeInstanceOf(BadRequestException);
        expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      });

      it('rejects duplicate proof file keys before opening a transaction', async () => {
        const fileKey = 'uploads/delivery-proof/seller/proof.jpg';
        await expect(service.submitProof('ORD-1', 'seller', { description: 'Bukti pengiriman valid', fileUrls: [fileKey, fileKey] })).rejects.toBeInstanceOf(BadRequestException);
        expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      });

      it('does not let physical delivery proof bypass missing shipping details', async () => {
        mockPrisma.order.findFirst.mockResolvedValue({ ...ORDER, orderType: 'PHYSICAL_GOODS', trackingNumber: null, courierName: null });
        mockPrisma.order.findUnique.mockResolvedValue({ ...ORDER, orderType: 'PHYSICAL_GOODS', trackingNumber: null, courierName: null });
        mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma));
        await expect(service.submitProof('ORD-1', 'seller', { description: 'Bukti pengiriman valid' })).rejects.toBeInstanceOf(BadRequestException);
        expect(mockPrisma.deliveryProof.create).not.toHaveBeenCalled();
      });

      it('retries a serialization failure and succeeds on the next attempt', async () => {
        mockPrisma.$transaction
          .mockRejectedValueOnce(serializationFailure())
          .mockResolvedValueOnce({
            proof: { id: 'dp-9', status: 'SUBMITTED', reviewWindowEnd: new Date() },
            buyerId: 'buyer',
            orderTitle: 'Jasa',
            orderPublicId: 'ORD-1',
          });

        await expect(service.submitProof('ORD-1', 'seller', { description: 'sudah dikirim' })).resolves.toBeTruthy();
        expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);
      });

      it('does not notify the buyer when every attempt fails', async () => {
        mockPrisma.$transaction.mockRejectedValue(serializationFailure());

        await expect(service.submitProof('ORD-1', 'seller', { description: 'sudah dikirim' })).rejects.toBeTruthy();
        expect(mockQueue.enqueue).not.toHaveBeenCalled();
        expect(mockPrisma.$transaction).toHaveBeenCalledTimes(3);
      });
    });
  });
});
