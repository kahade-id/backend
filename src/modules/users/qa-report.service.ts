/**
 * GAP-F (G431/G436): endpoint publik-terautentikasi untuk MELAPOR konten Q&A
 * dan MENGAJUKAN KEBERATAN (appeal) atas hide moderator.
 *
 * Laporan masuk ke tabel qa_reports — antrean TERPISAH dari laporan etalase
 * (showcase_reports). Raw SQL karena tabel qa_* belum ada di prisma client
 * (lihat fixes/fragments/gap-F-B-schema.prisma).
 */
import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import * as ErrorCodes from '../../common/constants/error-codes';
import {
  QA_MODERATION_REASONS,
  QA_REPORT_TARGETS,
  QaModerationReason,
  QaReportTarget,
} from '../admin/qa-moderation/qa-moderation.types';

const REASON_SET = new Set<string>(QA_MODERATION_REASONS);
const TARGET_SET = new Set<string>(QA_REPORT_TARGETS);

function assertReasonCode(reasonCode: string): asserts reasonCode is QaModerationReason {
  if (!REASON_SET.has(reasonCode)) {
    throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Invalid reasonCode' });
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

@Injectable()
export class QaReportService {
  constructor(private prisma: PrismaService) {}

  // ==================================================================
  // G431 — lapor pertanyaan / komentar (antrean terpisah dari etalase)
  // ==================================================================
  async reportQuestion(reporterId: string, questionId: string, reasonCode: string, note?: string): Promise<object> {
    assertReasonCode(reasonCode);
    const q = await this.prisma.profileQuestion.findUnique({
      where: { id: questionId },
      select: { id: true, askerId: true },
    });
    if (!q) throw new NotFoundException({ code: ErrorCodes.QUESTION_NOT_FOUND, message: 'Question not found' });
    if (q.askerId === reporterId) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'You cannot report your own content' });
    }
    return this.insertReport(reporterId, 'QUESTION', questionId, reasonCode, note);
  }

  async reportComment(reporterId: string, commentId: string, reasonCode: string, note?: string): Promise<object> {
    assertReasonCode(reasonCode);
    const c = await this.prisma.profileQuestionComment.findUnique({
      where: { id: commentId },
      select: { id: true, authorId: true },
    });
    if (!c) throw new NotFoundException({ code: ErrorCodes.COMMENT_NOT_FOUND, message: 'Comment not found' });
    if (c.authorId === reporterId) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'You cannot report your own content' });
    }
    return this.insertReport(reporterId, 'COMMENT', commentId, reasonCode, note);
  }

  private async insertReport(
    reporterId: string,
    targetType: QaReportTarget,
    targetId: string,
    reasonCode: QaModerationReason,
    note?: string,
  ): Promise<object> {
    try {
      const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        INSERT INTO qa_reports (id, target_type, target_id, reporter_id, reason_code, note, status, created_at, updated_at)
        VALUES (gen_random_uuid()::text, ${targetType}::qa_report_target, ${targetId}, ${reporterId},
                ${reasonCode}::qa_moderation_reason, ${note?.trim() ? note.trim().slice(0, 500) : null},
                'PENDING'::qa_report_status, NOW(), NOW())
        RETURNING id
      `);
      return { reportId: rows[0].id, status: 'PENDING' };
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'You have already reported this content',
        });
      }
      throw err;
    }
  }

  // ==================================================================
  // G436 — ajukan keberatan atas hide MODERATOR (penulis atau pemilik profil)
  // ==================================================================
  async submitAppeal(appellantId: string, targetType: string, targetId: string, reason: string): Promise<object> {
    if (!TARGET_SET.has(targetType)) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Invalid targetType' });
    }
    const trimmed = reason.trim();
    if (trimmed.length < 10) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Appeal reason must be at least 10 characters' });
    }

    // Muat target + relasi kepemilikan via raw SQL (kolom hidden_by_type baru).
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; is_hidden: boolean; hidden_by_type: string | null; writer_id: string; owner_id: string }>
    >(
      targetType === 'QUESTION'
        ? Prisma.sql`SELECT pq.id, pq."isHidden" AS is_hidden, pq.hidden_by_type::text AS hidden_by_type,
                            pq."askerId" AS writer_id, pq."receiverId" AS owner_id
                     FROM profile_questions pq WHERE pq.id = ${targetId}`
        : Prisma.sql`SELECT c.id, c."isHidden" AS is_hidden, c.hidden_by_type::text AS hidden_by_type,
                            c."authorId" AS writer_id, pq."receiverId" AS owner_id
                     FROM profile_question_comments c JOIN profile_questions pq ON pq.id = c."questionId"
                     WHERE c.id = ${targetId}`,
    );
    if (rows.length === 0) {
      throw new NotFoundException({
        code: targetType === 'QUESTION' ? ErrorCodes.QUESTION_NOT_FOUND : ErrorCodes.COMMENT_NOT_FOUND,
        message: 'Target not found',
      });
    }
    const target = rows[0];

    if (!target.is_hidden || target.hidden_by_type !== 'MODERATOR') {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Appeals are only available for content hidden by platform moderators',
      });
    }
    // Penulis (asker/author) atau pemilik profil (receiver).
    if (appellantId !== target.writer_id && appellantId !== target.owner_id) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'Only the content author or the profile owner can appeal',
      });
    }

    const existing = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM qa_appeals
      WHERE target_type = ${targetType}::qa_report_target AND target_id = ${targetId}
        AND appellant_id = ${appellantId} AND status = 'PENDING'::qa_appeal_status
    `);
    if (existing.length > 0) {
      throw new ConflictException({ code: ErrorCodes.VALIDATION_ERROR, message: 'You already have a pending appeal for this content' });
    }

    const inserted = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      INSERT INTO qa_appeals (id, target_type, target_id, appellant_id, reason, status, created_at, updated_at)
      VALUES (gen_random_uuid()::text, ${targetType}::qa_report_target, ${targetId}, ${appellantId},
              ${trimmed.slice(0, 1000)}, 'PENDING'::qa_appeal_status, NOW(), NOW())
      RETURNING id
    `);
    const appealId = inserted[0].id;

    // Event audit — actor_admin_id NULL karena diajukan user, bukan admin.
    await this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO qa_moderation_events (id, target_type, target_id, actor_admin_id, action, reason_code, note, created_at)
      VALUES (gen_random_uuid()::text, ${targetType}::qa_report_target, ${targetId}, NULL,
              'APPEAL_SUBMITTED'::qa_event_action, NULL, ${`Appeal ${appealId} submitted`}, NOW())
    `);

    return { appealId, status: 'PENDING' };
  }
}
