/**
 * GAP-F (G426–G450): Moderasi platform Q&A profil — service admin.
 *
 * JALUR MODERATOR PLATFORM, terpisah dari self-service pemilik profil
 * (ProfileQAService.hideQuestion/hideComment/unhide). Bedanya dicatat di
 * `hidden_by_type` (OWNER|MODERATOR) + `hidden_by_admin_id` (G428).
 *
 * CATATAN TEKNIS: tabel qa_* dan kolom hidden_by_type dkk belum ada di prisma
 * client (fragment schema belum digabung — lihat
 * fixes/fragments/gap-F-B-schema.prisma), sehingga seluruh akses memakai raw
 * SQL ($queryRaw/$executeRaw). Setelah `prisma migrate deploy` + `prisma
 * generate`, blok RAW-SQL di bawah bisa dimigrasi ke typed client.
 */
import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { NotificationType } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { generateNotifId } from '../../../common/utils/id-generator.util';
import { getCategoryForType } from '../../notifications/notification-category.map';
import * as ErrorCodes from '../../../common/constants/error-codes';
import { redactPii, summarizePiiMatches } from './pii-redactor.util';
import {
  QA_MODERATION_REASONS,
  QaModerationReason,
  QaReportTarget,
  QaEventAction,
  QaAppealRow,
  QaDeleteRequestRow,
  QaModerationEventRow,
  QaReportRow,
  maskUsername,
} from './qa-moderation.types';
import { QaModerationQueueQueryDto } from './dto/qa-moderation-queue-query.dto';

const REASON_SET = new Set<string>(QA_MODERATION_REASONS);

/** Pemetaan reason code moderator → ContentHiddenReason (kolom existing). */
const REASON_TO_CONTENT_HIDDEN: Record<QaModerationReason, 'SPAM' | 'INAPPROPRIATE' | 'HARASSMENT' | 'OTHER'> = {
  SPAM: 'SPAM',
  PROFANITY: 'INAPPROPRIATE',
  HARASSMENT: 'HARASSMENT',
  PII_LEAK: 'OTHER',
  SCAM_SUSPECTED: 'OTHER',
  OFF_TOPIC: 'OTHER',
  OTHER: 'OTHER',
};

function tableFor(targetType: string): 'profile_questions' | 'profile_question_comments' {
  if (targetType === 'QUESTION') return 'profile_questions';
  if (targetType === 'COMMENT') return 'profile_question_comments';
  throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Invalid targetType' });
}

function assertReasonCode(reasonCode: string): asserts reasonCode is QaModerationReason {
  if (!REASON_SET.has(reasonCode)) {
    throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Invalid reasonCode' });
  }
}

/**
 * Klien DB minimal untuk operasi raw SQL — PrismaService maupun
 * TransactionClient dari $transaction memenuhi kontrak ini.
 */
type RawDb = Pick<PrismaService, '$queryRaw' | '$executeRaw'>;

export interface QueueItem {
  targetType: QaReportTarget;
  targetId: string;
  contentPreview: string;
  answered: boolean | null;
  isHidden: boolean;
  hiddenByType: string | null;
  hiddenReason: string | null;
  hiddenAt: Date | null;
  authorUsernameMasked: string | null;
  profileUsernameMasked: string | null;
  pendingReports: number;
  reportReasonCode: string | null;
  spamSuspected: boolean;
  createdAt: Date;
}

