import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { DisputeCallStatus } from '@prisma/client';
import { DisputeCallService } from '../dispute-call.service';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  DISPUTE_CALL_MAX_DURATION_SECONDS,
  DISPUTE_CALL_REQUEST_EXPIRY_SECONDS,
} from '../../../common/constants/app.constants';

/*
 * DC-02 regression: acceptCall / rejectCall / endCall each read the row with a separate
 * `findFirst` and then wrote it blind via `update({ where: { id } })`. Two concurrent
 * transitions — or one racing the expiry cron — both passed the read and both wrote, so the
 * loser silently overwrote the winner's terminal state and still returned success. The fix
 * moves the status predicate into the write (`updateMany` + `count === 0` throw), which is the
 * state-transition primitive used everywhere else in this codebase.
 *
 * DC-03 regression: acceptCall reused MAX_DURATION_SECONDS (900, a *call duration* cap) as the
 * *request expiry* window while the cron that reaps stale requests used 600, so a request could
 * be accepted after the cron already considered it expired.
 */

type MockPrisma = {
  $queryRaw: jest.Mock;
  $transaction: jest.Mock;
  dispute: { findFirst: jest.Mock };
  disputeCall: {
    findFirst: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
    findMany: jest.Mock;
  };
};

const mockPrisma = {} as MockPrisma;
mockPrisma.$queryRaw = jest.fn();
mockPrisma.$transaction = jest.fn(async (callback: (tx: MockPrisma) => Promise<unknown>) => callback(mockPrisma));
mockPrisma.dispute = { findFirst: jest.fn() };
mockPrisma.disputeCall = {
  findFirst: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  updateMany: jest.fn(),
  findMany: jest.fn(),
};

const DISPUTE_ROW = {
  id: 'disp-1',
  disputeId: 'D-1',
  status: 'OPEN',
  order: { buyerId: 'buyer-1', sellerId: 'seller-1', status: 'DISPUTED' },
};

