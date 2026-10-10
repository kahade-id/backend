import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { DisputeStatus, NotificationType } from '@prisma/client';
import * as ErrorCodes from '../../common/constants/error-codes';
import { generateNotifId } from '../../common/utils/id-generator.util';
import { getCategoryForType } from '../notifications/notification-category.map';
// BAI-097: JANGAN definisikan konstanta lokal di sini — sumber kebenaran
// tunggal SLA eskalasi adalah DISPUTE_ESCALATION_SLA_HOURS di
// app.constants.ts (72 jam = 3x24 jam pasca-ESCALATED; dipakai
// disputes.service.ts & auto-escalate scheduler). Nilai lokal 24 jam yang
// dulu ada di file ini kontradiktif dan menyebabkan deadline eskalasi
// berbeda tergantung jalur eskalasinya.

import { DISPUTE_ESCALATION_SLA_HOURS } from '../../common/constants/app.constants';

/**
 * BE-COMMERCE (2026-10-01) — item 16: eskalasi dispute 1 ketuk (admin).
 * Satu endpoint: admin menandai dispute langsung ESCALATED tanpa alasan
 * panjang. Idempoten & fail-closed: dispute yang sudah RESOLVED/ESCALATED
 * ditolak; update memakai predikat status (pola SEC-DSP-02) agar tidak
 * menghidupkan kembali dispute yang sudah diputus.
 *
 * BAI-097: escalationSlaDeadlineAt dihitung dari DISPUTE_ESCALATION_SLA_HOURS
 * (app.constants.ts) — sama dengan jalur eskalasi manual user & scheduler,
 * sehingga kolom escalationSlaDeadlineAt selalu konsisten apa pun jalurnya.
 */
@Injectable()
export class DisputeQuickEscalationService {
  private readonly logger = new Logger(DisputeQuickEscalationService.name);

  constructor(private prisma: PrismaService) {}

  /** @param adminId DB id AdminUser (`sub` dari JWT) — ditulis ke FK assignedAdminId. */
  async quickEscalate(adminId: string, disputeId: string, note?: string) {
    if (!adminId) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Identitas admin tidak ditemukan pada sesi' });
    }
    const dispute = await this.prisma.dispute.findFirst({
      where: { OR: [{ id: disputeId }, { disputeId }] },
      include: { order: { select: { buyerId: true, sellerId: true } } },
    });
    if (!dispute) {
      throw new NotFoundException({ code: ErrorCodes.DISPUTE_NOT_FOUND, message: 'Dispute tidak ditemukan' });
    }
    if (dispute.status === DisputeStatus.RESOLVED || dispute.status === DisputeStatus.ESCALATED) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_STATUS,
        message: `Dispute sudah ${dispute.status}`,
      });
    }

    const escalationNow = new Date();
    const escalated = await this.prisma.dispute.updateMany({
      where: {
        id: dispute.id,
        status: { in: [DisputeStatus.OPEN, DisputeStatus.ASSIGNED, DisputeStatus.UNDER_REVIEW, DisputeStatus.WAITING_RESPONSE] },
      },
      data: {
        status: DisputeStatus.ESCALATED,
        isSlaBreached: true,
        escalatedAt: escalationNow,
        escalationSlaDeadlineAt: new Date(escalationNow.getTime() + DISPUTE_ESCALATION_SLA_HOURS * 60 * 60 * 1000),
        assignedAdminId: adminId,
      },
    });
    if (escalated.count === 0) {
      throw new BadRequestException({ code: ErrorCodes.INVALID_STATUS, message: 'Dispute tidak bisa dieskalasi' });
    }

    await this.prisma.adminAuditLog
      .create({
        data: {
          adminId,
          action: 'DISPUTE_ESCALATED' as never,
          targetType: 'Dispute',
          targetId: dispute.id,
          description: `Quick-escalate oleh admin ${adminId} untuk dispute ${dispute.disputeId}: ${(note ?? '').slice(0, 200)}`,
          ipAddress: 'system',
        },
      })
      .catch((err: unknown) => this.logger.error(`Quick-escalate audit gagal: ${(err as Error).message}`));

    // Notifikasi kedua pihak — best-effort (pola C-19).
    const title = 'Sengketa dieskalasi';
    const body = `Sengketa ${dispute.disputeId} dieskalasi admin dan diprioritaskan ke tim mediator.`;
    for (const partyId of [dispute.order.buyerId, dispute.order.sellerId]) {
      this.prisma.notification
        .create({
          data: {
            notifId: generateNotifId(),
            userId: partyId,
            type: NotificationType.DISPUTE_ESCALATED,
            category: getCategoryForType(NotificationType.DISPUTE_ESCALATED),
            title,
            body,
            isRead: false,
          },
        })
        .then(() =>
          this.prisma.emitNotificationCreated({
            userId: partyId,
            title,
            body,
            data: { type: 'DISPUTE_ESCALATED', disputeId: dispute.disputeId },
          }),
        )
        .catch((err: unknown) => this.logger.warn(`Notifikasi quick-escalate gagal: ${(err as Error).message}`));
    }

    return { disputeId: dispute.disputeId, status: DisputeStatus.ESCALATED, escalatedAt: escalationNow };
  }
}
