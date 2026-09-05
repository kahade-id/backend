import { Injectable, NotFoundException, BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { DisputeCallStatus, Prisma } from '@prisma/client';
import * as ErrorCodes from '../../common/constants/error-codes';
import {
  DISPUTE_CALL_MAX_DURATION_SECONDS,
  DISPUTE_CALL_REQUEST_EXPIRY_SECONDS,
} from '../../common/constants/app.constants';

@Injectable()
export class DisputeCallService {
  private readonly logger = new Logger(DisputeCallService.name);

  constructor(
    private prisma: PrismaService,
  ) {}

  private readonly TERMINAL_STATUSES = ['RESOLVED', 'CANCELLED'];

  private async validateDisputeAccess(disputeId: string, userId: string, allowTerminal = false) {
    const dispute = await this.prisma.dispute.findFirst({
      where: { OR: [{ id: disputeId }, { disputeId }] },
      include: { order: { select: { buyerId: true, sellerId: true, status: true } } },
    });
    if (!dispute) {
      throw new NotFoundException({ code: ErrorCodes.DISPUTE_NOT_FOUND, message: 'Dispute not found' });
    }
    const { buyerId, sellerId } = dispute.order;
    if (userId !== buyerId && userId !== sellerId) {
      throw new ForbiddenException({ code: ErrorCodes.NOT_DISPUTE_PARTICIPANT, message: 'Not a participant of this dispute' });
    }
    if (!allowTerminal && this.TERMINAL_STATUSES.includes(dispute.status)) {
      throw new BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: 'Cannot perform call actions on a resolved or cancelled dispute' });
    }
    if (!allowTerminal && dispute.order.status !== 'DISPUTED') {
      throw new BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: 'Call actions require the linked order to remain in DISPUTED status' });
    }
    return dispute;
  }

  async requestCall(disputeId: string, userId: string): Promise<object> {
    const dispute = await this.validateDisputeAccess(disputeId, userId);

    // The preflight read above is only an authorization check. Serialize the
    // active-call check with creation by locking the dispute row; otherwise two
    // concurrent requests can both observe no active call and create duplicates.
    const call = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$queryRaw`SELECT id FROM disputes WHERE id = ${dispute.id} FOR UPDATE`;
      const freshDispute = await tx.dispute.findFirst({ where: { id: dispute.id }, select: { status: true, order: { select: { status: true } } } });
      if (!freshDispute || this.TERMINAL_STATUSES.includes(freshDispute.status) || freshDispute.order.status !== 'DISPUTED') {
        throw new BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: 'Cannot request a call for a resolved or cancelled dispute' });
      }
      const existing = await tx.disputeCall.findFirst({
        where: {
          disputeId: dispute.id,
          status: { in: [DisputeCallStatus.REQUESTED, DisputeCallStatus.ACCEPTED, DisputeCallStatus.IN_PROGRESS] },
        },
      });
      if (existing) {
        throw new BadRequestException({ code: ErrorCodes.DISPUTE_CALL_ALREADY_ACTIVE, message: 'There is already an active or pending call for this dispute' });
      }

      return tx.disputeCall.create({
        data: {
          disputeId: dispute.id,
          requestedById: userId,
          status: DisputeCallStatus.REQUESTED,
          maxDurationSeconds: DISPUTE_CALL_MAX_DURATION_SECONDS,
        },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    return { id: call.id, status: call.status, requestedAt: call.requestedAt };
  }

  async acceptCall(disputeId: string, userId: string, callId: string): Promise<object> {
    const dispute = await this.validateDisputeAccess(disputeId, userId);

    const result = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$queryRaw`SELECT id FROM disputes WHERE id = ${dispute.id} FOR UPDATE`;
      const freshDispute = await tx.dispute.findFirst({ where: { id: dispute.id }, select: { status: true, order: { select: { status: true } } } });
      if (!freshDispute || this.TERMINAL_STATUSES.includes(freshDispute.status) || freshDispute.order.status !== 'DISPUTED') {
        throw new BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: 'Cannot accept a call for a resolved or cancelled dispute' });
      }
      const call = await tx.disputeCall.findFirst({
        where: { id: callId, disputeId: dispute.id, status: DisputeCallStatus.REQUESTED },
      });
      if (!call) {
        throw new NotFoundException({ code: ErrorCodes.DISPUTE_CALL_NOT_FOUND, message: 'No pending call request found' });
      }
      if (call.requestedById === userId) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Cannot accept your own call request' });
      }
      const ageSeconds = (Date.now() - call.requestedAt.getTime()) / 1000;
      if (ageSeconds >= DISPUTE_CALL_REQUEST_EXPIRY_SECONDS) {
        await tx.disputeCall.updateMany({
          where: { id: callId, status: DisputeCallStatus.REQUESTED },
          data: { status: DisputeCallStatus.EXPIRED, endedAt: new Date() },
        });
        throw new BadRequestException({ code: ErrorCodes.DISPUTE_CALL_INVALID_STATUS, message: 'Call request has expired' });
      }
      const startedAt = new Date();
      const accepted = await tx.disputeCall.updateMany({
        where: { id: callId, status: DisputeCallStatus.REQUESTED },
        data: { status: DisputeCallStatus.IN_PROGRESS, acceptedAt: startedAt, startedAt },
      });
      if (accepted.count === 0) {
        throw new BadRequestException({ code: ErrorCodes.DISPUTE_CALL_INVALID_STATUS, message: 'Call request is no longer pending' });
      }
      return { id: callId, status: DisputeCallStatus.IN_PROGRESS, acceptedAt: startedAt, startedAt };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    return result;
  }

  async rejectCall(disputeId: string, userId: string, callId: string): Promise<object> {
    const dispute = await this.validateDisputeAccess(disputeId, userId);
    const result = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$queryRaw`SELECT id FROM disputes WHERE id = ${dispute.id} FOR UPDATE`;
      const freshDispute = await tx.dispute.findFirst({ where: { id: dispute.id }, select: { status: true, order: { select: { status: true } } } });
      if (!freshDispute || this.TERMINAL_STATUSES.includes(freshDispute.status) || freshDispute.order.status !== 'DISPUTED') {
        throw new BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: 'Cannot reject a call for a resolved or cancelled dispute' });
      }
      const call = await tx.disputeCall.findFirst({ where: { id: callId, disputeId: dispute.id, status: DisputeCallStatus.REQUESTED } });
      if (!call) {
        throw new NotFoundException({ code: ErrorCodes.DISPUTE_CALL_NOT_FOUND, message: 'No pending call request found' });
      }
      const updated = await tx.disputeCall.updateMany({
        where: { id: callId, disputeId: dispute.id, status: DisputeCallStatus.REQUESTED },
        data: { status: DisputeCallStatus.REJECTED, endedAt: new Date() },
      });
      if (updated.count === 0) throw new BadRequestException({ code: ErrorCodes.DISPUTE_CALL_INVALID_STATUS, message: 'Call request is no longer pending' });
      return { id: callId, status: DisputeCallStatus.REJECTED };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return result;
  }

  async endCall(disputeId: string, userId: string, callId: string): Promise<object> {
    const dispute = await this.validateDisputeAccess(disputeId, userId);
    const result = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$queryRaw`SELECT id FROM disputes WHERE id = ${dispute.id} FOR UPDATE`;
      const freshDispute = await tx.dispute.findFirst({ where: { id: dispute.id }, select: { status: true, order: { select: { status: true } } } });
      if (!freshDispute || this.TERMINAL_STATUSES.includes(freshDispute.status) || freshDispute.order.status !== 'DISPUTED') {
        throw new BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: 'Cannot end a call for a resolved or cancelled dispute' });
      }
      const call = await tx.disputeCall.findFirst({
        where: { id: callId, disputeId: dispute.id, status: { in: [DisputeCallStatus.ACCEPTED, DisputeCallStatus.IN_PROGRESS] } },
      });
      if (!call) throw new NotFoundException({ code: ErrorCodes.DISPUTE_CALL_NOT_FOUND, message: 'No active call found' });
      const endedAt = new Date();
      const durationSeconds = call.startedAt ? Math.floor((endedAt.getTime() - call.startedAt.getTime()) / 1000) : 0;
      const boundedDurationSeconds = Math.min(call.maxDurationSeconds ?? DISPUTE_CALL_MAX_DURATION_SECONDS, Math.max(0, durationSeconds));
      const updated = await tx.disputeCall.updateMany({
        where: { id: callId, disputeId: dispute.id, status: { in: [DisputeCallStatus.ACCEPTED, DisputeCallStatus.IN_PROGRESS] } },
        data: { status: DisputeCallStatus.ENDED, endedAt, durationSeconds: boundedDurationSeconds },
      });
      if (updated.count === 0) throw new BadRequestException({ code: ErrorCodes.DISPUTE_CALL_INVALID_STATUS, message: 'Call is no longer active' });
      return { id: callId, status: DisputeCallStatus.ENDED, durationSeconds: boundedDurationSeconds };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return result;
  }

  async getCallHistory(disputeId: string, userId: string, page: number = 1, limit: number = 20): Promise<object> {
    const dispute = await this.validateDisputeAccess(disputeId, userId, true);

    const safePage = Number.isFinite(page) && Number.isInteger(page) && page > 0 ? page : 1;
    const safeLimit = Number.isFinite(limit) && Number.isInteger(limit) && limit > 0 ? Math.min(limit, 50) : 20;
    const skip = (safePage - 1) * safeLimit;

    const calls = await this.prisma.disputeCall.findMany({
      where: { disputeId: dispute.id },
      orderBy: { createdAt: 'desc' },
      skip,
      take: safeLimit,
      select: {
        id: true,
        status: true,
        requestedById: true,
        requestedAt: true,
        acceptedAt: true,
        startedAt: true,
        endedAt: true,
        durationSeconds: true,
        createdAt: true,
      },
    });

    const total = await this.prisma.disputeCall.count({ where: { disputeId: dispute.id } });
    return { calls, total, page: safePage, limit: safeLimit, totalPages: Math.ceil(total / safeLimit), hasNext: safePage * safeLimit < total, hasPrev: safePage > 1 };
  }

}