describe('DisputeCallService', () => {
  let service: DisputeCallService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [DisputeCallService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = module.get<DisputeCallService>(DisputeCallService);
    mockPrisma.dispute.findFirst.mockResolvedValue(DISPUTE_ROW);
  });

  describe('acceptCall', () => {
    const pendingCall = {
      id: 'call-1',
      disputeId: 'disp-1',
      requestedById: 'buyer-1',
      status: DisputeCallStatus.REQUESTED,
      requestedAt: new Date(),
    };

    it('should guard the accept write on status so a lost race cannot overwrite it', async () => {
      mockPrisma.disputeCall.findFirst.mockResolvedValue(pendingCall);
      mockPrisma.disputeCall.updateMany.mockResolvedValue({ count: 1 });

      await service.acceptCall('disp-1', 'seller-1', 'call-1');

      expect(mockPrisma.disputeCall.update).not.toHaveBeenCalled();
      expect(mockPrisma.disputeCall.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'call-1',
            status: DisputeCallStatus.REQUESTED,
          }),
        }),
      );
    });

    it('should throw when the guarded write matches no row (concurrent reject/expiry won)', async () => {
      mockPrisma.disputeCall.findFirst.mockResolvedValue(pendingCall);
      mockPrisma.disputeCall.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.acceptCall('disp-1', 'seller-1', 'call-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should reject a request older than the request-expiry window, not the duration cap', async () => {
      // Between the two windows: stale by the cron's rule, fresh by the old (wrong) rule.
      const ageSeconds = (DISPUTE_CALL_REQUEST_EXPIRY_SECONDS + DISPUTE_CALL_MAX_DURATION_SECONDS) / 2;
      expect(ageSeconds).toBeGreaterThan(DISPUTE_CALL_REQUEST_EXPIRY_SECONDS);
      expect(ageSeconds).toBeLessThan(DISPUTE_CALL_MAX_DURATION_SECONDS);

      mockPrisma.disputeCall.findFirst.mockResolvedValue({
        ...pendingCall,
        requestedAt: new Date(Date.now() - ageSeconds * 1000),
      });

      await expect(service.acceptCall('disp-1', 'seller-1', 'call-1')).rejects.toThrow(
        BadRequestException,
      );
      expect(mockPrisma.disputeCall.updateMany).toHaveBeenCalledWith({
        where: { id: 'call-1', status: DisputeCallStatus.REQUESTED },
        data: expect.objectContaining({ status: DisputeCallStatus.EXPIRED, endedAt: expect.any(Date) }),
      });
    });

    it('should still refuse the requester accepting their own call', async () => {
      mockPrisma.disputeCall.findFirst.mockResolvedValue(pendingCall);

      await expect(service.acceptCall('disp-1', 'buyer-1', 'call-1')).rejects.toThrow(
        BadRequestException,
      );
      expect(mockPrisma.disputeCall.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('rejectCall', () => {
    it('should guard the reject write on status', async () => {
      mockPrisma.disputeCall.findFirst.mockResolvedValue({
        id: 'call-1',
        disputeId: 'disp-1',
        requestedById: 'buyer-1',
        status: DisputeCallStatus.REQUESTED,
        requestedAt: new Date(),
      });
      mockPrisma.disputeCall.updateMany.mockResolvedValue({ count: 1 });

      await service.rejectCall('disp-1', 'seller-1', 'call-1');

      expect(mockPrisma.disputeCall.update).not.toHaveBeenCalled();
      expect(mockPrisma.disputeCall.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: DisputeCallStatus.REQUESTED }),
          data: expect.objectContaining({ status: DisputeCallStatus.REJECTED }),
        }),
      );
    });

    it('should throw when the call is no longer pending', async () => {
      mockPrisma.disputeCall.findFirst.mockResolvedValue({
        id: 'call-1',
        disputeId: 'disp-1',
        requestedById: 'buyer-1',
        status: DisputeCallStatus.REQUESTED,
        requestedAt: new Date(),
      });
      mockPrisma.disputeCall.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.rejectCall('disp-1', 'seller-1', 'call-1')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('endCall', () => {
    it('should guard the end write on the active statuses and compute duration from startedAt', async () => {
      const startedAt = new Date(Date.now() - 120_000);
      mockPrisma.disputeCall.findFirst.mockResolvedValue({
        id: 'call-1',
        disputeId: 'disp-1',
        requestedById: 'buyer-1',
        status: DisputeCallStatus.IN_PROGRESS,
        requestedAt: new Date(),
        startedAt,
      });
      mockPrisma.disputeCall.updateMany.mockResolvedValue({ count: 1 });

      const result = (await service.endCall('disp-1', 'seller-1', 'call-1')) as {
        durationSeconds: number;
      };

      expect(mockPrisma.disputeCall.update).not.toHaveBeenCalled();
      expect(mockPrisma.disputeCall.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: { in: [DisputeCallStatus.ACCEPTED, DisputeCallStatus.IN_PROGRESS] },
          }),
        }),
      );
      // startedAt is stamped on join, so a real duration is recorded rather than 0.
      expect(result.durationSeconds).toBeGreaterThanOrEqual(119);
    });

    it('should throw when the call was already ended concurrently', async () => {
      mockPrisma.disputeCall.findFirst.mockResolvedValue({
        id: 'call-1',
        disputeId: 'disp-1',
        requestedById: 'buyer-1',
        status: DisputeCallStatus.IN_PROGRESS,
        requestedAt: new Date(),
        startedAt: new Date(),
      });
      mockPrisma.disputeCall.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.endCall('disp-1', 'seller-1', 'call-1')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('requestCall', () => {
    it('should refuse a second call while one is active and use the shared duration cap', async () => {
      mockPrisma.disputeCall.findFirst.mockResolvedValue({ id: 'call-existing' });

      await expect(service.requestCall('disp-1', 'buyer-1')).rejects.toThrow(BadRequestException);
      expect(mockPrisma.disputeCall.create).not.toHaveBeenCalled();
    });

    it('should stamp maxDurationSeconds from the shared constant', async () => {
      mockPrisma.disputeCall.findFirst.mockResolvedValue(null);
      mockPrisma.disputeCall.create.mockResolvedValue({
        id: 'call-1',
        status: DisputeCallStatus.REQUESTED,
        requestedAt: new Date(),
      });

      await service.requestCall('disp-1', 'buyer-1');

      expect(mockPrisma.disputeCall.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            maxDurationSeconds: DISPUTE_CALL_MAX_DURATION_SECONDS,
          }),
        }),
      );
    });
  });

  describe('validateDisputeAccess', () => {
    it('should refuse a non-participant', async () => {
      await expect(service.requestCall('disp-1', 'stranger-1')).rejects.toThrow();
      expect(mockPrisma.disputeCall.create).not.toHaveBeenCalled();
    });

    it('should refuse call actions on a resolved dispute', async () => {
      mockPrisma.dispute.findFirst.mockResolvedValue({ ...DISPUTE_ROW, status: 'RESOLVED' });

      await expect(service.requestCall('disp-1', 'buyer-1')).rejects.toThrow(BadRequestException);
      expect(mockPrisma.disputeCall.create).not.toHaveBeenCalled();
    });

    it('should 404 an unknown dispute', async () => {
      mockPrisma.dispute.findFirst.mockResolvedValue(null);

      await expect(service.requestCall('nope', 'buyer-1')).rejects.toThrow(NotFoundException);
    });
  });
});
