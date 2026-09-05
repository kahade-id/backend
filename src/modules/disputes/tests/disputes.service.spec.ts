import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DisputesService } from '../disputes.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { WalletTxSerialService } from '../../../common/services/wallet-tx-serial.service';
import { UploadService } from '../../upload/upload.service';
import { AuditLogService } from '../../../common/services/audit-log.service';

const mockPrisma = {
  dispute: { findMany: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn(), count: jest.fn(), update: jest.fn(), groupBy: jest.fn() },
  disputeEvidence: { findMany: jest.fn(), findUnique: jest.fn(), count: jest.fn(), create: jest.fn(), delete: jest.fn(), deleteMany: jest.fn() },
  order: { findUnique: jest.fn() },
  notification: { create: jest.fn() },
  emitNotificationCreated: jest.fn(),
  $transaction: jest.fn(),
  $queryRaw: jest.fn(),
};
const mockSerial = { getNextForPrefix: jest.fn().mockResolvedValue(1) };
const mockUpload = {
  verifyFileMagicBytes: jest.fn().mockResolvedValue(true),
  generatePresignedUrl: jest.fn().mockResolvedValue('https://signed.example/key'),
  generateDownloadUrl: jest.fn().mockResolvedValue('https://signed.example/key'),
  deleteFile: jest.fn().mockResolvedValue(undefined),
  verifyEvidenceFileKeysBatch: jest.fn(),
  getFileSize: jest.fn(),
  cleanupFileKeys: jest.fn().mockResolvedValue(undefined),
};
const mockAuditLog = {
  logUserAction: jest.fn(),
};

