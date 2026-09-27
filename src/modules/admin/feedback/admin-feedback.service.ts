import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AdminRole,
  FeedbackAuditAction,
  FeedbackCloseReason,
  FeedbackRisk,
  FeedbackStatus,
  NotificationType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { getCategoryForType } from '../../notifications/notification-category.map';
import { generateNotifId } from '../../../common/utils/id-generator.util';
import * as ErrorCodes from '../../../common/constants/error-codes';
import {
  AdminFeedbackAssignDto,
  AdminFeedbackCloseDto,
  AdminFeedbackEscalateDto,
  AdminFeedbackQueryDto,
  AdminFeedbackReplyDto,
  AdminFeedbackSlaRuleDto,
  AdminFeedbackStatusDto,
  AdminFeedbackTagsDto,
} from './dto/admin-feedback.dto';

// G153/G171: matriks transisi status yang diizinkan.
const STATUS_TRANSITIONS: Record<FeedbackStatus, FeedbackStatus[]> = {
  [FeedbackStatus.NEW]: [FeedbackStatus.IN_REVIEW, FeedbackStatus.CLOSED],
  [FeedbackStatus.IN_REVIEW]: [
    FeedbackStatus.ACTIONED,
    FeedbackStatus.CLOSED,
    FeedbackStatus.NEW,
  ],
  [FeedbackStatus.ACTIONED]: [FeedbackStatus.CLOSED, FeedbackStatus.IN_REVIEW],
  [FeedbackStatus.CLOSED]: [FeedbackStatus.IN_REVIEW], // REOPEN
};

const REDACTED_CONTACT = '[redacted]';
const GUEST_CONTACT_RETENTION_DAYS = 90;
const MAX_LIST_MESSAGE_CHARS = 300;

// G172: masking kontak untuk role non-SUPER_ADMIN. Contoh: +6281234567890 -> +62****7890.
export function maskContact(contact: string): string {
  if (contact.length <= 7) return '****';
  return `${contact.slice(0, 3)}****${contact.slice(-4)}`;
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}_${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const sep = raw.indexOf('_');
    if (sep <= 0) throw new Error('bad cursor');
    const createdAt = new Date(raw.slice(0, sep));
    const id = raw.slice(sep + 1);
    if (Number.isNaN(createdAt.getTime()) || id.length === 0 || id.length > 100) {
      throw new Error('bad cursor');
    }
    return { createdAt, id };
  } catch {
    throw new BadRequestException({
      code: ErrorCodes.INVALID_CURSOR,
      message: 'Cursor tidak valid',
    });
  }
}

