import { Injectable, NotFoundException, ForbiddenException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { UploadService } from '../upload/upload.service';
import { NotificationType } from '@prisma/client';
import { randomUUID } from 'crypto';
import { getCategoryForType } from '../notifications/notification-category.map';
import * as ErrorCodes from '../../common/constants/error-codes';

@Injectable()
export class DisputeMessageService {
  private readonly logger = new Logger(DisputeMessageService.name);

  constructor(
    private prisma: PrismaService,
    private realtime: RealtimeService,
    private uploadService: UploadService,
  ) {}

  private async validateDisputeAccess(disputeId: string, userId: string) {
    const dispute = await this.prisma.dispute.findFirst({
      where: {
        OR: [{ disputeId }, { id: disputeId }],
      },
      include: {
        order: { select: { buyerId: true, sellerId: true, orderId: true } },
      },
    });

    if (!dispute) {
      throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Dispute not found' });
    }

    const isParticipant =
      dispute.order.buyerId === userId || dispute.order.sellerId === userId;

    if (!isParticipant) {
      throw new ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'Not a participant of this dispute' });
    }

    return dispute;
  }

  async getMessages(disputeId: string, userId: string, page: number, limit: number): Promise<object> {
    const dispute = await this.validateDisputeAccess(disputeId, userId);

    const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
    // Clamp service inputs as well as the controller DTO so direct callers cannot request an empty
    // page or create invalid pagination metadata.
    const safeLimit = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.floor(limit))) : 50;
    const skip = (safePage - 1) * safeLimit;

    const [messages, total] = await Promise.all([
      this.prisma.disputeMessage.findMany({
        where: { disputeId: dispute.id },
        // C-21: page 1 must be the NEWEST window, not the oldest. With `asc` + a positive `take`,
        // the only caller (`apps/mobile/app/dispute/[id].tsx:117`, which sends no page/limit) was
        // pinned to the 20 oldest messages forever — so past 20 messages the mediation chat
        // silently froze for both parties even though POST and the socket event both succeeded.
        // Paginate newest-first, then flip the page back to ascending for display. Keeps `page` /
        // `limit` / `total` / `totalPages` intact, so no client change is needed.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], // R2-L: stable page ordering
        skip,
        take: safeLimit,
      }),
      this.prisma.disputeMessage.count({
        where: { disputeId: dispute.id },
      }),
    ]);

    // GAP-B3 (G136/G139): sertakan signed URL + waktu kedaluwarsa per lampiran
    // supaya klien bisa me-render pratinjau tanpa endpoint tambahan. URL dibuat
    // best-effort (TTL 300 dtk, sama seperti evidence) — kegagalan satu berkas
    // tidak boleh menggagalkan daftar pesan; klien memakai endpoint refresh
    // `GET :disputeId/attachments/signed-url` bila URL kedaluwarsa.
    const enriched = await Promise.all(
      messages.reverse().map(async (message) => ({
        ...message,
        attachments: await this.attachSignedUrls(message.attachments),
      })),
    );

    return {
      messages: enriched,
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit),
    };
  }

  /**
   * GAP-B3 (G136/G139): signed URL per lampiran pesan. Best-effort — lampiran
   * tanpa URL valid tetap dikembalikan (klien menampilkan metadata + status
   * "tidak tersedia", dan bisa meminta URL baru lewat endpoint refresh).
   */
  private async attachSignedUrls(
    attachments: unknown,
  ): Promise<Array<Record<string, unknown>>> {
    if (!Array.isArray(attachments)) return [];
    const ATTACHMENT_URL_TTL_SECONDS = 300;
    return Promise.all(
      attachments.map(async (raw) => {
        const attachment = (raw ?? {}) as Record<string, unknown>;
        const fileKey = typeof attachment.fileKey === 'string' ? attachment.fileKey : '';
        if (!fileKey) return attachment;
        try {
          const url = await this.uploadService.generateDownloadUrl(
            fileKey,
            ATTACHMENT_URL_TTL_SECONDS,
          );
          return {
            ...attachment,
            url,
            expiresAt: new Date(Date.now() + ATTACHMENT_URL_TTL_SECONDS * 1000).toISOString(),
          };
        } catch (error) {
          // URL tidak bisa dibuat (key asing/hilang) — metadata tetap tampil.
          this.logger.warn(
            `Dispute attachment signed URL failed for key=${fileKey}: ${error instanceof Error ? error.message : String(error)}`,
          );
          return attachment;
        }
      }),
    );
  }

  /**
   * GAP-B3 (G139/G148): URL unduh baru untuk lampiran pesan yang kedaluwarsa.
   *
   * Guard: (1) pemanggil HARUS peserta sengketa (`validateDisputeAccess`),
   * (2) fileKey HARUS terdaftar sebagai lampiran salah satu pesan sengketa ini
   * (containment jsonb — mencegah penandatanganan key arbitrer milik orang
   * lain), (3) tidak ada URL mentah yang disimpan — hanya fileKey di query.
   */
  async getAttachmentSignedUrl(
    disputeId: string,
    userId: string,
    fileKey: string,
  ): Promise<{ url: string; expiresAt: string }> {
    const dispute = await this.validateDisputeAccess(disputeId, userId);
    if (typeof fileKey !== 'string' || fileKey.length === 0 || fileKey.length > 512) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Invalid file key' });
    }
    const ATTACHMENT_URL_TTL_SECONDS = 300;
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "dispute_messages"
      WHERE "disputeId" = ${dispute.id}
        AND attachments::jsonb @> jsonb_build_array(jsonb_build_object('fileKey', ${fileKey}))
      LIMIT 1
    `;
    if (rows.length === 0) {
      throw new NotFoundException({
        code: ErrorCodes.FILE_NOT_FOUND_OR_EXPIRED,
        message: 'Attachment not found in this dispute',
      });
    }
    const url = await this.uploadService.generateDownloadUrl(fileKey, ATTACHMENT_URL_TTL_SECONDS);
    return {
      url,
      expiresAt: new Date(Date.now() + ATTACHMENT_URL_TTL_SECONDS * 1000).toISOString(),
    };
  }

  async sendMessage(disputeId: string, userId: string, message: string, attachments?: Array<{ fileKey: string; fileName: string; fileType: string; fileSize: number }>): Promise<object> {
    if ((!message || message.trim().length === 0) && (!attachments || attachments.length === 0)) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Message or attachment is required' });
    }

    const normalizedMessage = (message || '').trim();
    if (normalizedMessage.length > 5000) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Message too long (max 5000 characters)' });
    }
    const dispute = await this.validateDisputeAccess(disputeId, userId);
    if (['RESOLVED', 'CANCELLED'].includes(dispute.status)) {
      throw new BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: 'Cannot send messages to a resolved or cancelled dispute' });
    }

    if (attachments && attachments.length > 5) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Maximum 5 attachments per message' });
    }

    const attachmentKeys = (attachments ?? []).map((attachment) => attachment.fileKey);
    if (new Set(attachmentKeys).size !== attachmentKeys.length) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Duplicate attachments are not allowed' });
    }
    const attachmentResults = attachments?.length
      ? await this.uploadService.verifyEvidenceFileKeysBatch(userId, attachmentKeys, attachments.map((attachment) => attachment.fileType))
      : [];
    const verifiedAttachmentKeys = attachmentResults.filter((result) => result.status === 'ok').map((result) => result.fileKey);
    if (attachmentResults.some((result) => result.status !== 'ok')) {
      await this.cleanupConfirmedAttachments(userId, verifiedAttachmentKeys);
      throw new BadRequestException({ code: ErrorCodes.UPLOAD_NOT_CONFIRMED, message: 'Every attachment must be a confirmed dispute-evidence upload' });
    }
    let actualSizes: number[] = [];
    try {
      actualSizes = attachments?.length
        ? await Promise.all(attachmentKeys.map((key) => this.uploadService.getFileSize(key)))
        : [];
    } catch (error) {
      await this.cleanupConfirmedAttachments(userId, verifiedAttachmentKeys);
      throw error;
    }
    const invalidSizes = actualSizes.some((size) => !Number.isSafeInteger(size) || size < 0 || size > 10 * 1024 * 1024);
    if (invalidSizes) {
      await this.cleanupConfirmedAttachments(userId, verifiedAttachmentKeys);
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Each attachment must be a valid file no larger than 10 MB' });
    }
    const totalAttachmentBytes = actualSizes.reduce((total, size) => total + size, 0);
    if (!Number.isSafeInteger(totalAttachmentBytes) || totalAttachmentBytes > 20 * 1024 * 1024) {
      await this.cleanupConfirmedAttachments(userId, verifiedAttachmentKeys);
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Total attachment size must not exceed 20 MB' });
    }

    const sanitizedMessage = normalizedMessage
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/&(?!amp;|lt;|gt;|quot;|#39;)/g, '&amp;');

    let created: Awaited<ReturnType<typeof this.prisma.disputeMessage.create>>;
    try {
      created = await this.prisma.disputeMessage.create({
      data: {
        disputeId: dispute.id,
        senderId: userId,
        message: sanitizedMessage,
        attachments: (attachments ?? []).map((attachment, index) => ({
          fileKey: attachment.fileKey,
          fileName: attachment.fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || `attachment-${index + 1}`,
          fileType: attachment.fileType,
          fileSize: actualSizes[index] ?? 0,
        })),
      },
      });
    } catch (error) {
      await this.cleanupConfirmedAttachments(userId, verifiedAttachmentKeys);
      throw error;
    }

    const recipientId =
      dispute.order.buyerId === userId ? dispute.order.sellerId : dispute.order.buyerId;

    try {
      this.realtime.emitToUser(recipientId, 'dispute.new_message', {
        disputeId: dispute.disputeId,
        message: created,
      });
    } catch (error) {
      // The message and attachments are already durable; realtime delivery must not
      // turn a successful POST into a retry that could duplicate the message.
      this.logger.warn(`Dispute message realtime emit failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    // DSP-OFFLINE-01: jika lawan sedang offline, kirim notifikasi in-app + push.
    // Push dikirim lewat emitNotificationCreated (hook PushService) — baris
    // notification saja TIDAK memicu push (bug yang diperbaiki 2026-09-26:
    // sebelumnya hanya row yang dibuat tanpa emit sehingga push tidak terkirim).
    // Best-effort: kegagalan notifikasi tidak membatalkan pesan yang sudah tersimpan.
    try {
      const recipientOnline = await this.realtime.isUserOnline(recipientId);
      if (!recipientOnline) {
        const preview = sanitizedMessage.length > 120
          ? sanitizedMessage.slice(0, 120) + '…'
          : sanitizedMessage;
        const notifTitle = 'Pesan baru dalam sengketa';
        const notifBody = preview || `Anda menerima pesan baru pada sengketa ${dispute.disputeId}.`;
        await this.prisma.notification.create({
          data: {
            notifId: randomUUID(),
            userId: recipientId,
            type: NotificationType.DISPUTE_MESSAGE_RECEIVED,
            category: getCategoryForType(NotificationType.DISPUTE_MESSAGE_RECEIVED),
            title: notifTitle,
            body: notifBody,
            actionUrl: `/dispute/${dispute.disputeId}`,
            isRead: false,
          },
        });
        this.prisma.emitNotificationCreated({
          userId: recipientId,
          title: notifTitle,
          body: notifBody,
          data: {
            type: 'DISPUTE_MESSAGE_RECEIVED',
            disputeId: dispute.disputeId,
            actionUrl: `/dispute/${dispute.disputeId}`,
          },
        });
      }
    } catch (error) {
      this.logger.warn(`Dispute offline notification failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    return created;
  }

  private async cleanupConfirmedAttachments(userId: string, fileKeys: string[]): Promise<void> {
    if (fileKeys.length === 0) return;
    try {
      await this.uploadService.cleanupFileKeys(userId, fileKeys);
    } catch (error) {
      // Cleanup is best-effort; retain the original validation/database error.
      this.logger.warn(`Dispute attachment cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