export interface PaginatedQueue {
  data: QueueItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

@Injectable()
export class AdminQaModerationService {
  private readonly logger = new Logger(AdminQaModerationService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ==================================================================
  // G426/G439 — antrean moderasi (reported ATAU hidden), pagination + search
  // ==================================================================
  async getQueue(query: QaModerationQueueQueryDto): Promise<PaginatedQueue> {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(Math.max(1, query.limit ?? 20), 100);
    const offset = (page - 1) * limit;
    const spamThreshold = query.spamProfileThreshold ?? 3;

    const conditions: Prisma.Sql[] = [];
    // Antrean = item yang dilaporkan (laporan PENDING/UNDER_REVIEW) ATAU disembunyikan.
    conditions.push(Prisma.sql`(i.pending_reports > 0 OR i.is_hidden = TRUE)`);

    if (query.targetType) {
      conditions.push(Prisma.sql`i.target_type = ${query.targetType}::qa_report_target`);
    }
    if (query.reasonCode) {
      conditions.push(
        Prisma.sql`(i.report_reason_code = ${query.reasonCode}::qa_moderation_reason OR i.hidden_reason_code = ${query.reasonCode}::qa_moderation_reason)`,
      );
    }
    if (query.answered === 'answered') conditions.push(Prisma.sql`i.answered = TRUE`);
    if (query.answered === 'unanswered') {
      conditions.push(Prisma.sql`(i.target_type = 'QUESTION' AND i.answered = FALSE)`);
    }
    if (query.reportedOnly) conditions.push(Prisma.sql`i.pending_reports > 0`);
    if (query.hiddenOnly) conditions.push(Prisma.sql`i.is_hidden = TRUE`);
    if (query.spamOnly) conditions.push(Prisma.sql`i.spam_suspected = TRUE`);
    if (query.q && query.q.trim()) {
      const like = `%${query.q.trim()}%`;
      conditions.push(
        Prisma.sql`(i.content ILIKE ${like} OR i.author_username ILIKE ${like} OR i.profile_username ILIKE ${like})`,
      );
    }
    const where = Prisma.join(conditions, ' AND ');

    const rows = await this.prisma.$queryRaw<
      Array<{
        target_type: QaReportTarget;
        target_id: string;
        content: string;
        answered: boolean | null;
        is_hidden: boolean;
        hidden_by_type: string | null;
        hidden_reason: string | null;
        hidden_at: Date | null;
        author_username: string | null;
        profile_username: string | null;
        pending_reports: number;
        report_reason_code: string | null;
        hidden_reason_code: string | null;
        spam_suspected: boolean;
        created_at: Date;
        total: bigint;
      }>
    >(Prisma.sql`
      WITH open_reports AS (
        SELECT target_type, target_id,
               COUNT(*) FILTER (WHERE status IN ('PENDING','UNDER_REVIEW')) AS pending_reports,
               (ARRAY_AGG(reason_code) FILTER (WHERE status IN ('PENDING','UNDER_REVIEW')))[1] AS report_reason_code
        FROM qa_reports
        GROUP BY target_type, target_id
      ),
      spam_authors AS (
        SELECT pq."askerId" AS author_id, LOWER(TRIM(pq.question)) AS norm_text
        FROM profile_questions pq
        WHERE pq."createdAt" >= NOW() - INTERVAL '24 hours'
        GROUP BY pq."askerId", LOWER(TRIM(pq.question))
        HAVING COUNT(DISTINCT pq."receiverId") >= ${spamThreshold}
        UNION
        SELECT c."authorId" AS author_id, LOWER(TRIM(c.content)) AS norm_text
        FROM profile_question_comments c
        JOIN profile_questions pq ON pq.id = c."questionId"
        WHERE c."createdAt" >= NOW() - INTERVAL '24 hours'
        GROUP BY c."authorId", LOWER(TRIM(c.content))
        HAVING COUNT(DISTINCT pq."receiverId") >= ${spamThreshold}
      ),
      -- Kode reason presisi dari aksi HIDE moderator terakhir (kolom hidden_reason
      -- hanya menyimpan pemetaan kasar ContentHiddenReason).
      latest_hide AS (
        SELECT DISTINCT ON (target_type, target_id) target_type, target_id, reason_code
        FROM qa_moderation_events
        WHERE action = 'HIDDEN'::qa_event_action
        ORDER BY target_type, target_id, created_at DESC
      ),
      items AS (
        SELECT 'QUESTION'::qa_report_target AS target_type,
               pq.id AS target_id,
               LEFT(pq.question, 200) AS content,
               (pq.answer IS NOT NULL) AS answered,
               pq."isHidden" AS is_hidden, pq.hidden_by_type::text AS hidden_by_type,
               pq."hiddenReason"::text AS hidden_reason,
               lh.reason_code AS hidden_reason_code,
               pq."hiddenAt" AS hidden_at, pq."createdAt" AS created_at,
               a.username AS author_username, r.username AS profile_username,
               COALESCE(or_.pending_reports, 0)::int AS pending_reports,
               or_.report_reason_code,
               (sa.author_id IS NOT NULL) AS spam_suspected
        FROM profile_questions pq
        JOIN users a ON a.id = pq."askerId"
        JOIN users r ON r.id = pq."receiverId"
        LEFT JOIN open_reports or_ ON or_.target_type = 'QUESTION' AND or_.target_id = pq.id
        LEFT JOIN spam_authors sa ON sa.author_id = pq."askerId" AND sa.norm_text = LOWER(TRIM(pq.question))
        LEFT JOIN latest_hide lh ON lh.target_type = 'QUESTION' AND lh.target_id = pq.id
        UNION ALL
        SELECT 'COMMENT'::qa_report_target,
               c.id,
               LEFT(c.content, 200),
               NULL::boolean,
               c."isHidden" AS is_hidden, c.hidden_by_type::text AS hidden_by_type,
               c."hiddenReason"::text AS hidden_reason,
               lh.reason_code,
               c."hiddenAt" AS hidden_at, c."createdAt" AS created_at,
               a.username, r.username,
               COALESCE(or_.pending_reports, 0)::int,
               or_.report_reason_code,
               (sa.author_id IS NOT NULL)
        FROM profile_question_comments c
        JOIN profile_questions pq ON pq.id = c."questionId"
        JOIN users a ON a.id = c."authorId"
        JOIN users r ON r.id = pq."receiverId"
        LEFT JOIN open_reports or_ ON or_.target_type = 'COMMENT' AND or_.target_id = c.id
        LEFT JOIN spam_authors sa ON sa.author_id = c."authorId" AND sa.norm_text = LOWER(TRIM(c.content))
        LEFT JOIN latest_hide lh ON lh.target_type = 'COMMENT' AND lh.target_id = c.id
      )
      SELECT i.*, COUNT(*) OVER() AS total
      FROM items i
      WHERE ${where}
      ORDER BY i.pending_reports DESC, i.spam_suspected DESC, i.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `);

    const total = rows.length > 0 ? Number(rows[0].total) : 0;
    return {
      // G433 — username dimask parsial di list; tanpa nomor HP/email.
      // G434 — preview konten list disensor PII (bukan teks mentah).
      data: rows.map(r => ({
        targetType: r.target_type,
        targetId: r.target_id,
        contentPreview: redactPii(r.content).redactedText,
        answered: r.answered,
        isHidden: r.is_hidden,
        hiddenByType: r.hidden_by_type,
        hiddenReason: r.hidden_reason,
        hiddenAt: r.hidden_at,
        authorUsernameMasked: maskUsername(r.author_username),
        profileUsernameMasked: maskUsername(r.profile_username),
        pendingReports: r.pending_reports,
        reportReasonCode: r.report_reason_code,
        spamSuspected: r.spam_suspected,
        createdAt: r.created_at,
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  // ==================================================================
  // G432/G438 — detail: konteks thread (maks 10) + histori + laporan + appeal
  // ==================================================================
  async getQuestionDetail(questionId: string): Promise<object> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string; question: string; answer: string | null; answered_at: Date | null;
        is_hidden: boolean; hidden_by_type: string | null; hidden_reason: string | null;
        hidden_at: Date | null; hidden_by_admin_id: string | null; moderator_note: string | null;
        redacted_text: string | null; assigned_admin_id: string | null;
        asker_username: string | null; receiver_username: string | null;
        upvote_count: number; created_at: Date;
      }>
    >(Prisma.sql`
      SELECT pq.id, pq.question, pq.answer, pq."answeredAt" AS answered_at,
             pq."isHidden" AS is_hidden, pq.hidden_by_type::text AS hidden_by_type,
             pq."hiddenReason"::text AS hidden_reason,
             pq."hiddenAt" AS hidden_at, pq.hidden_by_admin_id, pq.moderator_note, pq.redacted_text,
             pq.assigned_admin_id,
             a.username AS asker_username, r.username AS receiver_username,
             pq."upvoteCount" AS upvote_count, pq."createdAt" AS created_at
      FROM profile_questions pq
      JOIN users a ON a.id = pq."askerId"
      JOIN users r ON r.id = pq."receiverId"
      WHERE pq.id = ${questionId}
    `);
    if (rows.length === 0) throw new NotFoundException({ code: ErrorCodes.QUESTION_NOT_FOUND, message: 'Question not found' });
    const q = rows[0];

    // Konteks thread: maks 10 komentar (terlama dulu = alur percakapan).
    const comments = await this.prisma.$queryRaw<
      Array<{ id: string; content: string; parent_id: string | null; is_hidden: boolean; author_username: string | null; created_at: Date }>
    >(Prisma.sql`
      SELECT c.id, c.content, c."parentId" AS parent_id, c."isHidden" AS is_hidden,
             u.username AS author_username, c."createdAt" AS created_at
      FROM profile_question_comments c
      JOIN users u ON u.id = c."authorId"
      WHERE c."questionId" = ${questionId}
      ORDER BY c."createdAt" ASC, c.id ASC
      LIMIT 10
    `);

    const [reports, events, appeals, deleteRequests] = await Promise.all([
      this.listReportsFor('QUESTION', questionId),
      this.listEventsFor('QUESTION', questionId),
      this.listAppealsFor('QUESTION', questionId),
      this.listDeleteRequestsFor('QUESTION', questionId),
    ]);

    return {
      targetType: 'QUESTION' as const,
      question: { ...q, askerUsername: q.asker_username, receiverUsername: q.receiver_username },
      comments,
      commentShown: comments.length,
      reports,
      history: events,
      appeals,
      deleteRequests,
    };
  }

  async getCommentDetail(commentId: string): Promise<object> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string; question_id: string; content: string; parent_id: string | null;
        is_hidden: boolean; hidden_by_type: string | null; hidden_reason: string | null;
        hidden_at: Date | null; hidden_by_admin_id: string | null; moderator_note: string | null;
        redacted_text: string | null; assigned_admin_id: string | null;
        author_username: string | null; created_at: Date;
        question_text: string; question_answer: string | null;
      }>
    >(Prisma.sql`
      SELECT c.id, c."questionId" AS question_id, c.content, c."parentId" AS parent_id,
             c."isHidden" AS is_hidden, c.hidden_by_type::text AS hidden_by_type,
             c."hiddenReason"::text AS hidden_reason,
             c."hiddenAt" AS hidden_at, c.hidden_by_admin_id, c.moderator_note, c.redacted_text,
             c.assigned_admin_id,
             u.username AS author_username, c."createdAt" AS created_at,
             pq.question AS question_text, pq.answer AS question_answer
      FROM profile_question_comments c
      JOIN users u ON u.id = c."authorId"
      JOIN profile_questions pq ON pq.id = c."questionId"
      WHERE c.id = ${commentId}
    `);
    if (rows.length === 0) throw new NotFoundException({ code: ErrorCodes.COMMENT_NOT_FOUND, message: 'Comment not found' });
    const c = rows[0];

    // Konteks thread: komentar terkait dalam pertanyaan yang sama (maks 10).
    const siblings = await this.prisma.$queryRaw<
      Array<{ id: string; content: string; parent_id: string | null; is_hidden: boolean; author_username: string | null; created_at: Date }>
    >(Prisma.sql`
      SELECT c2.id, c2.content, c2."parentId" AS parent_id, c2."isHidden" AS is_hidden,
             u.username AS author_username, c2."createdAt" AS created_at
      FROM profile_question_comments c2
      JOIN users u ON u.id = c2."authorId"
      WHERE c2."questionId" = ${c.question_id}
      ORDER BY c2."createdAt" ASC, c2.id ASC
      LIMIT 10
    `);

    const [reports, events, appeals, deleteRequests] = await Promise.all([
      this.listReportsFor('COMMENT', commentId),
      this.listEventsFor('COMMENT', commentId),
      this.listAppealsFor('COMMENT', commentId),
      this.listDeleteRequestsFor('COMMENT', commentId),
    ]);

    return {
      targetType: 'COMMENT' as const,
      comment: c,
      threadContext: {
        questionId: c.question_id,
        questionText: c.question_text,
        questionAnswer: c.question_answer,
        comments: siblings,
        commentShown: siblings.length,
      },
      reports,
      history: events,
      appeals,
      deleteRequests,
    };
  }

  async listReportsFor(targetType: QaReportTarget, targetId: string): Promise<QaReportRow[]> {
    return this.prisma.$queryRaw<QaReportRow[]>(Prisma.sql`
      SELECT r.id, r.target_type, r.target_id, r.reporter_id,
             u.username AS reporter_username,
             r.reason_code, r.note, r.status,
             r.assigned_admin_id, au."fullName" AS assigned_admin_name,
             r.resolved_at, r.created_at, r.updated_at
      FROM qa_reports r
      JOIN users u ON u.id = r.reporter_id
      LEFT JOIN admin_users au ON au.id = r.assigned_admin_id
      WHERE r.target_type = ${targetType}::qa_report_target AND r.target_id = ${targetId}
      ORDER BY r.created_at DESC
    `);
  }

  /** G438 — histori hide/unhide + alasan terakhir. */
  async listEventsFor(targetType: QaReportTarget, targetId: string): Promise<QaModerationEventRow[]> {
    return this.prisma.$queryRaw<QaModerationEventRow[]>(Prisma.sql`
      SELECT e.id, e.target_type, e.target_id, e.actor_admin_id,
             au."fullName" AS actor_admin_name,
             e.action, e.reason_code, e.note, e.created_at
      FROM qa_moderation_events e
      LEFT JOIN admin_users au ON au.id = e.actor_admin_id
      WHERE e.target_type = ${targetType}::qa_report_target AND e.target_id = ${targetId}
      ORDER BY e.created_at DESC
    `);
  }

  async listAppealsFor(targetType: QaReportTarget, targetId: string): Promise<QaAppealRow[]> {
    return this.prisma.$queryRaw<QaAppealRow[]>(Prisma.sql`
      SELECT ap.id, ap.target_type, ap.target_id, ap.appellant_id,
             u.username AS appellant_username,
             ap.reason, ap.status, ap.reviewer_admin_id,
             au."fullName" AS reviewer_admin_name,
             ap.reviewed_at, ap.review_note, ap.created_at
      FROM qa_appeals ap
      JOIN users u ON u.id = ap.appellant_id
      LEFT JOIN admin_users au ON au.id = ap.reviewer_admin_id
      WHERE ap.target_type = ${targetType}::qa_report_target AND ap.target_id = ${targetId}
      ORDER BY ap.created_at DESC
    `);
  }

  async listDeleteRequestsFor(targetType: QaReportTarget, targetId: string): Promise<QaDeleteRequestRow[]> {
    return this.prisma.$queryRaw<QaDeleteRequestRow[]>(Prisma.sql`
      SELECT d.id, d.target_type, d.target_id,
             d.requested_by_admin_id, rq."fullName" AS requester_admin_name,
             d.approved_by_admin_id, ap."fullName" AS approver_admin_name,
             d.status, d.reason, d.created_at, d.decided_at
      FROM qa_delete_requests d
      JOIN admin_users rq ON rq.id = d.requested_by_admin_id
      LEFT JOIN admin_users ap ON ap.id = d.approved_by_admin_id
      WHERE d.target_type = ${targetType}::qa_report_target AND d.target_id = ${targetId}
      ORDER BY d.created_at DESC
    `);
  }

  // ==================================================================
  // G428 — hide/unhide JALUR MODERATOR (tidak memakai endpoint self-service)
  // ==================================================================
  private async loadTarget(targetType: string, targetId: string): Promise<{
    id: string; authorId: string; authorUsername: string | null;
    isHidden: boolean; hiddenByType: string | null;
  }> {
    const table = tableFor(targetType);
    const authorCol = targetType === 'QUESTION' ? 'asker_id' : 'author_id';
    // Nama tabel tidak bisa di-parameterize — sudah divalidasi via tableFor().
    const rows = await this.prisma.$queryRaw<Array<{
      id: string; author_id: string; author_username: string | null;
      is_hidden: boolean; hidden_by_type: string | null;
    }>>(
      targetType === 'QUESTION'
        ? Prisma.sql`SELECT pq.id, pq."askerId" AS author_id, u.username AS author_username,
                            pq."isHidden" AS is_hidden, pq.hidden_by_type::text AS hidden_by_type
                     FROM profile_questions pq JOIN users u ON u.id = pq."askerId" WHERE pq.id = ${targetId}`
        : Prisma.sql`SELECT c.id, c."authorId" AS author_id, u.username AS author_username,
                            c."isHidden" AS is_hidden, c.hidden_by_type::text AS hidden_by_type
                     FROM profile_question_comments c JOIN users u ON u.id = c."authorId" WHERE c.id = ${targetId}`,
    );
    void table; void authorCol;
    if (rows.length === 0) {
      throw new NotFoundException({
        code: targetType === 'QUESTION' ? ErrorCodes.QUESTION_NOT_FOUND : ErrorCodes.COMMENT_NOT_FOUND,
        message: `${targetType === 'QUESTION' ? 'Question' : 'Comment'} not found`,
      });
    }
    const r = rows[0];
    return { id: r.id, authorId: r.author_id, authorUsername: r.author_username, isHidden: r.is_hidden, hiddenByType: r.hidden_by_type };
  }

  async moderatorHide(
    adminId: string,
    targetType: string,
    targetId: string,
    reasonCode: string,
    note?: string,
  ): Promise<object> {
    assertReasonCode(reasonCode);
    const target = await this.loadTarget(targetType, targetId);
    if (target.isHidden) {
      throw new ConflictException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: `Target already hidden (by ${target.hiddenByType ?? 'unknown'})`,
      });
    }

    const now = new Date();
    // Transaksi: UPDATE target + event audit + tandai laporan terkait harus
    // atomik — tidak boleh ada hide tanpa jejak audit.
    await this.prisma.$transaction(async (tx) => {
      await this.hideTx(tx, targetType as QaReportTarget, targetId, adminId, reasonCode as QaModerationReason, note, now);
    });

    // G443 — notifikasi netral ke penulis; tanpa menyebut pelapor.
    await this.notifyAuthor(
      target.authorId,
      'Konten Q&A disembunyikan',
      'Konten Anda di Q&A profil disembunyikan karena melanggar panduan komunitas Kahade. ' +
        'Anda dapat mengajukan keberatan melalui fitur banding bila merasa ini keliru.',
      { type: 'QA_CONTENT_HIDDEN', targetType, targetId },
    );

    return { id: targetId, targetType, isHidden: true, hiddenByType: 'MODERATOR', reasonCode };
  }