@Injectable()
export class AdminFeedbackService {
  private readonly logger = new Logger(AdminFeedbackService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  private async getOrThrow(id: string) {
    const feedback = await this.prisma.feedback.findUnique({ where: { id } });
    if (!feedback) {
      throw new NotFoundException({
        code: ErrorCodes.FEEDBACK_NOT_FOUND,
        message: 'Feedback tidak ditemukan',
      });
    }
    return feedback;
  }

  private async writeAudit(
    feedbackId: string,
    adminId: string | null,
    action: FeedbackAuditAction,
    detail?: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.feedbackAudit.create({
      data: { feedbackId, adminId, action, detail: (detail as Prisma.InputJsonValue) ?? Prisma.DbNull },
    });
  }

  // G156: daftar antrean — kolom contact TIDAK PERNAH dikembalikan di daftar.
  async listQueue(query: AdminFeedbackQueryDto): Promise<object> {
    const limit = query.limit ?? 20;
    const where: Prisma.FeedbackWhereInput = {};

    if (query.category) where.category = query.category;
    if (query.platform) where.platform = query.platform;
    if (query.rating !== undefined) where.rating = query.rating;
    if (query.status) where.status = query.status;
    if (query.account === 'guest') where.userId = null;
    if (query.account === 'user') where.userId = { not: null };
    if (query.dateFrom || query.dateTo) {
      where.createdAt = {
        ...(query.dateFrom ? { gte: new Date(query.dateFrom) } : {}),
        ...(query.dateTo ? { lte: new Date(query.dateTo) } : {}),
      };
    }
    // G156: pencarian teks aman (parameterized contains, panjang dibatasi DTO)
    // hanya di message & kategori.
    const and: Prisma.FeedbackWhereInput[] = [];
    if (query.search) {
      and.push({
        OR: [
          { message: { contains: query.search, mode: 'insensitive' } },
          { category: { contains: query.search, mode: 'insensitive' } },
        ],
      });
    }
    // G173: pagination cursor opaque (createdAt + id).
    if (query.cursor) {
      const { createdAt, id } = decodeCursor(query.cursor);
      and.push({
        OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: id } }],
      });
    }
    if (and.length > 0) where.AND = and;

    const rows = await this.prisma.feedback.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        category: true,
        message: true,
        rating: true,
        platform: true,
        userId: true,
        contactConsent: true,
        status: true,
        assigneeId: true,
        tags: true,
        impactLabel: true,
        appVersion: true,
        slaDueAt: true,
        riskFlag: true,
        closedReason: true,
        closedAt: true,
        redactedAt: true,
        createdAt: true,
      },
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    return {
      success: true,
      data: page.map((row) => ({
        ...row,
        message:
          row.message.length > MAX_LIST_MESSAGE_CHARS
            ? `${row.message.slice(0, MAX_LIST_MESSAGE_CHARS)}…`
            : row.message,
        account: row.userId ? 'user' : 'guest',
        slaBreached: row.slaDueAt ? row.slaDueAt.getTime() < Date.now() : false,
      })),
      nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
      hasMore,
    };
  }

  // G172: detail dengan masking kontak berbasis role.
  async getDetail(id: string, role: AdminRole): Promise<object> {
    const feedback = await this.prisma.feedback.findUnique({
      where: { id },
      include: {
        assignments: { orderBy: { createdAt: 'desc' }, take: 20 },
        internalNotes: { orderBy: { createdAt: 'desc' }, take: 50 },
        replies: { orderBy: { createdAt: 'desc' }, take: 50 },
        audit: { orderBy: { createdAt: 'desc' }, take: 100 },
      },
    });
    if (!feedback) {
      throw new NotFoundException({
        code: ErrorCodes.FEEDBACK_NOT_FOUND,
        message: 'Feedback tidak ditemukan',
      });
    }

    const { contact, ...rest } = feedback;
    const contactVisible = contact && contact !== REDACTED_CONTACT ? contact : null;
    return {
      success: true,
      data: {
        ...rest,
        // G172: contact full HANYA untuk SUPER_ADMIN; role lain melihat masking.
        contact:
          role === AdminRole.SUPER_ADMIN
            ? contactVisible
            : contactVisible
              ? maskContact(contactVisible)
              : null,
        contactMasked: role !== AdminRole.SUPER_ADMIN,
      },
    };
  }

  // G153/G171: transisi status tervalidasi + audit.
  async updateStatus(
    id: string,
    adminId: string,
    dto: AdminFeedbackStatusDto,
  ): Promise<object> {
    const feedback = await this.getOrThrow(id);
    const from = feedback.status;
    const to = dto.status;

    if (from === to) {
      throw new BadRequestException({
        code: ErrorCodes.FEEDBACK_INVALID_STATUS_TRANSITION,
        message: `Feedback sudah berstatus ${from}`,
      });
    }
    if (!STATUS_TRANSITIONS[from].includes(to)) {
      throw new BadRequestException({
        code: ErrorCodes.FEEDBACK_INVALID_STATUS_TRANSITION,
        message: `Transisi ${from} → ${to} tidak diizinkan`,
      });
    }
    if (to === FeedbackStatus.CLOSED && !dto.reason) {
      throw new BadRequestException({
        code: ErrorCodes.FEEDBACK_CLOSE_REASON_REQUIRED,
        message: 'Alasan penutupan (reason) wajib diisi saat menutup feedback',
      });
    }

    const now = new Date();
    const reopened = from === FeedbackStatus.CLOSED && to === FeedbackStatus.IN_REVIEW;
    const updated = await this.prisma.feedback.update({
      where: { id },
      data: {
        status: to,
        closedAt: to === FeedbackStatus.CLOSED ? now : reopened ? null : feedback.closedAt,
        closedReason:
          to === FeedbackStatus.CLOSED ? dto.reason! : reopened ? null : feedback.closedReason,
      },
    });

    const action = reopened
      ? FeedbackAuditAction.REOPENED
      : to === FeedbackStatus.CLOSED
        ? FeedbackAuditAction.CLOSED
        : FeedbackAuditAction.STATUS_CHANGED;
    await this.writeAudit(id, adminId, action, {
      from,
      to,
      ...(dto.reason ? { reason: dto.reason } : {}),
    });
    this.logger.log(
      `Feedback ${id} status ${from} → ${to} oleh admin ${adminId}${dto.reason ? ` reason=${dto.reason}` : ''}`,
    );

    // G164: notifikasi selesai bila feedback ditutup, ada akun user, dan consent.
    if (
      to === FeedbackStatus.CLOSED &&
      updated.userId &&
      updated.contactConsent
    ) {
      await this.notifyUser(
        updated.userId,
        id,
        'Feedback Anda telah ditindaklanjuti',
        `Terima kasih atas masukan Anda pada kategori "${updated.category}". Status: selesai${dto.reason ? ` (${dto.reason})` : ''}.`,
      );
    }

    return { success: true, data: { id, status: to, closedReason: updated.closedReason } };
  }

  // G154: penugasan dengan riwayat.
  async assign(id: string, adminId: string, dto: AdminFeedbackAssignDto): Promise<object> {
    await this.getOrThrow(id);
    const target = await this.prisma.adminUser.findFirst({
      where: { OR: [{ id: dto.adminId }, { adminId: dto.adminId }], isActive: true },
      select: { id: true },
    });
    if (!target) {
      throw new BadRequestException({
        code: ErrorCodes.USER_NOT_FOUND,
        message: 'Admin tujuan penugasan tidak ditemukan atau tidak aktif',
      });
    }
    const assignment = await this.prisma.feedbackAssignment.create({
      data: {
        feedbackId: id,
        adminId: target.id,
        assignedBy: adminId,
        note: dto.note?.trim() ? dto.note.trim() : null,
      },
    });
    await this.prisma.feedback.update({
      where: { id },
      data: { assigneeId: target.id },
    });
    await this.writeAudit(id, adminId, FeedbackAuditAction.ASSIGNED, {
      assigneeId: target.id,
      assignmentId: assignment.id,
      ...(dto.note ? { note: dto.note } : {}),
    });
    return { success: true, data: { id, assigneeId: target.id } };
  }

  async unassign(id: string, adminId: string): Promise<object> {
    const feedback = await this.getOrThrow(id);
    if (!feedback.assigneeId) {
      throw new BadRequestException({
        code: ErrorCodes.FEEDBACK_INVALID_STATUS_TRANSITION,
        message: 'Feedback belum ditugaskan ke siapa pun',
      });
    }
    await this.prisma.feedback.update({ where: { id }, data: { assigneeId: null } });
    await this.writeAudit(id, adminId, FeedbackAuditAction.UNASSIGNED, {
      previousAssigneeId: feedback.assigneeId,
    });
    return { success: true, data: { id, assigneeId: null } };
  }

  // G158: catatan internal — tidak pernah dikirim ke user.
  async addNote(id: string, adminId: string, note: string): Promise<object> {
    await this.getOrThrow(id);
    const created = await this.prisma.feedbackInternalNote.create({
      data: { feedbackId: id, adminId, note: note.trim() },
    });
    await this.writeAudit(id, adminId, FeedbackAuditAction.NOTE_ADDED, {
      noteId: created.id,
    });
    return { success: true, data: { id: created.id, createdAt: created.createdAt } };
  }

  // G159: tag tema + label dampak.
  async setTags(id: string, adminId: string, dto: AdminFeedbackTagsDto): Promise<object> {
    await this.getOrThrow(id);
    const tags = [...new Set(dto.tags.map((t) => t.trim()).filter(Boolean))];
    const updated = await this.prisma.feedback.update({
      where: { id },
      data: {
        tags,
        impactLabel: dto.impactLabel?.trim() ? dto.impactLabel.trim() : null,
      },
      select: { id: true, tags: true, impactLabel: true },
    });
    await this.writeAudit(id, adminId, FeedbackAuditAction.TAG_ADDED, {
      tags: updated.tags,
      impactLabel: updated.impactLabel,
    });
    return { success: true, data: updated };
  }

  // G160: deteksi kemiripan (Jaccard token overlap) — skor triase, TIDAK menolak otomatis.
  async findDuplicates(id: string): Promise<object> {
    const feedback = await this.getOrThrow(id);
    const since = new Date(feedback.createdAt.getTime() - 30 * 24 * 60 * 60 * 1000);
    const candidates = await this.prisma.feedback.findMany({
      where: {
        id: { not: id },
        category: feedback.category,
        createdAt: { gte: since, lte: feedback.createdAt },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: { id: true, message: true, status: true, createdAt: true },
    });
    const base = tokenize(feedback.message);
    const scored = candidates
      .map((c) => ({
        id: c.id,
        status: c.status,
        createdAt: c.createdAt,
        score: Math.round(jaccard(base, tokenize(c.message)) * 100) / 100,
      }))
      .filter((s) => s.score >= 0.15)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
    return {
      success: true,
      data: {
        feedbackId: id,
        windowDays: 30,
        category: feedback.category,
        candidates: scored,
        note: 'Skor kemiripan hanya untuk triase — tidak ada penolakan otomatis.',
      },
    };
  }

  // G161: hubungi pengirim — HANYA bila contactConsent=true dan contact tersedia.
  async contactSender(id: string, adminId: string, role: AdminRole): Promise<object> {
    const feedback = await this.getOrThrow(id);
    if (!feedback.contactConsent) {
      throw new BadRequestException({
        code: ErrorCodes.FEEDBACK_CONTACT_CONSENT_REQUIRED,
        message: 'Pengirim tidak memberikan persetujuan untuk dihubungi (contactConsent=false)',
      });
    }
    const contact = feedback.contact && feedback.contact !== REDACTED_CONTACT ? feedback.contact : null;
    if (!contact) {
      throw new BadRequestException({
        code: ErrorCodes.FEEDBACK_CONTACT_NOT_AVAILABLE,
        message: 'Kontak pengirim tidak tersedia (kosong atau sudah diredaksi)',
      });
    }
    await this.writeAudit(id, adminId, FeedbackAuditAction.CONTACTED, {
      maskedContact: maskContact(contact),
      note: 'Pencatatan outreach manual oleh admin — detail kontak tidak disimpan penuh di audit.',
    });
    this.logger.log(`Feedback ${id} dihubungi oleh admin ${adminId}`);
    return {
      success: true,
      data: {
        id,
        contacted: true,
        contact:
          role === AdminRole.SUPER_ADMIN ? contact : maskContact(contact),
        contactMasked: role !== AdminRole.SUPER_ADMIN,
      },
    };
  }

  // G162/G163: balasan ke akun Kahade + audit.
  async reply(id: string, adminId: string, dto: AdminFeedbackReplyDto): Promise<object> {
    const feedback = await this.getOrThrow(id);
    const created = await this.prisma.feedbackReply.create({
      data: { feedbackId: id, adminId, body: dto.body.trim() },
    });
    await this.writeAudit(id, adminId, FeedbackAuditAction.REPLY_SENT, {
      replyId: created.id,
    });
    this.logger.log(`Feedback ${id} dibalas oleh admin ${adminId}`);

    // G164: notifikasi in-app bila ada akun user dan consent.
    let notified = false;
    if (feedback.userId && feedback.contactConsent) {
      notified = await this.notifyUser(
        feedback.userId,
        id,
        'Balasan atas feedback Anda',
        dto.body.trim().slice(0, 160),
      );
    }
    return {
      success: true,
      data: { id: created.id, createdAt: created.createdAt, notified },
    };
  }

  // G169: eskalasi risiko. Untuk FRAUD_RISK: flag + audit + hook log ke jalur
  // fraud existing (tanpa membangun sistem fraud baru).
  async escalate(id: string, adminId: string, dto: AdminFeedbackEscalateDto): Promise<object> {
    const feedback = await this.getOrThrow(id);
    const updated = await this.prisma.feedback.update({
      where: { id },
      data: { riskFlag: dto.risk },
      select: { id: true, riskFlag: true, userId: true, contact: true },
    });
    await this.writeAudit(id, adminId, FeedbackAuditAction.ESCALATED, {
      risk: dto.risk,
      ...(dto.note ? { note: dto.note } : {}),
    });

    if (dto.risk === FeedbackRisk.FRAUD_RISK) {
      // Pola jelas: pengirim yang sama sudah pernah di-flag fraud sebelumnya.
      let repeatOffender = false;
      if (updated.userId) {
        const prior = await this.prisma.feedback.count({
          where: {
            id: { not: id },
            userId: updated.userId,
            riskFlag: FeedbackRisk.FRAUD_RISK,
          },
        });
        repeatOffender = prior > 0;
      }
      await this.writeAudit(id, adminId, FeedbackAuditAction.RISK_FLAGGED, {
        risk: dto.risk,
        repeatOffender,
      });
      // Hook ke jalur fraud existing: log terstruktur agar tim fraud-review
      // bisa menindaklanjuti (tidak ada sistem fraud baru yang dibangun).
      this.logger.warn(
        `FRAUD_RISK eskalasi feedback=${id} userId=${updated.userId ?? 'guest'} repeatOffender=${repeatOffender} note=${dto.note ?? '-'}`,
      );
    }

    return {
      success: true,
      data: { id: updated.id, riskFlag: updated.riskFlag, previousRisk: feedback.riskFlag },
    };
  }

  // G170: penutupan dengan reason code wajib.
  async close(id: string, adminId: string, dto: AdminFeedbackCloseDto): Promise<object> {
    return this.updateStatus(id, adminId, {
      status: FeedbackStatus.CLOSED,
      reason: dto.reason,
    });
  }

  // G166: agregat ekspor TANPA kolom kontak/isi.
  async exportAggregates(format: 'json' | 'csv'): Promise<object> {
    const [byCategory, byStatus, byRating, byPlatform] = await Promise.all([
      this.prisma.feedback.groupBy({ by: ['category'], _count: { _all: true } }),
      this.prisma.feedback.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.feedback.groupBy({ by: ['rating'], _count: { _all: true } }),
      this.prisma.feedback.groupBy({ by: ['platform'], _count: { _all: true } }),
    ]);
    const payload = {
      generatedAt: new Date().toISOString(),
      byCategory: byCategory.map((r) => ({ category: r.category, count: r._count._all })),
      byStatus: byStatus.map((r) => ({ status: r.status, count: r._count._all })),
      byRating: byRating.map((r) => ({ rating: r.rating, count: r._count._all })),
      byPlatform: byPlatform.map((r) => ({ platform: r.platform, count: r._count._all })),
    };
    if (format === 'csv') {
      const lines = ['dimension,value,count'];
      for (const r of payload.byCategory) lines.push(`category,"${r.category.replace(/"/g, '""')}",${r.count}`);
      for (const r of payload.byStatus) lines.push(`status,${r.status},${r.count}`);
      for (const r of payload.byRating) lines.push(`rating,${r.rating ?? 'null'},${r.count}`);
      for (const r of payload.byPlatform) lines.push(`platform,"${r.platform.replace(/"/g, '""')}",${r.count}`);
      return { success: true, format: 'csv', data: lines.join('\n') };
    }
    return { success: true, format: 'json', data: payload };
  }

  // G167/G174: ringkasan volume, rating rata-rata, distribusi, tren 30 hari.
  async getSummary(): Promise<object> {
    const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [total, avgRating, byStatus, byCategory, byPlatform] = await Promise.all([
      this.prisma.feedback.count(),
      this.prisma.feedback.aggregate({ _avg: { rating: true }, where: { rating: { not: null } } }),
      this.prisma.feedback.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.feedback.groupBy({ by: ['category'], _count: { _all: true } }),
      this.prisma.feedback.groupBy({ by: ['platform'], _count: { _all: true } }),
    ]);

    const daily = await this.prisma.$queryRaw<
      Array<{ day: Date; total: number; avgRating: number | null }>
    >`
      SELECT DATE_TRUNC('day', "createdAt") AS day,
             COUNT(*)::int AS total,
             AVG("rating")::float AS "avgRating"
      FROM "feedback"
      WHERE "createdAt" >= ${from}
      GROUP BY 1
      ORDER BY 1 ASC
    `;
    const dailyByPlatform = await this.prisma.$queryRaw<
      Array<{ day: Date; platform: string; total: number }>
    >`
      SELECT DATE_TRUNC('day', "createdAt") AS day, "platform", COUNT(*)::int AS total
      FROM "feedback"
      WHERE "createdAt" >= ${from}
      GROUP BY 1, 2
      ORDER BY 1 ASC, 2 ASC
    `;
    const dailyByAppVersion = await this.prisma.$queryRaw<
      Array<{ day: Date; appVersion: string; total: number }>
    >`
      SELECT DATE_TRUNC('day', "createdAt") AS day,
             COALESCE("appVersion", 'unknown') AS "appVersion",
             COUNT(*)::int AS total
      FROM "feedback"
      WHERE "createdAt" >= ${from}
      GROUP BY 1, 2
      ORDER BY 1 ASC, 2 ASC
    `;

    return {
      success: true,
      data: {
        total,
        avgRating:
          avgRating._avg.rating !== null
            ? Math.round(avgRating._avg.rating * 100) / 100
            : null,
        byStatus: byStatus.map((r) => ({ status: r.status, count: r._count._all })),
        byCategory: byCategory.map((r) => ({ category: r.category, count: r._count._all })),
        byPlatform: byPlatform.map((r) => ({ platform: r.platform, count: r._count._all })),
        trend: {
          windowDays: 30,
          daily: daily.map((d) => ({
            day: d.day.toISOString().slice(0, 10),
            total: d.total,
            avgRating: d.avgRating !== null ? Math.round(d.avgRating * 100) / 100 : null,
          })),
          byPlatform: dailyByPlatform.map((d) => ({
            day: d.day.toISOString().slice(0, 10),
            platform: d.platform,
            total: d.total,
          })),
          byAppVersion: dailyByAppVersion.map((d) => ({
            day: d.day.toISOString().slice(0, 10),
            appVersion: d.appVersion,
            total: d.total,
          })),
        },
      },
    };
  }

  // G168: SLA rules.
  async listSlaRules(): Promise<object> {
    const rules = await this.prisma.feedbackSlaRule.findMany({
      orderBy: { category: 'asc' },
    });
    return { success: true, data: rules };
  }

  async createSlaRule(adminId: string, dto: AdminFeedbackSlaRuleDto): Promise<object> {
    const rule = await this.prisma.feedbackSlaRule.upsert({
      where: { category: dto.category },
      create: {
        category: dto.category,
        hours: dto.hours,
        isCritical: dto.isCritical ?? false,
      },
      update: { hours: dto.hours, isCritical: dto.isCritical ?? false },
    });
    this.logger.log(`SLA rule kategori="${rule.category}" hours=${rule.hours} oleh admin ${adminId}`);
    await this.recomputeOpenSla(rule.category, rule.hours);
    return { success: true, data: rule };
  }

  async deleteSlaRule(adminId: string, ruleId: string): Promise<object> {
    const rule = await this.prisma.feedbackSlaRule.findUnique({ where: { id: ruleId } });
    if (!rule) {
      throw new NotFoundException({
        code: ErrorCodes.FEEDBACK_SLA_RULE_NOT_FOUND,
        message: 'Aturan SLA tidak ditemukan',
      });
    }
    await this.prisma.feedbackSlaRule.delete({ where: { id: ruleId } });
    this.logger.log(`SLA rule kategori="${rule.category}" dihapus oleh admin ${adminId}`);
    return { success: true, data: { id: ruleId } };
  }

  // Hitung ulang slaDueAt untuk feedback terbuka saat rule berubah.
  private async recomputeOpenSla(category: string, hours: number): Promise<void> {
    const open = await this.prisma.feedback.findMany({
      where: {
        category,
        status: { in: [FeedbackStatus.NEW, FeedbackStatus.IN_REVIEW] },
      },
      select: { id: true, createdAt: true },
      take: 5000,
    });
    for (const fb of open) {
      await this.prisma.feedback.update({
        where: { id: fb.id },
        data: { slaDueAt: new Date(fb.createdAt.getTime() + hours * 3_600_000) },
      });
    }
    if (open.length > 0) {
      this.logger.log(`SLA dihitung ulang untuk ${open.length} feedback terbuka kategori="${category}"`);
    }
  }

  // Dipakai feedback.service.create & saat kategori berubah: hitung slaDueAt dari rule.
  async recomputeSlaDueAt(feedbackId: string, category: string): Promise<Date | null> {
    const rule = await this.prisma.feedbackSlaRule.findUnique({ where: { category } });
    if (!rule) return null;
    const feedback = await this.prisma.feedback.findUnique({
      where: { id: feedbackId },
      select: { createdAt: true },
    });
    if (!feedback) return null;
    const slaDueAt = new Date(feedback.createdAt.getTime() + rule.hours * 3_600_000);
    await this.prisma.feedback.update({ where: { id: feedbackId }, data: { slaDueAt } });
    return slaDueAt;
  }

  // G165: redaksi kontak guest berumur > 90 hari.
  async redactExpiredGuestContacts(): Promise<{ redacted: number }> {
    const cutoff = new Date(Date.now() - GUEST_CONTACT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const result = await this.prisma.feedback.updateMany({
      where: {
        userId: null,
        createdAt: { lt: cutoff },
        contact: { not: null },
        redactedAt: null,
      },
      data: { contact: REDACTED_CONTACT, redactedAt: new Date() },
    });
    if (result.count > 0) {
      this.logger.log(`Redaksi kontak guest: ${result.count} feedback diredaksi`);
    }
    return { redacted: result.count };
  }

  // G164: notifikasi in-app — hormati preferensi via NotificationsService,
  // tulis via pola yang sama dengan modul lain (prisma.notification.create +
  // emitNotificationCreated). Kegagalan notifikasi tidak menggagalkan aksi utama.
  private async notifyUser(
    userId: string,
    feedbackId: string,
    title: string,
    body: string,
  ): Promise<boolean> {
    try {
      // Tidak ada tipe notifikasi khusus feedback di enum (schema terkunci),
      // pakai SYSTEM_ANNOUNCEMENT (kategori INFORMASI) dengan refType FEEDBACK.
      const type = NotificationType.SYSTEM_ANNOUNCEMENT;
      const enabled = await this.notifications.isInAppEnabled(userId, type);
      if (!enabled) return false;
      const created = await this.prisma.notification.create({
        data: {
          notifId: generateNotifId(),
          userId,
          type,
          category: getCategoryForType(type),
          title,
          body,
          isRead: false,
          refType: 'FEEDBACK',
          refId: feedbackId,
          actionUrl: `/feedback/${encodeURIComponent(feedbackId)}`,
        },
        select: { notifId: true },
      });
      this.prisma.emitNotificationCreated({
        userId,
        title,
        body,
        data: {
          type: 'FEEDBACK_UPDATE',
          notificationType: type,
          notificationId: created.notifId,
          feedbackId,
        },
      });
      return true;
    } catch (error) {
      this.logger.warn(
        `Notifikasi feedback ${feedbackId} ke user ${userId} gagal: ${(error as Error).message}`,
      );
      return false;
    }
  }
}
