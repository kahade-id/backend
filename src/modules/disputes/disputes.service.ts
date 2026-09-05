import { Injectable, NotFoundException, ForbiddenException, BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { randomInt } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { WalletTxSerialService } from '../../common/services/wallet-tx-serial.service';
import { UploadService } from '../upload/upload.service';
import { AuditLogService } from '../../common/services/audit-log.service';
import { createPaginatedResponse, PaginatedResponse } from '../../common/dto/pagination.dto';
import { UserAuditAction, OrderStatus, DisputeStatus, DisputeInitiator, ActorType, NotificationType, WalletTransactionType, WalletTransactionStatus, DisputeEvidence, Prisma } from '@prisma/client';
import { generateDisputeId, generateNotifId, generateWalletTxId } from '../../common/utils/id-generator.util';
import { getCategoryForType } from '../notifications/notification-category.map';
import { toIdr } from '../../common/utils/currency.util';
import * as ErrorCodes from '../../common/constants/error-codes';
import { DISPUTE_SLA_HOURS, POST_COMPLETION_DISPUTE_WINDOW_HOURS } from '../../common/constants/app.constants';
import { SubmitEvidenceDto } from './dto/submit-evidence.dto';
import { SubmitClaimDto } from './dto/submit-claim.dto';

const DISPUTE_EVIDENCE_ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

/*
 * C-07: drop failed signatures from `fileUrls` and `fileTypes` in lockstep.
 *
 * `fileTypes[i]` describes `fileUrls[i]` — the mobile renderer relies on exactly that
 * (`components/dispute/DisputeEvidenceList.tsx:46` reads `ev.fileTypes?.[fIdx]` to pick between an
 * <Image> and a file row). Two bugs came from breaking the pairing:
 *
 *  - `listEvidence` filtered nulls out of `fileUrls` but returned `fileTypes` untouched, so one
 *    failed signature shifted the URLs and misaligned every type after it — a PDF then rendered as
 *    an image, and the last type described nothing.
 *  - `getDisputeDetail` did not filter at all, so a `null` reached the client. On the non-image
 *    branch mobile calls `fileUrl.split('/')` (`DisputeEvidenceList.tsx:62`), which throws on null
 *    and takes down the whole dispute detail screen.
 *
 * Filtering both together keeps the indexes meaningful and keeps nulls off the wire.
 */
function dropFailedUrls(
  signedUrls: (string | null)[],
  fileTypes: string[] | null | undefined,
): { fileUrls: string[]; fileTypes: string[] } {
  const keptUrls: string[] = [];
  const keptTypes: string[] = [];
  signedUrls.forEach((url, i) => {
    if (url === null) return;
    keptUrls.push(url);
    keptTypes.push(fileTypes?.[i] ?? '');
  });
  return { fileUrls: keptUrls, fileTypes: keptTypes };
}

@Injectable()
export class DisputesService {
  private readonly logger = new Logger(DisputesService.name);

  constructor(
    private prisma: PrismaService,
    private serialService: WalletTxSerialService,
    private uploadService: UploadService,
    private auditLog: AuditLogService,
  ) {}

  // C-18: same predicate as `mutual-resolution.service.ts:521` and `order-state.service.ts:582`.
  private isRetryableDbError(err: unknown): boolean {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') return true;
    if (err instanceof Prisma.PrismaClientUnknownRequestError) {
      const msg = err.message.toLowerCase();
      if (msg.includes('40001') || msg.includes('serialization') || msg.includes('40p01') || msg.includes('deadlock')) return true;
    }
    return false;
  }

  private async withSerializableRetry<T>(operation: () => Promise<T>, label: string): Promise<T> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await operation();
      } catch (error: unknown) {
        if (!this.isRetryableDbError(error) || attempt === 3) throw error;
        this.logger.warn(`${label}_RETRY attempt=${attempt}/3`);
        await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, attempt - 1) + randomInt(0, 50)));
      }
    }
    throw new Error(`${label} exhausted retry loop`);
  }

  private runRealtimeBestEffort(task: () => void, label: string): void {
    try {
      task();
    } catch (error: unknown) {
      this.logger.warn(`${label} realtime side effect failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async cleanupEvidenceUploads(userId: string, fileKeys: string[]): Promise<void> {
    if (fileKeys.length === 0) return;
    try {
      await this.uploadService.cleanupFileKeys(userId, fileKeys);
    } catch (error: unknown) {
      this.logger.warn(`Dispute evidence cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async listMyDisputes(userId: string, page: number, limit: number): Promise<PaginatedResponse<Record<string, unknown>>> {
    const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
    const safeLimit = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.floor(limit))) : 20;
    const skip = (safePage - 1) * safeLimit;

    const where = {
      order: {
        OR: [{ buyerId: userId }, { sellerId: userId }],
      },
    };

    const [disputes, total] = await Promise.all([
      this.prisma.dispute.findMany({
        where,
        skip,
        take: safeLimit,
        orderBy: { createdAt: 'desc' },
        include: {
          order: {
            select: {
              orderId: true,
              title: true,
              orderValue: true,
              buyerId: true,
              sellerId: true,
            },
          },
        },
      }),
      this.prisma.dispute.count({ where }),
    ]);

    const serialized = disputes.map((d) => ({
      ...d,
      order: { ...d.order, orderValue: toIdr(d.order.orderValue) },
    }));
    return createPaginatedResponse(serialized, total, safePage, safeLimit);
  }

  async listEvidence(disputeId: string, userId: string, page: number, limit: number): Promise<PaginatedResponse<DisputeEvidence>> {
    const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
    const safeLimit = Number.isFinite(limit) ? Math.min(50, Math.max(1, Math.floor(limit))) : 20;
    const dispute = await this.prisma.dispute.findFirst({
      where: { OR: [{ id: disputeId }, { disputeId }] },
      include: {
        order: { select: { buyerId: true, sellerId: true } },
      },
    });

    if (!dispute) {
      throw new NotFoundException({ code: ErrorCodes.DISPUTE_NOT_FOUND, message: 'Dispute not found' });
    }

    if (dispute.order.buyerId !== userId && dispute.order.sellerId !== userId) {
      throw new ForbiddenException({ code: ErrorCodes.NOT_DISPUTE_PARTICIPANT, message: 'You are not a participant in this dispute' });
    }

    const where: Prisma.DisputeEvidenceWhereInput = { disputeId: dispute.id };
    const [data, total] = await Promise.all([
      this.prisma.disputeEvidence.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
      }),
      this.prisma.disputeEvidence.count({ where }),
    ]);

    const EVIDENCE_URL_EXPIRY_SECONDS = 900;
    const signedData = await Promise.all(
      data.map(async (evidence) => {
        const signedUrls = await Promise.all(
          // SEC-046/UPLOAD-001: return null on URL generation failure instead of the raw S3
          // key. Returning the key leaks an internal storage path to clients — any fetch
          // attempt would receive a 403 from S3 anyway, so null is both safer and more
          // honest about the failure.
          (evidence.fileUrls as string[]).map((key) =>
            this.uploadService.generateDownloadUrl(key, EVIDENCE_URL_EXPIRY_SECONDS).catch(() => null),
          ),
        );
        return { ...evidence, ...dropFailedUrls(signedUrls, evidence.fileTypes as string[]) };
      }),
    );

    return createPaginatedResponse(signedData, total, safePage, safeLimit);
  }

  async getDisputeDetail(disputeId: string, userId: string): Promise<Record<string, unknown>> {
    const dispute = await this.prisma.dispute.findFirst({
      where: { OR: [{ id: disputeId }, { disputeId }] },
      include: {
        order: {
          select: {
            orderId: true,
            title: true,
            orderValue: true,
            buyerId: true,
            sellerId: true,
            status: true,
            buyer: { select: { userId: true } },
            seller: { select: { userId: true } },
          },
        },
        evidences: { orderBy: { createdAt: 'asc' }, take: 50 },
        decision: {
          select: {
            id: true,
            decisionType: true,
            buyerAmount: true,
            sellerAmount: true,
            buyerPercent: true,
            sellerPercent: true,
            createdAt: true,
          },
        },
        calls: { orderBy: { createdAt: 'desc' }, take: 5 },
      },
    });

    if (!dispute) {
      throw new NotFoundException({ code: ErrorCodes.DISPUTE_NOT_FOUND, message: 'Dispute not found' });
    }

    if (dispute.order.buyerId !== userId && dispute.order.sellerId !== userId) {
      throw new ForbiddenException({ code: ErrorCodes.NOT_DISPUTE_PARTICIPANT, message: 'You are not a participant in this dispute' });
    }

    const EVIDENCE_URL_EXPIRY_SECONDS = 900;
    const signedEvidences = await Promise.all(
      (dispute.evidences ?? []).map(async (evidence) => {
        const signedUrls = await Promise.all(
          // SEC-046/UPLOAD-001: return null on URL generation failure — same fix as
          // listEvidence; raw S3 keys must not leak to clients.
          (evidence.fileUrls as string[]).map((key) =>
            this.uploadService.generateDownloadUrl(key, EVIDENCE_URL_EXPIRY_SECONDS).catch(() => null),
          ),
        );
        return { ...evidence, ...dropFailedUrls(signedUrls, evidence.fileTypes as string[]) };
      }),
    );

    const { orderId: _orderId, buyerId: _buyerId, sellerId: _sellerId, ...disputeFields } = dispute as Record<string, unknown>;
    return {
      ...disputeFields,
      evidences: signedEvidences,
      order: {
        orderId: dispute.order.orderId,
        title: dispute.order.title,
        orderValue: toIdr(dispute.order.orderValue),
        buyerId: dispute.order.buyer.userId,
        sellerId: dispute.order.seller.userId,
        status: dispute.order.status,
      },
    };
  }

  async submitEvidence(
    disputeId: string,
    userId: string,
    dto: SubmitEvidenceDto,
  ): Promise<{
    evidence: DisputeEvidence | null;
    fileResults: { fileKey: string; fileType: string; status: 'ok' | 'error'; error?: string }[];
    summary: { total: number; succeeded: number; failed: number };
  }> {
    const dispute = await this.prisma.dispute.findFirst({
      where: { OR: [{ id: disputeId }, { disputeId }] },
      include: {
        order: { select: { buyerId: true, sellerId: true, status: true } },
      },
    });

    if (!dispute) {
      throw new NotFoundException({ code: ErrorCodes.DISPUTE_NOT_FOUND, message: 'Dispute not found' });
    }

    if (dispute.order.status !== OrderStatus.DISPUTED) {
      throw new BadRequestException({ code: 'ORDER_NOT_IN_DISPUTE', message: 'Evidence can only be submitted while the order is in disputed status' });
    }

    const isBuyer = dispute.order.buyerId === userId;
    const isSeller = dispute.order.sellerId === userId;

    if (!isBuyer && !isSeller) {
      throw new ForbiddenException({ code: ErrorCodes.NOT_DISPUTE_PARTICIPANT, message: 'You are not a participant in this dispute' });
    }

    const openForEvidence: string[] = [DisputeStatus.OPEN, DisputeStatus.WAITING_RESPONSE, DisputeStatus.ASSIGNED, DisputeStatus.UNDER_REVIEW];
    if (!openForEvidence.includes(dispute.status)) {
      throw new BadRequestException({ code: 'DISPUTE_CLOSED_FOR_EVIDENCE', message: 'Evidence can only be submitted when the dispute is OPEN, WAITING_RESPONSE, ASSIGNED, or UNDER_REVIEW' });
    }

    const normalizedDescription = dto.description.trim();
    if (!normalizedDescription || normalizedDescription.length > 2000) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Evidence description must contain 1–2000 non-whitespace characters' });
    }

    if (dto.fileUrls.length < 1 || dto.fileUrls.length > 10 || dto.fileUrls.length !== dto.fileTypes.length) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'fileUrls and fileTypes must have the same length' });
    }

    const invalidTypes = dto.fileTypes.filter((t) => !DISPUTE_EVIDENCE_ALLOWED_TYPES.includes(t));
    if (invalidTypes.length > 0) {
      throw new BadRequestException({
        code: 'INVALID_FILE_TYPE',
        message: `Unsupported file type(s) for dispute evidence: ${invalidTypes.join(', ')}. Allowed: ${DISPUTE_EVIDENCE_ALLOWED_TYPES.join(', ')}`,
      });
    }

    const MAX_PER_FILE_SIZE_BYTES = 10 * 1024 * 1024;
    const MAX_TOTAL_EVIDENCE_SIZE_BYTES = 50 * 1024 * 1024;

    const fileResults = await this.uploadService.verifyEvidenceFileKeysBatch(
      userId,
      dto.fileUrls,
      dto.fileTypes,
    );

    const validFileUrls = fileResults.filter((r) => r.status === 'ok').map((r) => r.fileKey);
    const validFileTypes = fileResults.filter((r) => r.status === 'ok').map((r) => r.fileType);

    if (validFileUrls.length === 0) {
      return {
        evidence: null,
        fileResults,
        summary: {
          total: dto.fileUrls.length,
          succeeded: 0,
          failed: dto.fileUrls.length,
        },
      };
    }

    const fileSizeResults = await Promise.all(
      validFileUrls.map(async (key) => {
        try {
          return { key, size: await this.uploadService.getFileSize(key), error: null };
        } catch (err) {
          return { key, size: -1, error: err instanceof Error ? err.message : String(err) };
        }
      }),
    );

    for (const result of fileSizeResults) {
      if (result.size < 0) {
        await this.cleanupEvidenceUploads(userId, validFileUrls);
        throw new BadRequestException({
          code: 'FILE_SIZE_VERIFICATION_FAILED',
          message: `Could not verify size of file "${result.key}". Upload may be incomplete or file is inaccessible.`,
        });
      }
      if (result.size > MAX_PER_FILE_SIZE_BYTES) {
        await this.cleanupEvidenceUploads(userId, validFileUrls);
        throw new BadRequestException({
          code: 'FILE_TOO_LARGE',
          message: `File "${result.key}" exceeds the per-file size limit of ${MAX_PER_FILE_SIZE_BYTES / (1024 * 1024)} MB`,
        });
      }
    }

    const fileSizes = fileSizeResults.map((r) => r.size);

    const submittedByRole = isBuyer ? 'BUYER' : 'SELLER';
    const MAX_EVIDENCE_PER_USER = 10;

    let evidence: DisputeEvidence;
    try {
      evidence = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM disputes WHERE id = ${dispute.id} FOR UPDATE`;

        // [Phase 11 hardening — TOCTOU] Re-validate dispute & order status
        // INSIDE the locked transaction. The pre-transaction check at lines
        // 197/209 reads from a snapshot; if the dispute closes (admin
        // resolves, mutual agreement, or order auto-completes) between that
        // read and the FOR UPDATE lock, evidence would still be inserted
        // into a closed dispute and bypass workflow-state guarantees.
        const fresh = await tx.dispute.findUnique({
          where: { id: dispute.id },
          select: { status: true, order: { select: { status: true } } },
        });
        if (!fresh) {
          throw new NotFoundException({ code: ErrorCodes.DISPUTE_NOT_FOUND, message: 'Dispute disappeared during evidence submission' });
        }
        if (fresh.order.status !== OrderStatus.DISPUTED) {
          throw new BadRequestException({ code: 'ORDER_NOT_IN_DISPUTE', message: 'Order is no longer in disputed status' });
        }
        if (!openForEvidence.includes(fresh.status)) {
          throw new BadRequestException({ code: 'DISPUTE_CLOSED_FOR_EVIDENCE', message: 'Dispute closed for evidence submission while request was processing' });
        }

        const existingCount = await tx.disputeEvidence.count({
          where: { disputeId: dispute.id, submittedByUserId: userId },
        });
        if (existingCount >= MAX_EVIDENCE_PER_USER) {
          throw new BadRequestException({
            code: 'MAX_EVIDENCE_REACHED',
            message: `Maximum ${MAX_EVIDENCE_PER_USER} evidence items per party per dispute`,
          });
        }

        const existingEvidence = await tx.disputeEvidence.findMany({
          where: { disputeId: dispute.id },
          select: { fileUrls: true },
          take: 200,
        });
        const existingFileKeys = existingEvidence.flatMap((e) => e.fileUrls as string[]);
        const existingSizeResults = await Promise.all(
          existingFileKeys.map(async (key) => {
            try {
              return await this.uploadService.getFileSize(key);
            } catch {
              return -1;
            }
          }),
        );
        const failedExistingCheck = existingSizeResults.some((s) => s < 0);
        if (failedExistingCheck) {
          throw new BadRequestException({
            code: 'FILE_SIZE_VERIFICATION_FAILED',
            message: 'Could not verify size of existing evidence files. Please retry.',
          });
        }
        const existingTotalSize = existingSizeResults.reduce((sum, s) => sum + s, 0);

        const newTotalSize = fileSizes.reduce((sum, s) => sum + s, 0);
        if (existingTotalSize + newTotalSize > MAX_TOTAL_EVIDENCE_SIZE_BYTES) {
          throw new BadRequestException({
            code: 'EVIDENCE_SIZE_LIMIT_EXCEEDED',
            message: `Total evidence size would exceed the per-dispute limit of ${MAX_TOTAL_EVIDENCE_SIZE_BYTES / (1024 * 1024)} MB`,
          });
        }

        return tx.disputeEvidence.create({
          data: {
            disputeId: dispute.id,
            submittedByRole: submittedByRole as ActorType,
            submittedByUserId: userId,
            description: normalizedDescription,
            fileUrls: validFileUrls,
            fileTypes: validFileTypes,
          },
        });
      });
    } catch (err) {
      if (validFileUrls.length > 0) {
        this.logger.warn(
          `Evidence DB transaction failed for dispute ${dispute.id}. ` +
          `Orphaned S3 keys may exist: ${validFileUrls.join(', ')}. ` +
          `Schedule cleanup if these are not referenced elsewhere.`,
        );
        this.uploadService.cleanupFileKeys(userId, validFileUrls).catch((delErr) =>
          this.logger.warn(`Failed to clean up orphaned S3 keys: ${delErr?.message}`),
        );
      }
      throw err;
    }

    return {
      evidence,
      fileResults,
      summary: {
        total: dto.fileUrls.length,
        succeeded: validFileUrls.length,
        failed: dto.fileUrls.length - validFileUrls.length,
      },
    };
  }

  async deleteEvidence(disputeId: string, evidenceId: string, userId: string): Promise<{ deleted: boolean }> {
    const dispute = await this.prisma.dispute.findFirst({
      where: { OR: [{ id: disputeId }, { disputeId }] },
      include: {
        order: { select: { buyerId: true, sellerId: true, status: true } },
      },
    });

    if (!dispute) {
      throw new NotFoundException({ code: ErrorCodes.DISPUTE_NOT_FOUND, message: 'Dispute not found' });
    }

    const isBuyer = dispute.order.buyerId === userId;
    const isSeller = dispute.order.sellerId === userId;

    if (!isBuyer && !isSeller) {
      throw new ForbiddenException({ code: ErrorCodes.NOT_DISPUTE_PARTICIPANT, message: 'You are not a participant in this dispute' });
    }

    const openForDelete: string[] = [DisputeStatus.OPEN, DisputeStatus.WAITING_RESPONSE, DisputeStatus.ASSIGNED];
    if (!openForDelete.includes(dispute.status)) {
      throw new BadRequestException({ code: 'DISPUTE_CLOSED_FOR_EVIDENCE', message: 'Evidence can only be deleted when the dispute is open' });
    }

    const evidence = await this.prisma.disputeEvidence.findUnique({ where: { id: evidenceId } });
    if (!evidence || evidence.disputeId !== dispute.id) {
      throw new NotFoundException({ code: 'EVIDENCE_NOT_FOUND', message: 'Evidence not found' });
    }

    if (evidence.submittedByUserId !== userId) {
      throw new ForbiddenException({ code: 'NOT_EVIDENCE_OWNER', message: 'You can only delete your own evidence' });
    }

    /*
     * C-06: re-validate the dispute state INSIDE a locked transaction, exactly as
     * `submitEvidence` (:290) already does. The checks above read an unlocked snapshot taken
     * several round trips earlier, and the write was a blind `delete({ where: { id } })`, so the
     * `openForDelete` guard was unenforceable: an admin moving the dispute to UNDER_REVIEW
     * (`admin-disputes.service.ts:570`) or a mutual resolution stamping RESOLVED (`:251`) could
     * commit inside the window and the delete would still land. Deleting evidence is not a
     * recoverable mistake — the S3 objects are purged below — so a party could destroy evidence
     * out from under the admin who is deciding the dispute on it (`admin-disputes.service.ts:65`
     * loads exactly these rows). The guarded `deleteMany` also turns a concurrent double-delete
     * into a clean 404 instead of an unhandled P2025 surfacing as a 500.
     */
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM disputes WHERE id = ${dispute.id} FOR UPDATE`;

      const fresh = await tx.dispute.findUnique({
        where: { id: dispute.id },
        select: { status: true },
      });
      if (!fresh) {
        throw new NotFoundException({ code: ErrorCodes.DISPUTE_NOT_FOUND, message: 'Dispute not found' });
      }
      if (!openForDelete.includes(fresh.status)) {
        throw new BadRequestException({
          code: 'DISPUTE_CLOSED_FOR_EVIDENCE',
          message: 'Evidence can only be deleted when the dispute is open',
        });
      }

      const deleted = await tx.disputeEvidence.deleteMany({
        where: { id: evidenceId, disputeId: dispute.id, submittedByUserId: userId },
      });
      if (deleted.count === 0) {
        throw new NotFoundException({ code: 'EVIDENCE_NOT_FOUND', message: 'Evidence not found' });
      }
    });

    // SEC-031: audit log for evidence deletion. Schema has no DISPUTE_EVIDENCE_DELETED;
    // DISPUTE_EVIDENCE_ADDED is the closest available action — description clarifies deletion.
    this.auditLog.logUserAction({
      userId,
      action: UserAuditAction.DISPUTE_EVIDENCE_ADDED,
      entityType: 'DisputeEvidence',
      entityId: evidenceId,
      description: `User deleted evidence ${evidenceId} from dispute ${dispute.disputeId}`,
    });

    const fileKeys = evidence.fileUrls as string[];
    if (fileKeys.length > 0) {
      this.uploadService.cleanupFileKeys(userId, fileKeys).catch((err) =>
        this.logger.warn(`Failed to clean up S3 keys after evidence deletion: ${err?.message}`),
      );
    }

    return { deleted: true };
  }

  async submitClaim(disputeId: string, userId: string, dto: SubmitClaimDto): Promise<Record<string, unknown>> {
    const normalizedClaim = dto.claim.trim();
    if (normalizedClaim.length < 20 || normalizedClaim.length > 5000) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Claim must contain 20–5000 non-whitespace characters' });
    }
    return this.withSerializableRetry(() => this.prisma.$transaction(async (tx) => {
      const dispute = await tx.dispute.findFirst({
        where: { OR: [{ id: disputeId }, { disputeId }] },
        include: {
          order: { select: { id: true, buyerId: true, sellerId: true, status: true } },
        },
      });

      if (!dispute) {
        throw new NotFoundException({ code: ErrorCodes.DISPUTE_NOT_FOUND, message: 'Dispute not found' });
      }

      await tx.$queryRaw`SELECT id FROM disputes WHERE id = ${dispute.id} FOR UPDATE`;
      const freshDispute = await tx.dispute.findUnique({
        where: { id: dispute.id },
        include: { order: { select: { buyerId: true, sellerId: true, status: true } } },
      });
      if (!freshDispute) {
        throw new NotFoundException({ code: ErrorCodes.DISPUTE_NOT_FOUND, message: 'Dispute not found' });
      }

      if (freshDispute.order.status !== OrderStatus.DISPUTED) {
        throw new BadRequestException({ code: 'ORDER_NOT_IN_DISPUTE', message: 'Claims can only be submitted while the order is in disputed status' });
      }

      const isBuyer = freshDispute.order.buyerId === userId;
      const isSeller = freshDispute.order.sellerId === userId;

      if (!isBuyer && !isSeller) {
        throw new ForbiddenException({ code: ErrorCodes.NOT_DISPUTE_PARTICIPANT, message: 'You are not a participant in this dispute' });
      }

      const openForClaim: DisputeStatus[] = [DisputeStatus.OPEN, DisputeStatus.WAITING_RESPONSE];
      if (!openForClaim.includes(freshDispute.status)) {
        throw new BadRequestException({ code: 'DISPUTE_CLOSED_FOR_CLAIM', message: 'Claims can only be submitted when the dispute is OPEN or WAITING_RESPONSE' });
      }

      if (freshDispute.slaDeadlineAt && Date.now() >= freshDispute.slaDeadlineAt.getTime()) {
        throw new BadRequestException({ code: 'CLAIM_DEADLINE_PASSED', message: 'The claim submission deadline for this dispute has passed' });
      }

      const claimWhere = isBuyer
        ? { id: freshDispute.id, status: { in: openForClaim }, buyerClaimedAt: null, order: { status: OrderStatus.DISPUTED }, OR: [{ slaDeadlineAt: null }, { slaDeadlineAt: { gt: new Date() } }] }
        : { id: freshDispute.id, status: { in: openForClaim }, sellerClaimedAt: null, order: { status: OrderStatus.DISPUTED }, OR: [{ slaDeadlineAt: null }, { slaDeadlineAt: { gt: new Date() } }] };

      const claimData: Prisma.DisputeUpdateInput = isBuyer
        ? { buyerClaim: normalizedClaim, buyerClaimedAt: new Date() }
        : { sellerClaim: normalizedClaim, sellerClaimedAt: new Date() };

      const result = await tx.dispute.updateMany({
        where: claimWhere,
        data: claimData,
      });

      if (result.count === 0) {
        throw new BadRequestException({ code: 'CLAIM_ALREADY_SUBMITTED', message: 'A claim has already been submitted for your side of this dispute' });
      }

      const updated = await tx.dispute.findUnique({
        where: { id: freshDispute.id },
        select: {
          disputeId: true,
          buyerClaim: true,
          sellerClaim: true,
          buyerClaimedAt: true,
          sellerClaimedAt: true,
          status: true,
        },
      });

      return updated!;
    }), 'SUBMIT_CLAIM_TX');
  }

  async submitDispute(orderId: string, userId: string, dto: { claim: string; fileUrls?: string[]; fileTypes?: string[] }): Promise<{ disputeId: string; status: string }> {
    const normalizedClaim = dto.claim.trim();
    if (normalizedClaim.length < 20) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Claim must contain at least 20 non-whitespace characters' });
    }
    let validatedFileUrls: string[] | undefined;
    let validatedFileTypes: string[] | undefined;
    this.logger.log(`Dispute submission started: orderId=${orderId}, userId=${userId}`);
    const order = await this.prisma.order.findUnique({ where: { orderId } });
    if (!order) throw new NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
    if (order.buyerId !== userId && order.sellerId !== userId) throw new ForbiddenException({ code: ErrorCodes.NOT_ORDER_PARTICIPANT, message: 'Not authorized' });
    const isPostCompletionDispute = order.status === OrderStatus.COMPLETED
      && order.completedAt
      && (Date.now() - order.completedAt.getTime()) < POST_COMPLETION_DISPUTE_WINDOW_HOURS * 60 * 60 * 1000;
    if (order.status !== OrderStatus.IN_DELIVERY && order.status !== OrderStatus.PROCESSING && !isPostCompletionDispute) {
      throw new BadRequestException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Cannot submit dispute at this stage' });
    }

    const existingDispute = await this.prisma.dispute.findUnique({ where: { orderId: order.id } });
    if (existingDispute) {
      throw new BadRequestException({ code: ErrorCodes.DISPUTE_ALREADY_EXISTS, message: 'A dispute already exists for this order' });
    }

    if (dto.fileUrls && dto.fileUrls.length > 0) {
      const MAX_EVIDENCE_FILES = 10;
      if (dto.fileUrls.length > MAX_EVIDENCE_FILES) {
        throw new BadRequestException({ code: 'VALIDATION_ERROR', message: `Maximum ${MAX_EVIDENCE_FILES} evidence files allowed` });
      }
      if (!dto.fileTypes || dto.fileTypes.length !== dto.fileUrls.length) {
        throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'fileUrls and fileTypes are both required and must have the same length' });
      }
      const fileResults = await this.uploadService.verifyEvidenceFileKeysBatch(userId, dto.fileUrls, dto.fileTypes);
      const failedFiles = fileResults.filter((result) => result.status !== 'ok');
      if (failedFiles.length > 0) {
        await this.cleanupEvidenceUploads(userId, dto.fileUrls);
        throw new BadRequestException({
          code: ErrorCodes.UPLOAD_NOT_CONFIRMED,
          message: 'Every opening-dispute evidence file must be a confirmed, accessible upload with a matching MIME type',
        });
      }
      validatedFileUrls = fileResults.map((result) => result.fileKey);
      validatedFileTypes = fileResults.map((result) => result.fileType);
    }

    const serial = await this.serialService.getNextForPrefix('dispute_serial');
    const disputeId = generateDisputeId(serial);
    let freezeSerial: number | null = null;
    const nextFreezeSerial = async (): Promise<number> => {
      if (freezeSerial === null) freezeSerial = await this.serialService.getNext();
      return freezeSerial;
    };

    /*
     * C-18: this transaction runs at `Serializable` but had no retry, unlike the two other
     * Serializable writers that contend for the same rows — `mutual-resolution.service.ts:498`
     * and `order-state.service.ts:570` both wrap theirs in exactly this loop. A 40001/40P01 is
     * the *expected* outcome of Serializable contention, not a fault: filing a dispute locks the
     * order `FOR UPDATE` (`:684`) and, on the post-completion path, the seller's wallet (`:722`),
     * so it collides with `auto-complete-orders.service.ts` and with the counterparty filing at
     * the same moment. Without the loop that landed as an opaque 500 on the party filing the
     * dispute, and the caller's natural retry burned a second `dispute_serial` (the serial is
     * drawn at `:611`, outside the loop, so retrying in-place reuses the same disputeId and
     * leaves no gap in the sequence).
     */
    const MAX_RETRIES = 3;
    let dispute: Awaited<ReturnType<typeof this.prisma.dispute.create>> | undefined;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        dispute = await this.runSubmitDisputeTx(order, userId, { claim: normalizedClaim, fileUrls: validatedFileUrls, fileTypes: validatedFileTypes }, disputeId, nextFreezeSerial);
        lastError = null;
        break;
      } catch (err: unknown) {
        lastError = err;
        if (!this.isRetryableDbError(err) || attempt === MAX_RETRIES) {
          this.logger.error(`DISPUTE_SUBMIT_TX_FAILED orderId=${orderId} attempt=${attempt}/${MAX_RETRIES}`, err instanceof Error ? err.stack : String(err));
          break;
        }
        this.logger.warn(`DISPUTE_SUBMIT_TX_RETRY orderId=${orderId} attempt=${attempt}/${MAX_RETRIES}`);
        const jitter = randomInt(0, 50);
        await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, attempt - 1) + jitter));
      }
    }

    if (lastError) {
      await this.cleanupEvidenceUploads(userId, validatedFileUrls ?? []);
      // Surface NestJS HTTP exceptions (BadRequestException etc.) thrown inside the tx directly.
      if (lastError instanceof BadRequestException || lastError instanceof ForbiddenException || lastError instanceof NotFoundException) {
        throw lastError;
      }
      // Catch DB unique-constraint violation (P2002) in case two concurrent transactions
      // both passed the inner check and the DB constraint fires.
      const prismaErr = lastError as { code?: string };
      if (prismaErr?.code === 'P2002') {
        throw new BadRequestException({
          code: ErrorCodes.DISPUTE_ALREADY_EXISTS,
          message: 'A dispute already exists for this order',
        });
      }
      throw lastError;
    }

    const createdDispute = dispute!;
    const counterpartId = userId === order.buyerId ? order.sellerId : order.buyerId;

    /*
     * C-19: this notification is a post-commit side effect — the dispute row and the order's
     * DISPUTED status are already durable by the time it runs. It used to be a bare `await`
     * inside the same try/catch as the transaction, so a transient failure writing the
     * notification rethrew and the caller saw a 500 for a dispute that had in fact been filed.
     * The client's retry then hit DISPUTE_ALREADY_EXISTS, leaving the user with two contradictory
     * errors and no way to reach their own dispute. Demoted to the codebase's `silent-catch`
     * idiom (46 other call sites, e.g. `rating-reply.service.ts:58`): the notification is
     * best-effort, the dispute is not.
     */
    this.prisma.notification
      .create({
        data: {
          notifId: generateNotifId(), userId: counterpartId,
          type: NotificationType.DISPUTE_SUBMITTED, category: getCategoryForType(NotificationType.DISPUTE_SUBMITTED),
          title: 'Dispute Filed', body: `A dispute has been filed for order ${order.orderId}. Please review the dispute details.`, isRead: false,
        },
      })
      .catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
    this.runRealtimeBestEffort(() => this.prisma.emitNotificationCreated({ userId: counterpartId, title: 'Dispute Filed', body: `Dispute filed for order ${order.orderId}`, data: { type: 'DISPUTE_SUBMITTED', disputeId: createdDispute.id } }), `SUBMIT_DISPUTE_NOTIFICATION orderId=${order.orderId}`);

    this.logger.log(`Dispute created: disputeId=${createdDispute.disputeId}, orderId=${orderId}, initiator=${userId}`);
    return { disputeId: createdDispute.disputeId, status: 'OPEN' };
  }

  private async runSubmitDisputeTx(
    order: { id: string; orderId: string; buyerId: string; sellerId: string; status: OrderStatus },
    userId: string,
    dto: { claim: string; fileUrls?: string[]; fileTypes?: string[] },
    disputeId: string,
    nextFreezeSerial: () => Promise<number>,
  ) {
    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // Re-check for existing dispute inside the transaction to close the TOCTOU window.
      // Two concurrent submissions could both pass the pre-transaction check; the unique
      // constraint on orderId will also catch duplicates, but this gives a clear 409 first.
      const existingDispute = await tx.dispute.findUnique({ where: { orderId: order.id } });
      if (existingDispute) {
        throw new BadRequestException({
          code: ErrorCodes.DISPUTE_ALREADY_EXISTS,
          message: 'A dispute already exists for this order',
        });
      }

      const freshOrder = await tx.order.findUnique({ where: { id: order.id } });
      if (!freshOrder) {
        throw new BadRequestException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Cannot submit dispute at this stage' });
      }
      const freshIsPostCompletion = freshOrder.status === OrderStatus.COMPLETED
        && freshOrder.completedAt
        && (Date.now() - freshOrder.completedAt.getTime()) < POST_COMPLETION_DISPUTE_WINDOW_HOURS * 60 * 60 * 1000;
      if (freshOrder.status !== OrderStatus.IN_DELIVERY && freshOrder.status !== OrderStatus.PROCESSING && !freshIsPostCompletion) {
        throw new BadRequestException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Cannot submit dispute at this stage' });
      }

      const initiatedBy = userId === order.buyerId ? DisputeInitiator.BUYER : DisputeInitiator.SELLER;
      const isBuyerInitiator = userId === order.buyerId;
      const now = new Date();
      const slaDeadlineAt = new Date(now.getTime() + DISPUTE_SLA_HOURS * 60 * 60 * 1000);

      const newDispute = await tx.dispute.create({
        data: {
          disputeId,
          orderId: order.id,
          initiatorUserId: userId,
          initiatedBy,
          buyerClaim: isBuyerInitiator ? dto.claim.trim() : undefined,
          sellerClaim: !isBuyerInitiator ? dto.claim.trim() : undefined,
          buyerClaimedAt: isBuyerInitiator ? now : undefined,
          sellerClaimedAt: !isBuyerInitiator ? now : undefined,
          status: DisputeStatus.OPEN,
          slaHours: DISPUTE_SLA_HOURS,
          slaDeadlineAt,
        },
      });

      if (dto.fileUrls && dto.fileUrls.length > 0) {
        if (!dto.fileTypes || dto.fileTypes.length !== dto.fileUrls.length) {
          throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Validated evidence MIME types are required' });
        }
        const submittedByRole = userId === order.buyerId ? ActorType.BUYER : ActorType.SELLER;
        await tx.disputeEvidence.create({
          data: {
            disputeId: newDispute.id,
            submittedByRole,
            submittedByUserId: userId,
            fileUrls: dto.fileUrls,
            fileTypes: dto.fileTypes,
            description: dto.claim.trim(),
          },
        });
      }

      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${order.id} FOR UPDATE`;

      const allowedFromStatuses = freshIsPostCompletion
        ? [OrderStatus.COMPLETED]
        : [OrderStatus.IN_DELIVERY, OrderStatus.PROCESSING];
      const orderUpdated = await tx.order.updateMany({
        where: {
          id: order.id,
          status: { in: allowedFromStatuses },
        },
          data: { status: OrderStatus.DISPUTED, disputedAt: now },
      });

      if (orderUpdated.count === 0) {
        throw new BadRequestException({
          code: ErrorCodes.INVALID_ORDER_STATUS,
          message: 'Cannot submit dispute at this stage',
        });
      }

      await tx.orderStatusHistory.create({
        data: {
          orderId: order.id,
          fromStatus: freshOrder.status,
          toStatus: OrderStatus.DISPUTED,
          changedBy: userId,
          changedByType: userId === order.buyerId ? ActorType.BUYER : ActorType.SELLER,
          reason: `Dispute submitted: ${dto.claim.slice(0, 200)}`,
        },
      });

      if (!freshIsPostCompletion) {
        const activeEscrowLock = await tx.walletTransaction.findFirst({
          where: { orderId: freshOrder.id, type: WalletTransactionType.ORDER_LOCK, status: WalletTransactionStatus.SUCCESS },
          select: { id: true, amount: true },
        });
        if (!activeEscrowLock || activeEscrowLock.amount !== freshOrder.buyerPayAmount) {
          throw new ConflictException({
            code: 'ESCROW_LOCK_MISSING',
            message: 'This order has no matching escrow lock. The dispute was not opened; manual reconciliation is required.',
          });
        }
      }

      if (freshIsPostCompletion) {
        const freezeAmount = freshOrder.sellerReceiveAmount;
        const sellerWalletLookup = await tx.wallet.findUnique({
          where: { userId: freshOrder.sellerId },
          select: { id: true },
        });
        if (!sellerWalletLookup) {
          throw new ConflictException({ code: 'POST_COMPLETION_FREEZE_FAILED', message: 'Seller wallet is unavailable; dispute was not opened and funds remain in the completed state.' });
        }
        await tx.$queryRaw`SELECT id FROM wallets WHERE id = ${sellerWalletLookup.id} FOR UPDATE`;
        const sellerWallet = await tx.wallet.findUnique({ where: { id: sellerWalletLookup.id } });
        if (!sellerWallet || sellerWallet.isLocked || sellerWallet.availableBalance < freezeAmount) {
          throw new ConflictException({ code: 'POST_COMPLETION_FREEZE_FAILED', message: 'Seller funds cannot be secured for this post-completion dispute. Please contact support.' });
        }
        const freezeUpdated = await tx.wallet.updateMany({
          where: { id: sellerWallet.id, version: sellerWallet.version, availableBalance: { gte: freezeAmount }, isLocked: false },
          data: {
            availableBalance: { decrement: freezeAmount },
            escrowBalance: { increment: freezeAmount },
            version: { increment: 1 },
          },
        });
        if (freezeUpdated.count === 0) {
          throw new ConflictException({ code: 'POST_COMPLETION_FREEZE_FAILED', message: 'Seller funds changed concurrently; dispute was not opened. Please retry.' });
        }
        const freezeTxSerial = await nextFreezeSerial();
        const freezeTxId = generateWalletTxId(freezeTxSerial);
        await tx.walletTransaction.create({
          data: {
            txId: freezeTxId,
            walletId: sellerWallet.id,
            type: WalletTransactionType.ORDER_LOCK,
            status: WalletTransactionStatus.SUCCESS,
            amount: freezeAmount,
            balanceBefore: sellerWallet.availableBalance,
            balanceAfter: sellerWallet.availableBalance - freezeAmount,
            orderId: freshOrder.id,
            description: `Post-completion dispute freeze for order ${freshOrder.orderId}`,
          },
        });
        this.logger.log(`POST_COMPLETION_FREEZE seller=${freshOrder.sellerId} order=${freshOrder.orderId} amount=${freezeAmount}`);
      }

      await tx.user.update({
        where: { id: userId },
        data: { totalOrdersDisputed: { increment: 1 } },
      });

      return newDispute;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
}