  /** Inti tulis hide — dipakai dalam transaksi (publik maupun dari reviewAppeal). */
  private async hideTx(
    db: RawDb,
    targetType: QaReportTarget,
    targetId: string,
    adminId: string,
    reasonCode: QaModerationReason,
    note: string | undefined,
    now: Date,
  ): Promise<void> {
    const table = tableFor(targetType);
    const mapped = REASON_TO_CONTENT_HIDDEN[reasonCode];
    await db.$executeRaw(
      table === 'profile_questions'
        ? Prisma.sql`UPDATE profile_questions
                     SET "isHidden" = TRUE, "hiddenReason" = ${mapped}::"ContentHiddenReason",
                         hidden_by_type = 'MODERATOR'::qa_hidden_by_type,
                         hidden_by_admin_id = ${adminId}, "hiddenBy" = ${adminId},
                         "hiddenAt" = ${now}, moderator_note = ${note ?? null},
                         "updatedAt" = ${now}
                     WHERE id = ${targetId}`
        : Prisma.sql`UPDATE profile_question_comments
                     SET "isHidden" = TRUE, "hiddenReason" = ${mapped}::"ContentHiddenReason",
                         hidden_by_type = 'MODERATOR'::qa_hidden_by_type,
                         hidden_by_admin_id = ${adminId}, "hiddenBy" = ${adminId},
                         "hiddenAt" = ${now}, moderator_note = ${note ?? null},
                         "updatedAt" = ${now}
                     WHERE id = ${targetId}`,
    );

    await this.recordEvent(db, targetType, targetId, adminId, 'HIDDEN', reasonCode, note);

    // Laporan pending terkait ikut ditandai UNDER_REVIEW + di-assign ke admin ini.
    await db.$executeRaw(Prisma.sql`
      UPDATE qa_reports
      SET status = 'UNDER_REVIEW'::qa_report_status, assigned_admin_id = ${adminId}, updated_at = ${now}
      WHERE target_type = ${targetType}::qa_report_target AND target_id = ${targetId}
        AND status = 'PENDING'::qa_report_status
    `);
  }