describe('DisputesService', () => {
  let service: DisputesService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DisputesService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: WalletTxSerialService, useValue: mockSerial },
        { provide: UploadService, useValue: mockUpload },
        { provide: AuditLogService, useValue: mockAuditLog },
      ],
    }).compile();
    service = module.get<DisputesService>(DisputesService);
  });

  describe('getDisputeDetail — cross-user authorization', () => {
    it('THROWS NotFoundException when dispute does not exist', async () => {
      mockPrisma.dispute.findFirst.mockResolvedValue(null);
      await expect(service.getDisputeDetail('disp-x', 'user-1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('THROWS ForbiddenException when user is not buyer or seller of disputed order', async () => {
      mockPrisma.dispute.findFirst.mockResolvedValue({
        id: 'disp-1',
        disputeId: 'D1',
        status: 'OPEN',
        order: { buyerId: 'buyer', sellerId: 'seller', orderId: 'O1', buyer: { userId: 'buyer' }, seller: { userId: 'seller' } },
        evidences: [],
        decision: null,
        calls: [],
      });
      await expect(service.getDisputeDetail('disp-1', 'attacker')).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('submitEvidence — TOCTOU regression (Phase 11)', () => {
    const baseDispute = {
      id: 'disp-1',
      disputeId: 'D1',
      status: 'OPEN',
      order: { buyerId: 'buyer', sellerId: 'seller', status: 'DISPUTED' },
    };

    beforeEach(() => {
      mockUpload.verifyEvidenceFileKeysBatch.mockResolvedValue([
        { fileKey: 'k1', fileType: 'image/jpeg', status: 'ok' },
      ]);
      mockUpload.getFileSize.mockResolvedValue(1024);
    });

    it('THROWS when dispute closes between pre-check and FOR UPDATE lock', async () => {
      mockPrisma.dispute.findFirst.mockResolvedValue(baseDispute);
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const tx = {
          $queryRaw: jest.fn().mockResolvedValue([{ id: 'disp-1' }]),
          dispute: {
            findUnique: jest.fn().mockResolvedValue({
              status: 'RESOLVED',
              order: { status: 'DISPUTED' },
            }),
          },
          disputeEvidence: { count: jest.fn(), findMany: jest.fn(), create: jest.fn() },
        };
        return fn(tx);
      });

      await expect(
        service.submitEvidence('disp-1', 'buyer', { fileUrls: ['k1'], fileTypes: ['image/jpeg'], description: 'x' } as any),
      ).rejects.toMatchObject({ response: { code: 'DISPUTE_CLOSED_FOR_EVIDENCE' } });
    });

    it('THROWS when order leaves DISPUTED status between pre-check and lock', async () => {
      mockPrisma.dispute.findFirst.mockResolvedValue(baseDispute);
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const tx = {
          $queryRaw: jest.fn().mockResolvedValue([{ id: 'disp-1' }]),
          dispute: {
            findUnique: jest.fn().mockResolvedValue({
              status: 'OPEN',
              order: { status: 'COMPLETED' },
            }),
          },
          disputeEvidence: { count: jest.fn(), findMany: jest.fn(), create: jest.fn() },
        };
        return fn(tx);
      });

      await expect(
        service.submitEvidence('disp-1', 'buyer', { fileUrls: ['k1'], fileTypes: ['image/jpeg'], description: 'x' } as any),
      ).rejects.toMatchObject({ response: { code: 'ORDER_NOT_IN_DISPUTE' } });
    });
  });

  describe('submitEvidence — input validation', () => {
    const baseDispute = {
      id: 'disp-1',
      disputeId: 'D1',
      status: 'OPEN',
      order: { buyerId: 'buyer', sellerId: 'seller', status: 'DISPUTED' },
    };

    it('REJECTS when fileUrls and fileTypes lengths differ', async () => {
      mockPrisma.dispute.findFirst.mockResolvedValue(baseDispute);
      await expect(
        service.submitEvidence('disp-1', 'buyer', { fileUrls: ['a', 'b'], fileTypes: ['image/jpeg'], description: 'x' } as any),
      ).rejects.toMatchObject({ response: { code: 'VALIDATION_ERROR' } });
    });

    it('REJECTS unsupported MIME types', async () => {
      mockPrisma.dispute.findFirst.mockResolvedValue(baseDispute);
      await expect(
        service.submitEvidence('disp-1', 'buyer', { fileUrls: ['k'], fileTypes: ['application/x-msdownload'], description: 'x' } as any),
      ).rejects.toMatchObject({ response: { code: 'INVALID_FILE_TYPE' } });
    });

    it('REJECTS evidence when order is not DISPUTED', async () => {
      mockPrisma.dispute.findFirst.mockResolvedValue({
        ...baseDispute,
        order: { ...baseDispute.order, status: 'COMPLETED' },
      });
      await expect(
        service.submitEvidence('disp-1', 'buyer', { fileUrls: ['k'], fileTypes: ['image/jpeg'], description: 'x' } as any),
      ).rejects.toMatchObject({ response: { code: 'ORDER_NOT_IN_DISPUTE' } });
    });

    it('REJECTS evidence when user is not buyer or seller', async () => {
      mockPrisma.dispute.findFirst.mockResolvedValue(baseDispute);
      await expect(
        service.submitEvidence('disp-1', 'attacker', { fileUrls: ['k'], fileTypes: ['image/jpeg'], description: 'x' } as any),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('submitEvidence — 50 MB total size limit', () => {
    const baseDispute = {
      id: 'disp-1',
      disputeId: 'D1',
      status: 'OPEN',
      order: { buyerId: 'buyer', sellerId: 'seller', status: 'DISPUTED' },
    };

    it('REJECTS evidence whose total size pushes the dispute above 50 MB', async () => {
      mockPrisma.dispute.findFirst.mockResolvedValue(baseDispute);
      mockUpload.verifyEvidenceFileKeysBatch.mockResolvedValue([
        { fileKey: 'big', fileType: 'image/jpeg', status: 'ok' },
      ]);
      // First call computes new file size; subsequent calls compute existing evidence size.
      // Each file ≤ 10 MB (per-file cap). Build existing total to push past 50 MB.
      // New: 5 MB once; existing: 7 files × 8 MB = 56 MB → grand total 61 MB.
      mockUpload.getFileSize
        .mockResolvedValueOnce(5 * 1024 * 1024)
        .mockResolvedValue(8 * 1024 * 1024);

      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const tx = {
          $queryRaw: jest.fn().mockResolvedValue([{ id: 'disp-1' }]),
          dispute: {
            findUnique: jest.fn().mockResolvedValue({ status: 'OPEN', order: { status: 'DISPUTED' } }),
          },
          disputeEvidence: {
            count: jest.fn().mockResolvedValue(1),
            findMany: jest.fn().mockResolvedValue([
              { fileUrls: ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7'] },
            ]),
            create: jest.fn(),
          },
        };
        return fn(tx);
      });

      await expect(
        service.submitEvidence('disp-1', 'buyer', { fileUrls: ['big'], fileTypes: ['image/jpeg'], description: 'x' } as any),
      ).rejects.toMatchObject({ response: { code: 'EVIDENCE_SIZE_LIMIT_EXCEEDED' } });
    });
  });

  describe('listMyDisputes — pagination safety', () => {
    it('clamps page < 1 to 1 and limit > 100 to 100', async () => {
      mockPrisma.dispute.findMany.mockResolvedValue([]);
      mockPrisma.dispute.count.mockResolvedValue(0);
      await service.listMyDisputes('user-1', 0, 999);
      const callArgs = mockPrisma.dispute.findMany.mock.calls[0][0];
      expect(callArgs.skip).toBe(0); // (max(1,0) - 1) * 100 = 0
      expect(callArgs.take).toBeLessThanOrEqual(100);
    });
  });

  describe('deleteEvidence — C-06 TOCTOU regression', () => {
    const baseDispute = {
      id: 'disp-1',
      disputeId: 'D1',
      status: 'OPEN',
      order: { buyerId: 'buyer', sellerId: 'seller', status: 'DISPUTED' },
    };
    const baseEvidence = {
      id: 'ev-1',
      disputeId: 'disp-1',
      submittedByUserId: 'buyer',
      fileUrls: ['k1'],
    };

    beforeEach(() => {
      mockPrisma.dispute.findFirst.mockResolvedValue(baseDispute);
      mockPrisma.disputeEvidence.findUnique.mockResolvedValue(baseEvidence);
      mockPrisma.$transaction.mockImplementation(
        async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma),
      );
    });

    it('deletes the evidence when the dispute is still open', async () => {
      mockPrisma.dispute.findUnique.mockResolvedValue({ status: 'OPEN' });
      mockPrisma.disputeEvidence.deleteMany.mockResolvedValue({ count: 1 });

      await expect(service.deleteEvidence('disp-1', 'ev-1', 'buyer')).resolves.toEqual({ deleted: true });
      expect(mockUpload.cleanupFileKeys).toHaveBeenCalledWith('buyer', ['k1']);
    });

    it('re-checks the dispute status INSIDE the locked transaction', async () => {
      // The dispute was OPEN at the unlocked pre-check, but an admin moved it to
      // UNDER_REVIEW before the lock was acquired.
      mockPrisma.dispute.findUnique.mockResolvedValue({ status: 'UNDER_REVIEW' });
      mockPrisma.disputeEvidence.deleteMany.mockResolvedValue({ count: 1 });

      await expect(service.deleteEvidence('disp-1', 'ev-1', 'buyer')).rejects.toThrow(BadRequestException);
      expect(mockPrisma.disputeEvidence.deleteMany).not.toHaveBeenCalled();
      expect(mockPrisma.disputeEvidence.delete).not.toHaveBeenCalled();
      // Evidence an admin is actively deciding on must not have its S3 objects purged.
      expect(mockUpload.cleanupFileKeys).not.toHaveBeenCalled();
    });

    it('rejects a race that resolved the dispute before the lock', async () => {
      mockPrisma.dispute.findUnique.mockResolvedValue({ status: 'RESOLVED' });
      mockPrisma.disputeEvidence.deleteMany.mockResolvedValue({ count: 1 });

      await expect(service.deleteEvidence('disp-1', 'ev-1', 'buyer')).rejects.toThrow(BadRequestException);
      expect(mockUpload.cleanupFileKeys).not.toHaveBeenCalled();
    });

    it('takes a FOR UPDATE lock on the dispute row before deleting', async () => {
      mockPrisma.dispute.findUnique.mockResolvedValue({ status: 'OPEN' });
      mockPrisma.disputeEvidence.deleteMany.mockResolvedValue({ count: 1 });

      await service.deleteEvidence('disp-1', 'ev-1', 'buyer');

      expect(mockPrisma.$queryRaw).toHaveBeenCalled();
      const lockOrder = mockPrisma.$queryRaw.mock.invocationCallOrder[0];
      const deleteOrder = mockPrisma.disputeEvidence.deleteMany.mock.invocationCallOrder[0];
      expect(lockOrder).toBeLessThan(deleteOrder);
    });

    it('turns a concurrent double-delete into a 404, not an unhandled P2025', async () => {
      mockPrisma.dispute.findUnique.mockResolvedValue({ status: 'OPEN' });
      mockPrisma.disputeEvidence.deleteMany.mockResolvedValue({ count: 0 });

      await expect(service.deleteEvidence('disp-1', 'ev-1', 'buyer')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('scopes the delete to the owner and dispute, not the bare id', async () => {
      mockPrisma.dispute.findUnique.mockResolvedValue({ status: 'OPEN' });
      mockPrisma.disputeEvidence.deleteMany.mockResolvedValue({ count: 1 });

      await service.deleteEvidence('disp-1', 'ev-1', 'buyer');

      const where = mockPrisma.disputeEvidence.deleteMany.mock.calls[0][0].where;
      expect(where).toMatchObject({ id: 'ev-1', disputeId: 'disp-1', submittedByUserId: 'buyer' });
    });

    it('still rejects a non-owner before reaching the transaction', async () => {
      mockPrisma.disputeEvidence.findUnique.mockResolvedValue({ ...baseEvidence, submittedByUserId: 'seller' });

      await expect(service.deleteEvidence('disp-1', 'ev-1', 'buyer')).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('evidence URL signing — C-07 fileUrls/fileTypes pairing', () => {
    const evidenceRow = {
      id: 'ev-1',
      disputeId: 'disp-1',
      fileUrls: ['k1', 'k2', 'k3'],
      fileTypes: ['image/jpeg', 'application/pdf', 'image/png'],
      createdAt: new Date(),
    };

    beforeEach(() => {
      mockPrisma.dispute.findFirst.mockResolvedValue({
        id: 'disp-1',
        disputeId: 'D1',
        status: 'OPEN',
        order: {
          buyerId: 'buyer',
          sellerId: 'seller',
          orderId: 'O1',
          orderValue: BigInt(0),
          status: 'DISPUTED',
          buyer: { userId: 'buyer' },
          seller: { userId: 'seller' },
        },
        evidences: [evidenceRow],
        decision: null,
        calls: [],
      });
      mockPrisma.disputeEvidence.findMany.mockResolvedValue([evidenceRow]);
      mockPrisma.disputeEvidence.count.mockResolvedValue(1);
      // The middle key fails to sign; k1 and k3 succeed.
      mockUpload.generateDownloadUrl.mockImplementation((key: string) =>
        key === 'k2' ? Promise.reject(new Error('sign failed')) : Promise.resolve(`https://signed/${key}`),
      );
    });

    it('listEvidence keeps fileTypes aligned with fileUrls when a signature fails', async () => {
      const res = await service.listEvidence('disp-1', 'buyer', 1, 10);
      const ev = (res.data as unknown as { fileUrls: string[]; fileTypes: string[] }[])[0];

      expect(ev.fileUrls).toEqual(['https://signed/k1', 'https://signed/k3']);
      // Without lockstep filtering this stayed 3-long and 'application/pdf' would
      // mislabel the k3 image.
      expect(ev.fileTypes).toEqual(['image/jpeg', 'image/png']);
      expect(ev.fileTypes).toHaveLength(ev.fileUrls.length);
    });

    it('getDisputeDetail never emits a null fileUrl', async () => {
      const res = await service.getDisputeDetail('disp-1', 'buyer');
      const ev = (res.evidences as { fileUrls: string[]; fileTypes: string[] }[])[0];

      // Mobile calls fileUrl.split('/') on the non-image branch; a null crashes the screen.
      expect(ev.fileUrls).not.toContain(null);
      expect(ev.fileUrls).toEqual(['https://signed/k1', 'https://signed/k3']);
      expect(ev.fileTypes).toEqual(['image/jpeg', 'image/png']);
    });

    it('passes through unchanged when every signature succeeds', async () => {
      mockUpload.generateDownloadUrl.mockImplementation((key: string) => Promise.resolve(`https://signed/${key}`));

      const res = await service.listEvidence('disp-1', 'buyer', 1, 10);
      const ev = (res.data as unknown as { fileUrls: string[]; fileTypes: string[] }[])[0];

      expect(ev.fileUrls).toEqual(['https://signed/k1', 'https://signed/k2', 'https://signed/k3']);
      expect(ev.fileTypes).toEqual(['image/jpeg', 'application/pdf', 'image/png']);
    });
  });

  /*
   * C-18: submitDispute's transaction runs at Serializable and locks the order FOR UPDATE (plus
   * the seller's wallet on the post-completion path), so it contends with
   * auto-complete-orders.service.ts and with the counterparty filing at the same instant. A
   * 40001/40P01 is the expected outcome of that contention, not a fault — without a retry it
   * surfaced as an opaque 500 to the party filing the dispute.
   *
   * C-19: the counterparty notification is a post-commit side effect. It used to sit inside the
   * transaction's try/catch as a bare await, so a transient notification failure rethrew a 500
   * for a dispute that HAD been filed; the client's retry then hit DISPUTE_ALREADY_EXISTS.
   */
  describe('submitDispute — C-18 Serializable retry / C-19 post-commit notification', () => {
    const order = {
      id: 'ord-1', orderId: 'O1', buyerId: 'buyer', sellerId: 'seller',
      status: 'IN_DELIVERY', completedAt: null,
    };
    const createdDispute = { id: 'disp-1', disputeId: 'DSP-0001' };
    const dto = { claim: 'item never arrived to buyer' };

    const serializationFailure = () =>
      new Prisma.PrismaClientUnknownRequestError(
        'could not serialize access due to read/write dependencies among transactions (SQLSTATE 40001)',
        { clientVersion: 'test' },
      );

    beforeEach(() => {
      // mockReset, not clearAllMocks: these tests queue `...ValueOnce` rejections, and a test
      // that makes fewer $transaction calls than expected would otherwise leak its unconsumed
      // queue into the next test.
      mockPrisma.$transaction.mockReset();
      mockPrisma.notification.create.mockReset();
      mockPrisma.order.findUnique.mockResolvedValue(order);
      mockPrisma.dispute.findUnique.mockResolvedValue(null);
      mockPrisma.notification.create.mockResolvedValue({ id: 'n1' });
      mockSerial.getNextForPrefix.mockResolvedValue(1);
    });

    it('retries a serialization failure and succeeds on the next attempt', async () => {
      mockPrisma.$transaction
        .mockRejectedValueOnce(serializationFailure())
        .mockResolvedValueOnce(createdDispute);

      await expect(service.submitDispute('O1', 'buyer', dto)).resolves.toEqual({
        disputeId: 'DSP-0001', status: 'OPEN',
      });
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);
    });

    it('treats P2034 as retryable', async () => {
      mockPrisma.$transaction
        .mockRejectedValueOnce(
          new Prisma.PrismaClientKnownRequestError('write conflict', { code: 'P2034', clientVersion: 'test' }),
        )
        .mockResolvedValueOnce(createdDispute);

      await expect(service.submitDispute('O1', 'buyer', dto)).resolves.toMatchObject({ disputeId: 'DSP-0001' });
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);
    });

    it('draws the dispute serial ONCE across retries, leaving no gap in the sequence', async () => {
      mockPrisma.$transaction
        .mockRejectedValueOnce(serializationFailure())
        .mockRejectedValueOnce(serializationFailure())
        .mockResolvedValueOnce(createdDispute);

      await service.submitDispute('O1', 'buyer', dto);

      // The serial is drawn outside the retry loop deliberately: a caller-level retry would
      // burn one dispute_serial per attempt.
      expect(mockSerial.getNextForPrefix).toHaveBeenCalledTimes(1);
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(3);
    });

    it('gives up after 3 attempts and rethrows rather than looping forever', async () => {
      mockPrisma.$transaction.mockRejectedValue(serializationFailure());

      await expect(service.submitDispute('O1', 'buyer', dto)).rejects.toBeInstanceOf(
        Prisma.PrismaClientUnknownRequestError,
      );
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(3);
    });

    it('does NOT retry a domain rejection thrown inside the transaction', async () => {
      mockPrisma.$transaction.mockRejectedValue(
        new BadRequestException({ code: 'DISPUTE_ALREADY_EXISTS', message: 'exists' }),
      );

      await expect(service.submitDispute('O1', 'buyer', dto)).rejects.toBeInstanceOf(BadRequestException);
      // Retrying a deterministic rejection just delays the same 400 by ~300 ms.
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('still maps a P2002 unique collision to DISPUTE_ALREADY_EXISTS', async () => {
      mockPrisma.$transaction.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' }),
      );

      await expect(service.submitDispute('O1', 'buyer', dto)).rejects.toMatchObject({
        response: { code: 'DISPUTE_ALREADY_EXISTS' },
      });
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('fails closed when an active order has no matching escrow lock', async () => {
      const activeOrder = { ...order, buyerPayAmount: 10000n, sellerReceiveAmount: 9000n, completedAt: null };
      mockPrisma.order.findUnique.mockResolvedValue(activeOrder);
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: any) => Promise<unknown>) => fn({
        dispute: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue(createdDispute) },
        order: { findUnique: jest.fn().mockResolvedValue(activeOrder), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        disputeEvidence: { create: jest.fn() },
        orderStatusHistory: { create: jest.fn() },
        walletTransaction: { findFirst: jest.fn().mockResolvedValue(null) },
        user: { update: jest.fn() },
        $queryRaw: jest.fn().mockResolvedValue([]),
      }));

      await expect(service.submitDispute('O1', 'buyer', dto)).rejects.toMatchObject({
        response: { code: 'ESCROW_LOCK_MISSING' },
      });
    });

    it('rolls back a post-completion dispute when seller funds cannot be frozen', async () => {
      const completedOrder = { ...order, status: 'COMPLETED', completedAt: new Date(), buyerPayAmount: 10000n, sellerReceiveAmount: 9000n };
      mockPrisma.order.findUnique.mockResolvedValue(completedOrder);
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: any) => Promise<unknown>) => fn({
        dispute: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue(createdDispute) },
        order: { findUnique: jest.fn().mockResolvedValue(completedOrder), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        disputeEvidence: { create: jest.fn() },
        orderStatusHistory: { create: jest.fn() },
        wallet: { findUnique: jest.fn()
          .mockResolvedValueOnce({ id: 'seller-wallet' })
          .mockResolvedValueOnce({ id: 'seller-wallet', isLocked: false, availableBalance: 1000n, version: 1 }) },
        walletTransaction: { create: jest.fn() },
        user: { update: jest.fn() },
        $queryRaw: jest.fn().mockResolvedValue([]),
      }));

      await expect(service.submitDispute('O1', 'buyer', dto)).rejects.toMatchObject({
        response: { code: 'POST_COMPLETION_FREEZE_FAILED' },
      });
    });

    it('C-19: returns the filed dispute even when the notification write fails', async () => {
      mockPrisma.$transaction.mockResolvedValue(createdDispute);
      mockPrisma.notification.create.mockRejectedValue(new Error('notification table unavailable'));

      // Pre-fix this rethrew a 500 for a dispute that was already durable.
      await expect(service.submitDispute('O1', 'buyer', dto)).resolves.toEqual({
        disputeId: 'DSP-0001', status: 'OPEN',
      });
    });

    it('C-19: notifies the counterparty, not the filer', async () => {
      mockPrisma.$transaction.mockResolvedValue(createdDispute);

      await service.submitDispute('O1', 'buyer', dto);

      expect(mockPrisma.notification.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ userId: 'seller' }) }),
      );
      expect(mockPrisma.emitNotificationCreated).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'seller' }),
      );
    });
  });
});