  async moderatorUnhide(adminId: string, targetType: string, targetId: string, note?: string): Promise<object> {
    const target = await this.loadTarget(targetType, targetId);
    if (!target.isHidden) {
      throw new ConflictException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Target is not hidden' });
    }
    if (target.hiddenByType !== 'MODERATOR') {
      // Hide milik pemilik profil adalah hak self-service pemilik — moderator
      // platform tidak boleh menimpanya.
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'Only the profile owner can unhide content they hid themselves',
      });
    }

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await this.unhideTx(tx, targetType as QaReportTarget, targetId, adminId, note, now);
    });

    await this.notifyAuthor(
      target.authorId,
      'Konten Q&A ditampilkan kembali',
      'Konten Anda di Q&A profil telah ditampilkan kembali setelah peninjauan tim moderasi Kahade.',
      { type: 'QA_CONTENT_UNHIDDEN', targetType, targetId },
    );

    return { id: targetId, targetType, isHidden: false };
  }

  /** Inti tulis unhide — dipakai dalam transaksi. */
  private async unhideTx(
    db: RawDb,
    targetType: QaReportTarget,
    targetId: string,
    adminId: string,
    note: string | undefined,
    now: Date,
  ): Promise<void> {
    const table = tableFor(targetType);
    await db.$executeRaw(
      table === 'profile_questions'
        ? Prisma.sql`UPDATE profile_questions
                     SET "isHidden" = FALSE, "hiddenReason" = NULL,
                         hidden_by_type = NULL, hidden_by_admin_id = NULL, "hiddenBy" = NULL,
                         "hiddenAt" = NULL, moderator_note = NULL, "updatedAt" = ${now}
                     WHERE id = ${targetId}`
        : Prisma.sql`UPDATE profile_question_comments
                     SET "isHidden" = FALSE, "hiddenReason" = NULL,
                         hidden_by_type = NULL, hidden_by_admin_id = NULL, "hiddenBy" = NULL,
                         "hiddenAt" = NULL, moderator_note = NULL, "updatedAt" = ${now}
                     WHERE id = ${targetId}`,
    );

    await this.recordEvent(db, targetType, targetId, adminId, 'UNHIDDEN', null, note);
  }

  // ==================================================================
  // G434 — redaksi PII (simpan redacted_text; original tidak diubah)
  // ==================================================================
  async redact(adminId: string, targetType: string, targetId: string): Promise<object> {
    const table = tableFor(targetType);
    const textCol = targetType === 'QUESTION' ? 'question' : 'content';
    const maxLen = targetType === 'QUESTION' ? 500 : 1000;

    const rows = await this.prisma.$queryRaw<Array<{ text: string | null; answer: string | null }>>(
      targetType === 'QUESTION'
        ? Prisma.sql`SELECT question AS text, answer FROM profile_questions WHERE id = ${targetId}`
        : Prisma.sql`SELECT content AS text, NULL::text AS answer FROM profile_question_comments WHERE id = ${targetId}`,
    );
    if (rows.length === 0 || !rows[0].text) {
      throw new NotFoundException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Target not found' });
    }
    void table; void textCol;

    const combined = rows[0].answer ? `${rows[0].text}\n${rows[0].answer}` : rows[0].text;
    const result = redactPii(combined);
    if (result.clean) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'No PII patterns detected in this content',
      });
    }

    const truncated = result.redactedText.length > maxLen;
    const stored = truncated ? result.redactedText.slice(0, maxLen) : result.redactedText;
    const summary = summarizePiiMatches(result.matches);
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(
        targetType === 'QUESTION'
          ? Prisma.sql`UPDATE profile_questions SET redacted_text = ${stored}, "updatedAt" = NOW() WHERE id = ${targetId}`
          : Prisma.sql`UPDATE profile_question_comments SET redacted_text = ${stored}, "updatedAt" = NOW() WHERE id = ${targetId}`,
      );

      await this.recordEvent(
        tx,
        targetType as QaReportTarget,
        targetId,
        adminId,
        'REDACTED',
        'PII_LEAK',
        `PII terdeteksi & disensor: ${summary}${truncated ? ' (dipotong ke batas kolom)' : ''}`,
      );
    });

    return {
      id: targetId,
      targetType,
      redactedText: stored,
      truncated,
      findings: summary,
      findingCount: result.matches.length,
    };
  }

  // ==================================================================
  // G435 — hapus permanen dua langkah (request → approve oleh SUPER_ADMIN lain)
  // ==================================================================
  async requestDelete(adminId: string, targetType: string, targetId: string, reason: string): Promise<object> {
    await this.loadTarget(targetType, targetId); // 404 bila tidak ada
    const existing = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM qa_delete_requests
      WHERE target_type = ${targetType}::qa_report_target AND target_id = ${targetId}
        AND status = 'PENDING'::qa_delete_approval_status
    `);
    if (existing.length > 0) {
      throw new ConflictException({ code: ErrorCodes.VALIDATION_ERROR, message: 'A pending delete request already exists for this target' });
    }
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      INSERT INTO qa_delete_requests (id, target_type, target_id, requested_by_admin_id, status, reason, created_at)
      VALUES (gen_random_uuid()::text, ${targetType}::qa_report_target, ${targetId}, ${adminId}, 'PENDING'::qa_delete_approval_status, ${reason}, NOW())
      RETURNING id
    `);
    return { requestId: rows[0].id, status: 'PENDING' };
  }

  async decideDeleteRequest(adminId: string, requestId: string, approve: boolean, note?: string): Promise<object> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string; target_type: QaReportTarget; target_id: string;
        requested_by_admin_id: string; status: string;
      }>
    >(Prisma.sql`SELECT id, target_type, target_id, requested_by_admin_id, status::text
                 FROM qa_delete_requests WHERE id = ${requestId}`);
    if (rows.length === 0) throw new NotFoundException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Delete request not found' });
    const req = rows[0];
    if (req.status !== 'PENDING') {
      throw new ConflictException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Delete request already decided' });
    }
    if (req.requested_by_admin_id === adminId) {
      // G435 — approver wajib SUPER_ADMIN lain, ≠ requester.
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'Approver must be a different SUPER_ADMIN than the requester',
      });
    }

    const now = new Date();
    if (approve) {
      const target = await this.loadTarget(req.target_type, req.target_id).catch(() => null);
      const table = tableFor(req.target_type);
      await this.prisma.$transaction(async (tx) => {
        // Hard delete permanen. Komentar ikut terhapus via ON DELETE CASCADE untuk QUESTION.
        await tx.$executeRaw(
          table === 'profile_questions'
            ? Prisma.sql`DELETE FROM profile_questions WHERE id = ${req.target_id}`
            : Prisma.sql`DELETE FROM profile_question_comments WHERE id = ${req.target_id}`,
        );
        await tx.$executeRaw(Prisma.sql`
          UPDATE qa_delete_requests
          SET status = 'APPROVED'::qa_delete_approval_status, approved_by_admin_id = ${adminId}, decided_at = ${now}
          WHERE id = ${requestId}
        `);
        await this.recordEvent(tx, req.target_type, req.target_id, adminId, 'DELETED', null, note ?? 'Approved permanent deletion');
      });
      if (target) {
        await this.notifyAuthor(
          target.authorId,
          'Konten Q&A dihapus',
          'Konten Anda di Q&A profil telah dihapus permanen oleh tim moderasi Kahade karena pelanggaran berat panduan komunitas.',
          { type: 'QA_CONTENT_DELETED', targetType: req.target_type, targetId: req.target_id },
        );
      }
      return { requestId, status: 'APPROVED' };
    }

    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE qa_delete_requests
      SET status = 'REJECTED'::qa_delete_approval_status, approved_by_admin_id = ${adminId}, decided_at = ${now}
      WHERE id = ${requestId}
    `);
    return { requestId, status: 'REJECTED' };
  }

  async listDeleteRequests(status?: string): Promise<QaDeleteRequestRow[]> {
    return this.prisma.$queryRaw<QaDeleteRequestRow[]>(Prisma.sql`
      SELECT d.id, d.target_type, d.target_id,
             d.requested_by_admin_id, rq."fullName" AS requester_admin_name,
             d.approved_by_admin_id, ap."fullName" AS approver_admin_name,
             d.status, d.reason, d.created_at, d.decided_at
      FROM qa_delete_requests d
      JOIN admin_users rq ON rq.id = d.requested_by_admin_id
      LEFT JOIN admin_users ap ON ap.id = d.approved_by_admin_id
      ${status ? Prisma.sql`WHERE d.status = ${status}::qa_delete_approval_status` : Prisma.sql``}
      ORDER BY d.created_at DESC
      LIMIT 100
    `);
  }

  // ==================================================================
  // G436 — review appeal (reviewer ≠ moderator yang hide)
  // ==================================================================
  async reviewAppeal(adminId: string, appealId: string, decision: 'APPROVED' | 'REJECTED', note?: string): Promise<object> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string; target_type: QaReportTarget; target_id: string;
        appellant_id: string; status: string; reason: string;
      }>
    >(Prisma.sql`SELECT id, target_type, target_id, appellant_id, status::text, reason FROM qa_appeals WHERE id = ${appealId}`);
    if (rows.length === 0) throw new NotFoundException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Appeal not found' });
    const appeal = rows[0];
    if (appeal.status !== 'PENDING') {
      throw new ConflictException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Appeal already reviewed' });
    }

    // Reviewer tidak boleh = moderator yang melakukan hide terakhir.
    const hideEvents = await this.prisma.$queryRaw<Array<{ actor_admin_id: string | null }>>(Prisma.sql`
      SELECT actor_admin_id FROM qa_moderation_events
      WHERE target_type = ${appeal.target_type}::qa_report_target AND target_id = ${appeal.target_id}
        AND action = 'HIDDEN'::qa_event_action
      ORDER BY created_at DESC LIMIT 1
    `);
    if (hideEvents.length > 0 && hideEvents[0].actor_admin_id === adminId) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'The moderator who hid this content cannot review its appeal',
      });
    }

    const now = new Date();
    const approve = decision === 'APPROVED';
    // Muat target dulu (di luar transaksi) untuk menentukan kelayakan unhide.
    const target = approve ? await this.loadTarget(appeal.target_type, appeal.target_id).catch(() => null) : null;
    const shouldUnhide = !!target && target.isHidden && target.hiddenByType === 'MODERATOR';

    // Satu transaksi: status appeal + (opsional) unhide + event audit.
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`
        UPDATE qa_appeals
        SET status = ${decision}::qa_appeal_status, reviewer_admin_id = ${adminId},
            reviewed_at = ${now}, review_note = ${note ?? null}, updated_at = ${now}
        WHERE id = ${appealId}
      `);
      if (shouldUnhide) {
        // Keberatan diterima → konten ditampilkan kembali (hanya bila hide oleh moderator).
        await this.unhideTx(tx, appeal.target_type, appeal.target_id, adminId, `Appeal ${appealId} approved`, now);
      }
      await this.recordEvent(
        tx,
        appeal.target_type,
        appeal.target_id,
        adminId,
        approve ? 'APPEAL_APPROVED' : 'APPEAL_REJECTED',
        null,
        note,
      );
    });

    if (shouldUnhide && target) {
      await this.notifyAuthor(
        target.authorId,
        'Konten Q&A ditampilkan kembali',
        'Konten Anda di Q&A profil telah ditampilkan kembali setelah banding disetujui tim moderasi Kahade.',
        { type: 'QA_CONTENT_UNHIDDEN', targetType: appeal.target_type, targetId: appeal.target_id },
      );
    }
    if (approve) {
      await this.notifyAuthor(
        appeal.appellant_id,
        'Keberatan Anda disetujui',
        'Keberatan Anda atas penyembunyian konten Q&A telah disetujui tim moderasi. Konten Anda telah ditampilkan kembali.',
        { type: 'QA_APPEAL_APPROVED', targetType: appeal.target_type, targetId: appeal.target_id },
      );
    } else {
      await this.notifyAuthor(
        appeal.appellant_id,
        'Keberatan Anda ditolak',
        'Keberatan Anda atas penyembunyian konten Q&A telah ditinjau dan ditolak. Keputusan moderasi tetap berlaku.',
        { type: 'QA_APPEAL_REJECTED', targetType: appeal.target_type, targetId: appeal.target_id },
      );
    }

    return { appealId, status: decision };
  }

  async listAppeals(status?: string, page = 1, limit = 20): Promise<object> {
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(Math.max(1, limit), 100);
    const offset = (safePage - 1) * safeLimit;
    const rows = await this.prisma.$queryRaw<Array<QaAppealRow & { total: bigint }>>(Prisma.sql`
      SELECT ap.id, ap.target_type, ap.target_id, ap.appellant_id,
             u.username AS appellant_username,
             ap.reason, ap.status, ap.reviewer_admin_id,
             au."fullName" AS reviewer_admin_name,
             ap.reviewed_at, ap.review_note, ap.created_at,
             COUNT(*) OVER() AS total
      FROM qa_appeals ap
      JOIN users u ON u.id = ap.appellant_id
      LEFT JOIN admin_users au ON au.id = ap.reviewer_admin_id
      ${status ? Prisma.sql`WHERE ap.status = ${status}::qa_appeal_status` : Prisma.sql``}
      ORDER BY ap.created_at DESC
      LIMIT ${safeLimit} OFFSET ${offset}
    `);
    const total = rows.length > 0 ? Number(rows[0].total) : 0;
    return {
      data: rows.map(r => ({ ...r, appellantUsernameMasked: maskUsername(r.appellant_username), total: undefined })),
      total, page: safePage, limit: safeLimit, totalPages: Math.ceil(total / safeLimit),
    };
  }

  // ==================================================================
  // Laporan: assign/handoff (G446) + resolve
  // ==================================================================
  async assignReport(adminId: string, reportId: string, assigneeAdminId?: string | null): Promise<object> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string; status: string }>>(
      Prisma.sql`SELECT id, status::text FROM qa_reports WHERE id = ${reportId}`,
    );
    if (rows.length === 0) throw new NotFoundException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Report not found' });

    if (assigneeAdminId) {
      const admin = await this.prisma.adminUser.findUnique({
        where: { id: assigneeAdminId },
        select: { id: true, isActive: true, deletedAt: true },
      });
      if (!admin || !admin.isActive || admin.deletedAt) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Assignee admin not found or inactive' });
      }
    }

    const now = new Date();
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE qa_reports
      SET assigned_admin_id = ${assigneeAdminId ?? null},
          status = CASE WHEN status = 'PENDING'::qa_report_status AND ${assigneeAdminId ?? null} IS NOT NULL
                        THEN 'UNDER_REVIEW'::qa_report_status ELSE status END,
          updated_at = ${now}
      WHERE id = ${reportId}
    `);
    void adminId;
    return { reportId, assignedAdminId: assigneeAdminId ?? null };
  }

  async resolveReport(adminId: string, reportId: string, resolution: 'DISMISSED' | 'ACTION_TAKEN', note?: string): Promise<object> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string; status: string; target_type: QaReportTarget; target_id: string }>>(
      Prisma.sql`SELECT id, status::text, target_type, target_id FROM qa_reports WHERE id = ${reportId}`,
    );
    if (rows.length === 0) throw new NotFoundException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Report not found' });
    const report = rows[0];
    if (!['PENDING', 'UNDER_REVIEW'].includes(report.status)) {
      throw new ConflictException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Report already resolved' });
    }
    const now = new Date();
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE qa_reports
      SET status = ${resolution}::qa_report_status, resolved_at = ${now}, resolved_by = ${adminId}, updated_at = ${now}
      WHERE id = ${reportId}
    `);
    const trimmedNote = note?.trim() || undefined;
    // BAI-027 (audit integrasi 2026-09-30): catatan resolusi DISIMPAN ke audit
    // trail (qa_moderation_events + admin_audit_logs via recordEvent) —
    // sebelumnya dibuang (`void note`).
    await this.recordEvent(
      this.prisma,
      report.target_type,
      report.target_id,
      adminId,
      'REPORT_RESOLVED',
      null,
      trimmedNote,
    );
    return { reportId, status: resolution, note: trimmedNote ?? null };
  }

  // ==================================================================
  // G442 — bulk hide/unhide (maks 50, hasil parsial per item)
  // ==================================================================
  async bulkHide(
    adminId: string,
    targetType: string,
    ids: string[],
    reasonCode: string,
    note: string | undefined,
    confirm: boolean,
  ): Promise<object> {
    assertReasonCode(reasonCode);
    if (confirm !== true) {
      // G441 — konfirmasi eksplisit wajib untuk bulk.
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Bulk hide requires explicit confirmation (confirm: true)',
      });
    }
    const uniqueIds = [...new Set(ids)].slice(0, 50);
    const results: Array<{ id: string; ok: boolean; error?: string }> = [];
    for (const id of uniqueIds) {
      try {
        await this.moderatorHide(adminId, targetType, id, reasonCode, note);
        results.push({ id, ok: true });
      } catch (err) {
        results.push({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return {
      targetType,
      total: uniqueIds.length,
      succeeded: results.filter(r => r.ok).length,
      failed: results.filter(r => !r.ok).length,
      results,
    };
  }

  async bulkUnhide(adminId: string, targetType: string, ids: string[], note: string | undefined, confirm: boolean): Promise<object> {
    if (confirm !== true) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Bulk unhide requires explicit confirmation (confirm: true)',
      });
    }
    const uniqueIds = [...new Set(ids)].slice(0, 50);
    const results: Array<{ id: string; ok: boolean; error?: string }> = [];
    for (const id of uniqueIds) {
      try {
        await this.moderatorUnhide(adminId, targetType, id, note);
        results.push({ id, ok: true });
      } catch (err) {
        results.push({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return {
      targetType,
      total: uniqueIds.length,
      succeeded: results.filter(r => r.ok).length,
      failed: results.filter(r => !r.ok).length,
      results,
    };
  }

  // ==================================================================
  // G440 — deteksi spam lintas profil (heuristik)
  // ==================================================================
  async getSpamCandidates(profileThreshold = 3, limit = 50): Promise<object> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        author_id: string;
        username: string | null;
        target_type: QaReportTarget;
        sample_text: string;
        profile_count: number;
        item_count: number;
        item_ids: string[];
        first_seen: Date;
        last_seen: Date;
      }>
    >(Prisma.sql`
      WITH items AS (
        SELECT pq.id, 'QUESTION'::qa_report_target AS target_type,
               pq."askerId" AS author_id, pq."receiverId" AS profile_id,
               LOWER(TRIM(pq.question)) AS norm_text, LEFT(pq.question, 120) AS sample_text,
               pq."createdAt" AS created_at
        FROM profile_questions pq
        WHERE pq."createdAt" >= NOW() - INTERVAL '24 hours'
        UNION ALL
        SELECT c.id, 'COMMENT'::qa_report_target,
               c."authorId", pq."receiverId",
               LOWER(TRIM(c.content)), LEFT(c.content, 120),
               c."createdAt"
        FROM profile_question_comments c
        JOIN profile_questions pq ON pq.id = c."questionId"
        WHERE c."createdAt" >= NOW() - INTERVAL '24 hours'
      )
      SELECT i.author_id, u.username, i.target_type,
             MAX(i.sample_text) AS sample_text,
             COUNT(DISTINCT i.profile_id)::int AS profile_count,
             COUNT(*)::int AS item_count,
             ARRAY_AGG(i.id) AS item_ids,
             MIN(i.created_at) AS first_seen, MAX(i.created_at) AS last_seen
      FROM items i
      JOIN users u ON u.id = i.author_id
      GROUP BY i.author_id, u.username, i.target_type, i.norm_text
      HAVING COUNT(DISTINCT i.profile_id) >= ${profileThreshold}
      ORDER BY profile_count DESC, item_count DESC
      LIMIT ${Math.min(Math.max(1, limit), 100)}
    `);
    return {
      threshold: profileThreshold,
      windowHours: 24,
      candidates: rows.map(r => ({
        ...r,
        // G433 — username dimask di daftar kandidat; G434 — cuplikan disensor PII.
        sampleText: redactPii(r.sample_text).redactedText,
        sample_text: undefined,
        username: undefined,
        authorUsernameMasked: maskUsername(r.username),
        authorId: r.author_id,
      })),
    };
  }

  // ==================================================================
  // G445 — metrik antrean
  // ==================================================================
  async getMetrics(): Promise<object> {
    const [openRows, avgRows, distRows, hiddenRows] = await Promise.all([
      this.prisma.$queryRaw<Array<{ open_reports: bigint; under_review: bigint }>>(Prisma.sql`
        SELECT COUNT(*) FILTER (WHERE status = 'PENDING'::qa_report_status)::bigint AS open_reports,
               COUNT(*) FILTER (WHERE status = 'UNDER_REVIEW'::qa_report_status)::bigint AS under_review
        FROM qa_reports
        WHERE status IN ('PENDING'::qa_report_status, 'UNDER_REVIEW'::qa_report_status)
      `),
      this.prisma.$queryRaw<Array<{ avg_seconds: number | null; resolved_count: bigint }>>(Prisma.sql`
        SELECT AVG(EXTRACT(EPOCH FROM (resolved_at - created_at))) AS avg_seconds,
               COUNT(*)::bigint AS resolved_count
        FROM qa_reports
        WHERE resolved_at IS NOT NULL AND resolved_at >= NOW() - INTERVAL '30 days'
      `),
      this.prisma.$queryRaw<Array<{ reason_code: string; count: bigint }>>(Prisma.sql`
        SELECT reason_code::text, COUNT(*)::bigint AS count
        FROM qa_reports
        WHERE status IN ('PENDING'::qa_report_status, 'UNDER_REVIEW'::qa_report_status)
        GROUP BY reason_code
        ORDER BY count DESC
      `),
      this.prisma.$queryRaw<Array<{ hidden_by_moderator: bigint; hidden_by_owner: bigint }>>(Prisma.sql`
        SELECT COUNT(*) FILTER (WHERE is_hidden AND hidden_by_type = 'MODERATOR'::qa_hidden_by_type)::bigint AS hidden_by_moderator,
               COUNT(*) FILTER (WHERE is_hidden AND (hidden_by_type = 'OWNER'::qa_hidden_by_type OR hidden_by_type IS NULL))::bigint AS hidden_by_owner
        FROM (
          SELECT "isHidden" AS is_hidden, hidden_by_type FROM profile_questions
          UNION ALL
          SELECT "isHidden" AS is_hidden, hidden_by_type FROM profile_question_comments
        ) t
      `),
    ]);
    const avgSeconds = avgRows[0]?.avg_seconds != null ? Number(avgRows[0].avg_seconds) : null;
    return {
      openReports: Number(openRows[0]?.open_reports ?? 0),
      underReview: Number(openRows[0]?.under_review ?? 0),
      avgResolutionSeconds: avgSeconds,
      avgResolutionHours: avgSeconds != null ? Math.round((avgSeconds / 3600) * 10) / 10 : null,
      resolvedLast30d: Number(avgRows[0]?.resolved_count ?? 0),
      reasonDistribution: distRows.map(r => ({ reasonCode: r.reason_code, count: Number(r.count) })),
      hiddenByModerator: Number(hiddenRows[0]?.hidden_by_moderator ?? 0),
      hiddenByOwner: Number(hiddenRows[0]?.hidden_by_owner ?? 0),
    };
  }

  // ==================================================================
  // G448 — ekspor audit agregat (CSV; tanpa teks konten massal)
  // ==================================================================
  async exportAggregateCsv(days = 30): Promise<string> {
    const safeDays = Math.min(Math.max(1, days), 365);
    const rows = await this.prisma.$queryRaw<
      Array<{ day: Date; reason_code: string; report_count: bigint; resolved_count: bigint; action_taken_count: bigint }>
    >(Prisma.sql`
      SELECT DATE_TRUNC('day', created_at)::date AS day,
             reason_code::text,
             COUNT(*)::bigint AS report_count,
             COUNT(*) FILTER (WHERE resolved_at IS NOT NULL)::bigint AS resolved_count,
             COUNT(*) FILTER (WHERE status = 'ACTION_TAKEN'::qa_report_status)::bigint AS action_taken_count
      FROM qa_reports
      WHERE created_at >= NOW() - ((${safeDays} || ' days')::interval)
      GROUP BY 1, 2
      ORDER BY 1 DESC, 2
    `);
    const header = 'date,reason_code,report_count,resolved_count,action_taken_count';
    const lines = rows.map(r => {
      const day = r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10);
      return [day, r.reason_code, Number(r.report_count), Number(r.resolved_count), Number(r.action_taken_count)].join(',');
    });
    return [header, ...lines].join('\n') + '\n';
  }

  // ==================================================================
  // Util internal
  // ==================================================================
  private async recordEvent(
    db: RawDb,
    targetType: QaReportTarget,
    targetId: string,
    actorAdminId: string | null,
    action: QaEventAction,
    reasonCode: QaModerationReason | null,
    note?: string | null,
  ): Promise<void> {
    await db.$executeRaw(Prisma.sql`
      INSERT INTO qa_moderation_events (id, target_type, target_id, actor_admin_id, action, reason_code, note, created_at)
      VALUES (gen_random_uuid()::text, ${targetType}::qa_report_target, ${targetId},
              ${actorAdminId}, ${action}::qa_event_action,
              ${reasonCode ? Prisma.sql`${reasonCode}::qa_moderation_reason` : Prisma.sql`NULL`},
              ${note ?? null}, NOW())
    `);
    // SEC-504: setiap aksi moderasi Q&A juga dicatat di log audit admin
    // pusat (admin_audit_logs) dalam transaction client yang SAMA — atomic
    // dengan event moderasinya. IP belum tersedia di service ini ('unknown').
    if (actorAdminId) {
      const description =
        `QA moderation ${action} on ${targetType} ${targetId}` +
        (reasonCode ? ` (reason: ${reasonCode})` : '') +
        (note ? ` — ${note.slice(0, 500)}` : '');
      await db.$executeRaw(Prisma.sql`
        INSERT INTO admin_audit_logs ("id", "adminId", "action", "targetType", "targetId", "description", "ipAddress", "createdAt")
        VALUES (gen_random_uuid()::text, ${actorAdminId}, 'ADMIN_ACTION'::"AuditAction",
                ${'QA_MODERATION'}, ${targetId}, ${description}, 'unknown', NOW())
      `);
    }
  }

  /** G443 — notifikasi netral; tidak pernah menyebut pelapor. */
  private async notifyAuthor(
    userId: string,
    title: string,
    body: string,
    data: Record<string, string>,
  ): Promise<void> {
    const type = NotificationType.SYSTEM_ANNOUNCEMENT;
    this.prisma.notification
      .create({
        data: {
          notifId: generateNotifId(),
          userId,
          type,
          category: getCategoryForType(type),
          title,
          body,
          isRead: false,
        },
      })
      .catch((err: unknown) =>
        this.logger.warn(`silent-catch: QA moderation notification failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    this.prisma.emitNotificationCreated({ userId, title, body, data });
  }
}
