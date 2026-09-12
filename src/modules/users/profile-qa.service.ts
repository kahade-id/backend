import { Injectable, BadRequestException, NotFoundException, ForbiddenException, ConflictException } from '@nestjs/common';
import { ContentHiddenReason } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { escapeHtml } from '../../common/utils/sanitize.util';
import * as ErrorCodes from '../../common/constants/error-codes';

/** Section 4: urutan daftar Q&A publik. `top` = upvote terbanyak. */
export const QUESTION_SORTS = ['recent', 'top'] as const;
export type QuestionSort = (typeof QUESTION_SORTS)[number];

const SPAM_PATTERNS = [
  /(.)\1{9,}/i,
  /(https?:\/\/[^\s]+){3,}/gi,
  /\b(buy now|click here|free money|act now|limited offer|congratulations you won)\b/gi,
];

const PROFANITY_WORDS = [
  'anjing', 'bangsat', 'bajingan', 'kontol', 'memek', 'ngentot', 'babi', 'tolol', 'goblok', 'bodoh',
];

function containsProfanity(text: string): boolean {
  const lower = text.toLowerCase();
  return PROFANITY_WORDS.some(word => {
    const regex = new RegExp(`(?:^|\\s|[^a-zA-Z])${word}(?:$|\\s|[^a-zA-Z]|an|nya|in|kan|lah|kah)`, 'i');
    return regex.test(lower);
  });
}

function isSpam(text: string): boolean {
  return SPAM_PATTERNS.some(pattern => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

interface QuestionCreatedResponse { id: string; question: string; createdAt: Date }
interface AnswerResponse { id: string; answer: string; answeredAt: Date }
interface UserSummary { username: string | null; fullName: string | null; avatarUrl: string | null }
interface CommentResponse { id: string; content: string; parentId: string | null; author: UserSummary; createdAt: Date }
interface PaginatedQuestions {
  questions: Array<{
    id: string; content: string; answer: string | null; answeredAt: Date | null;
    askerUsername: string | null; asker: UserSummary | null; createdAt: Date;
    comments?: Array<{ id: string; content: string; parentId: string | null; createdAt: Date; author: UserSummary }>;
    commentCount: number; isPublic?: boolean; receiver?: UserSummary | null;
    // Section 4: upvote
    upvoteCount: number; isUpvotedByViewer?: boolean;
  }>;
  total: number; page: number; limit: number; totalPages: number; sort?: QuestionSort;
}
interface PaginatedComments { data: CommentResponse[]; total: number; page: number; limit: number; totalPages: number }

@Injectable()
export class ProfileQAService {
  constructor(private prisma: PrismaService) {}

  async askQuestion(askerId: string, receiverUsername: string, question: string): Promise<QuestionCreatedResponse> {
    const trimmed = question.trim();
    if (trimmed.length < 5) throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Question must be at least 5 characters' });

    if (containsProfanity(trimmed)) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Question contains inappropriate language' });
    }
    if (isSpam(trimmed)) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Question appears to be spam' });
    }

    const receiver = await this.prisma.user.findUnique({
      where: { username: receiverUsername.toLowerCase() },
      select: { id: true, profileVisible: true, isActive: true, isBanned: true, deletedAt: true },
    });
    if (!receiver || !receiver.profileVisible || !receiver.isActive || receiver.isBanned || receiver.deletedAt) {
      throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    }
    if (receiver.id === askerId) throw new BadRequestException({ code: ErrorCodes.CANNOT_ASK_SELF, message: 'Cannot ask a question on your own profile' });

    const block = await this.prisma.blockList.findFirst({
      where: { OR: [{ blockerId: askerId, blockedId: receiver.id }, { blockerId: receiver.id, blockedId: askerId }] },
    });
    if (block) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });

    const q = await this.prisma.profileQuestion.create({
      data: { askerId, receiverId: receiver.id, question: trimmed },
    });

    return { id: q.id, question: q.question, createdAt: q.createdAt };
  }

  async answerQuestion(userId: string, questionId: string, answer: string): Promise<AnswerResponse> {
    const trimmed = answer.trim();
    if (trimmed.length < 1) throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Answer is required' });

    if (containsProfanity(trimmed)) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Answer contains inappropriate language' });
    }
    if (isSpam(trimmed)) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Answer appears to be spam' });
    }

    const q = await this.prisma.profileQuestion.findUnique({ where: { id: questionId } });
    if (!q) throw new NotFoundException({ code: ErrorCodes.QUESTION_NOT_FOUND, message: 'Question not found' });
    if (q.receiverId !== userId) throw new ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'Only the receiver can answer' });

    const sanitized = escapeHtml(trimmed);

    const updated = await this.prisma.profileQuestion.update({
      where: { id: questionId },
      data: { answer: sanitized, answeredAt: new Date() },
    });

    return { id: updated.id, answer: updated.answer!, answeredAt: updated.answeredAt! };
  }

  private readonly commentSelect = {
    id: true,
    content: true,
    parentId: true,
    createdAt: true,
    author: { select: { username: true, fullName: true, avatarUrl: true } },
  } as const;

  /**
   * Q&A publik sebuah profil.
   *
   * Section 4 menambah:
   *  - `sort` ('recent' | 'top'); 'top' mengurutkan upvoteCount desc dengan
   *    tiebreak answeredAt lalu { id } supaya halaman tetap stabil.
   *  - `viewerId` untuk menandai pertanyaan yang sudah di-upvote viewer dan
   *    untuk menegakkan block-list (relasi block dua arah -> 403 USER_BLOCKED,
   *    menyamakan dengan GET /users/:username di Section 2).
   */
  async getProfileQuestions(
    username: string,
    page: number,
    limit: number,
    sort: QuestionSort = 'recent',
    viewerId?: string | null,
  ): Promise<PaginatedQuestions> {
    const user = await this.prisma.user.findUnique({
      where: { username: username.toLowerCase() },
      select: { id: true, profileVisible: true, isActive: true, isBanned: true, deletedAt: true },
    });
    if (!user || !user.profileVisible || !user.isActive || user.isBanned || user.deletedAt) {
      throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    }
    await this.assertNotBlocked(viewerId ?? undefined, user.id);

    const safeSort: QuestionSort = sort === 'top' ? 'top' : 'recent';
    const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
    const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(1, Math.floor(limit)), 50) : 20;
    const skip = (safePage - 1) * safeLimit;
    const publicQuestionWhere = {
      receiverId: user.id,
      isPublic: true,
      isHidden: false,
      answeredAt: { not: null },
      asker: { isActive: true, isBanned: false, deletedAt: null, profileVisible: true },
    };
    const orderBy =
      safeSort === 'top'
        ? [{ upvoteCount: 'desc' as const }, { answeredAt: 'desc' as const }, { id: 'asc' as const }]
        : [{ answeredAt: 'desc' as const }, { id: 'asc' as const }];

    const [questions, total] = await Promise.all([
      this.prisma.profileQuestion.findMany({
        where: publicQuestionWhere,
        orderBy,
        skip,
        take: safeLimit,
        include: {
          asker: { select: { username: true, fullName: true, avatarUrl: true } },
          comments: {
            where: { isHidden: false, author: { isActive: true, isBanned: false, deletedAt: null, profileVisible: true } },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: this.commentSelect,
          },
          _count: { select: { comments: { where: { isHidden: false, author: { isActive: true, isBanned: false, deletedAt: null, profileVisible: true } } } } },
        },
      }),
      this.prisma.profileQuestion.count({ where: publicQuestionWhere }),
    ]);

    const upvotedIds = await this.getUpvotedQuestionIds(viewerId ?? undefined, questions.map(q => q.id));

    return {
      questions: questions.map(q => ({
        id: q.id,
        content: q.question,
        answer: q.answer,
        answeredAt: q.answeredAt,
        askerUsername: q.asker?.username ?? null,
        asker: q.asker,
        createdAt: q.createdAt,
        comments: q.comments,
        commentCount: q._count.comments,
        upvoteCount: q.upvoteCount,
        isUpvotedByViewer: upvotedIds.has(q.id),
      })),
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit),
      sort: safeSort,
    };
  }

  /**
   * Kotak masuk Q&A milik user.
   *
   * Section 4: `sort='top'` mengurutkan pertanyaan yang belum dijawab berdasarkan
   * upvoteCount, jadi pemilik profil tahu pertanyaan mana yang paling ditunggu
   * jawabannya. Default tetap 'recent' (createdAt desc) dengan tiebreak { id }.
   */
  async getMyQuestions(
    userId: string,
    type: 'received' | 'asked',
    page: number,
    limit: number,
    sort: QuestionSort = 'recent',
  ): Promise<PaginatedQuestions> {
    if (type !== 'received' && type !== 'asked') {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Invalid question type' });
    }
    const safeSort: QuestionSort = sort === 'top' ? 'top' : 'recent';
    const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
    const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(1, Math.floor(limit)), 50) : 20;
    const skip = (safePage - 1) * safeLimit;
    const where = type === 'received' ? { receiverId: userId, isHidden: false } : { askerId: userId };
    const orderBy =
      safeSort === 'top'
        ? [{ upvoteCount: 'desc' as const }, { createdAt: 'desc' as const }, { id: 'asc' as const }]
        : [{ createdAt: 'desc' as const }, { id: 'asc' as const }];

    const [questions, total] = await Promise.all([
      this.prisma.profileQuestion.findMany({
        where,
        orderBy,
        skip,
        take: safeLimit,
        include: {
          asker: { select: { username: true, fullName: true, avatarUrl: true } },
          receiver: { select: { username: true, fullName: true, avatarUrl: true } },
          _count: { select: { comments: { where: { isHidden: false } } } },
        },
      }),
      this.prisma.profileQuestion.count({ where }),
    ]);

    // Viewer == pemilik daftar, jadi upvote miliknya sendiri ikut ditandai.
    const upvotedIds = await this.getUpvotedQuestionIds(userId, questions.map(q => q.id));

    return {
      questions: questions.map(q => ({
        id: q.id,
        content: q.question,
        answer: q.answer,
        answeredAt: q.answeredAt,
        isPublic: q.isPublic,
        askerUsername: q.asker?.username ?? null,
        asker: q.asker,
        receiver: q.receiver,
        createdAt: q.createdAt,
        commentCount: q._count.comments,
        upvoteCount: q.upvoteCount,
        isUpvotedByViewer: upvotedIds.has(q.id),
      })),
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit),
      sort: safeSort,
    };
  }

  // ==================================================================
  // Section 4 — Upvote
  // ==================================================================

  /**
   * Relasi block dua arah menutup interaksi Q&A.
   *
   * Membaca daftar Q&A publik memakai 403 USER_BLOCKED (sama seperti
   * GET /users/:username di Section 2). Untuk upvote — yang bersifat menulis —
   * dipakai 404 USER_NOT_FOUND mengikuti konvensi lama service ini
   * (askQuestion/addComment) supaya keberadaan pertanyaan tidak bocor ke pihak
   * yang diblokir.
   */
  private async assertNotBlocked(viewerId: string | undefined, ownerId: string): Promise<void> {
    if (!viewerId || viewerId === ownerId) return;
    const block = await this.prisma.blockList.findFirst({
      where: {
        OR: [
          { blockerId: viewerId, blockedId: ownerId },
          { blockerId: ownerId, blockedId: viewerId },
        ],
      },
      select: { id: true },
    });
    if (block) {
      throw new ForbiddenException({ code: ErrorCodes.USER_BLOCKED, message: 'This profile is not accessible' });
    }
  }

  /** Upvote milik viewer untuk sekumpulan pertanyaan — satu query, bukan N+1. */
  private async getUpvotedQuestionIds(viewerId: string | undefined, questionIds: string[]): Promise<Set<string>> {
    if (!viewerId || questionIds.length === 0) return new Set<string>();
    const rows = await this.prisma.profileQuestionUpvote.findMany({
      where: { userId: viewerId, questionId: { in: questionIds } },
      select: { questionId: true },
    });
    return new Set(rows.map(row => row.questionId));
  }

  /**
   * Pertanyaan yang boleh di-upvote: publik, tidak disembunyikan, dan pemilik
   * profilnya sehat (aktif, tidak banned, belum dihapus, profil publik).
   */
  private async findUpvotableQuestion(questionId: string) {
    const question = await this.prisma.profileQuestion.findFirst({
      where: {
        id: questionId,
        isPublic: true,
        isHidden: false,
        receiver: { isActive: true, isBanned: false, deletedAt: null, profileVisible: true },
      },
      select: { id: true, receiverId: true, upvoteCount: true },
    });
    if (!question) {
      throw new NotFoundException({ code: ErrorCodes.QUESTION_NOT_FOUND, message: 'Question not found' });
    }
    return question;
  }

  async upvoteQuestion(userId: string, questionId: string): Promise<{ upvoted: boolean; upvoteCount: number }> {
    const question = await this.findUpvotableQuestion(questionId);
    if (question.receiverId === userId) {
      throw new BadRequestException({ code: ErrorCodes.CANNOT_ASK_SELF, message: 'Cannot upvote a question on your own profile' });
    }
    // Konvensi lama service ini: relasi block -> 404, bukan 403.
    const block = await this.prisma.blockList.findFirst({
      where: {
        OR: [
          { blockerId: userId, blockedId: question.receiverId },
          { blockerId: question.receiverId, blockedId: userId },
        ],
      },
      select: { id: true },
    });
    if (block) {
      throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
    }

    try {
      // Baris upvote + counter bergerak dalam satu transaksi (pola like showcase).
      const updated = await this.prisma.$transaction(async tx => {
        await tx.profileQuestionUpvote.create({ data: { userId, questionId } });
        return tx.profileQuestion.update({
          where: { id: questionId },
          data: { upvoteCount: { increment: 1 } },
          select: { upvoteCount: true },
        });
      });
      return { upvoted: true, upvoteCount: updated.upvoteCount };
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        const current = await this.prisma.profileQuestion.findUnique({ where: { id: questionId }, select: { upvoteCount: true } });
        throw new ConflictException({
          code: ErrorCodes.QUESTION_ALREADY_UPVOTED,
          message: 'You already upvoted this question',
          upvoteCount: current?.upvoteCount ?? null,
        });
      }
      throw err;
    }
  }

  async removeUpvote(userId: string, questionId: string): Promise<{ upvoted: boolean; upvoteCount: number }> {
    const question = await this.findUpvotableQuestion(questionId);
    void question;

    await this.prisma.$transaction(async tx => {
      const deleted = await tx.profileQuestionUpvote.deleteMany({ where: { userId, questionId } });
      if (deleted.count === 0) {
        throw new NotFoundException({ code: ErrorCodes.QUESTION_NOT_UPVOTED, message: 'You have not upvoted this question' });
      }
      // Guard gt:0 — counter tidak boleh pernah negatif.
      await tx.profileQuestion.updateMany({
        where: { id: questionId, upvoteCount: { gt: 0 } },
        data: { upvoteCount: { decrement: 1 } },
      });
    });

    const current = await this.prisma.profileQuestion.findUnique({ where: { id: questionId }, select: { upvoteCount: true } });
    return { upvoted: false, upvoteCount: current?.upvoteCount ?? 0 };
  }

  private isUniqueViolation(err: unknown): boolean {
    return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
  }

  // ==================================================================
  // Section 4 — Moderasi dengan alasan kategoris
  // ==================================================================

  /**
   * Sembunyikan pertanyaan beserta alasan kategorisnya. Hanya pemilik profil
   * (receiver) yang boleh memoderasi Q&A di profilnya sendiri.
   */
  async hideQuestion(userId: string, questionId: string, reason: ContentHiddenReason): Promise<object> {
    return this.setQuestionHidden(userId, questionId, true, reason);
  }

  async unhideQuestion(userId: string, questionId: string): Promise<object> {
    return this.setQuestionHidden(userId, questionId, false);
  }

  private async setQuestionHidden(
    userId: string,
    questionId: string,
    hidden: boolean,
    reason?: ContentHiddenReason,
  ): Promise<object> {
    const question = await this.prisma.profileQuestion.findUnique({
      where: { id: questionId },
      select: { id: true, receiverId: true, isHidden: true },
    });
    if (!question) throw new NotFoundException({ code: ErrorCodes.QUESTION_NOT_FOUND, message: 'Question not found' });
    if (question.receiverId !== userId) {
      throw new ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'Only the profile owner can moderate questions' });
    }
    if (hidden && !reason) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'hiddenReason is required when hiding a question' });
    }
    if (question.isHidden === hidden) {
      throw new ConflictException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: hidden ? 'Question is already hidden' : 'Question is not hidden',
      });
    }

    const updated = await this.prisma.profileQuestion.update({
      where: { id: questionId },
      data: hidden
        ? { isHidden: true, hiddenReason: reason, hiddenAt: new Date(), hiddenBy: userId }
        : { isHidden: false, hiddenReason: null, hiddenAt: null, hiddenBy: null },
      select: { id: true, isHidden: true, hiddenReason: true, hiddenAt: true },
    });
    return updated;
  }

  /** Komentar Q&A: hanya pemilik profil yang memoderasi (author cukup delete). */
  async hideComment(userId: string, commentId: string, reason: ContentHiddenReason): Promise<object> {
    return this.setCommentHidden(userId, commentId, true, reason);
  }

  async unhideComment(userId: string, commentId: string): Promise<object> {
    return this.setCommentHidden(userId, commentId, false);
  }

  private async setCommentHidden(
    userId: string,
    commentId: string,
    hidden: boolean,
    reason?: ContentHiddenReason,
  ): Promise<object> {
    const comment = await this.prisma.profileQuestionComment.findUnique({
      where: { id: commentId },
      select: { id: true, isHidden: true, question: { select: { receiverId: true } } },
    });
    if (!comment) throw new NotFoundException({ code: ErrorCodes.COMMENT_NOT_FOUND, message: 'Comment not found' });
    if (comment.question.receiverId !== userId) {
      throw new ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'Only the profile owner can moderate comments' });
    }
    if (hidden && !reason) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'hiddenReason is required when hiding a comment' });
    }
    if (comment.isHidden === hidden) {
      throw new ConflictException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: hidden ? 'Comment is already hidden' : 'Comment is not hidden',
      });
    }

    return this.prisma.profileQuestionComment.update({
      where: { id: commentId },
      data: hidden
        ? { isHidden: true, hiddenReason: reason, hiddenAt: new Date(), hiddenBy: userId }
        : { isHidden: false, hiddenReason: null, hiddenAt: null, hiddenBy: null },
      select: { id: true, isHidden: true, hiddenReason: true, hiddenAt: true },
    });
  }

  async addComment(userId: string, questionId: string, content: string, parentId?: string): Promise<CommentResponse> {
    const trimmedContent = content.trim();
    if (trimmedContent.length < 1) throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Comment is required' });

    if (containsProfanity(trimmedContent)) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Comment contains inappropriate language' });
    }
    if (isSpam(trimmedContent)) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Comment appears to be spam' });
    }

    const q = await this.prisma.profileQuestion.findUnique({
      where: { id: questionId },
      select: { id: true, receiverId: true, isPublic: true, isHidden: true, answeredAt: true },
    });
    if (!q) throw new NotFoundException({ code: ErrorCodes.QUESTION_NOT_FOUND, message: 'Question not found' });
    if (!q.isPublic || q.isHidden) throw new ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'Question is not publicly visible' });
    if (!q.answeredAt) throw new BadRequestException({ code: ErrorCodes.FORBIDDEN, message: 'Cannot comment on unanswered questions' });

    const block = await this.prisma.blockList.findFirst({
      where: { OR: [{ blockerId: userId, blockedId: q.receiverId }, { blockerId: q.receiverId, blockedId: userId }] },
    });
    if (block) throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });

    if (parentId) {
      const parent = await this.prisma.profileQuestionComment.findUnique({ where: { id: parentId } });
      if (!parent || parent.questionId !== questionId || parent.isHidden) {
        throw new BadRequestException({ code: ErrorCodes.COMMENT_NOT_FOUND, message: 'Parent comment not found' });
      }
      if (parent.parentId) {
        throw new BadRequestException({ code: ErrorCodes.FORBIDDEN, message: 'Cannot reply to a nested comment' });
      }
    }

    const comment = await this.prisma.profileQuestionComment.create({
      data: { questionId, authorId: userId, content: trimmedContent, parentId: parentId || null },
      include: { author: { select: { username: true, fullName: true, avatarUrl: true } } },
    });

    return {
      id: comment.id,
      content: comment.content,
      parentId: comment.parentId,
      author: comment.author,
      createdAt: comment.createdAt,
    };
  }

  async getComments(questionId: string, page: number, limit: number): Promise<PaginatedComments> {
    const q = await this.prisma.profileQuestion.findUnique({
      where: { id: questionId },
      select: {
        id: true,
        isPublic: true,
        isHidden: true,
        answeredAt: true,
        receiver: { select: { profileVisible: true, isActive: true, isBanned: true, deletedAt: true } },
      },
    });
    if (!q) throw new NotFoundException({ code: ErrorCodes.QUESTION_NOT_FOUND, message: 'Question not found' });
    if (!q.isPublic || q.isHidden || !q.answeredAt || !q.receiver.profileVisible || !q.receiver.isActive || q.receiver.isBanned || q.receiver.deletedAt) {
      throw new ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'Question is not publicly visible' });
    }

    const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
    const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(1, Math.floor(limit)), 50) : 20;
    const skip = (safePage - 1) * safeLimit;
    const visibleCommentWhere = { questionId, isHidden: false, author: { isActive: true, isBanned: false, deletedAt: null, profileVisible: true } };

    const [comments, total] = await Promise.all([
      this.prisma.profileQuestionComment.findMany({
        where: visibleCommentWhere,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        skip,
        take: safeLimit,
        select: this.commentSelect,
      }),
      this.prisma.profileQuestionComment.count({ where: visibleCommentWhere }),
    ]);

    return { data: comments, total, page: safePage, limit: safeLimit, totalPages: Math.ceil(total / safeLimit) };
  }

  async deleteComment(userId: string, commentId: string): Promise<{ message: string }> {
    const comment = await this.prisma.profileQuestionComment.findUnique({
      where: { id: commentId },
      include: { question: { select: { receiverId: true } } },
    });
    if (!comment) throw new NotFoundException({ code: ErrorCodes.COMMENT_NOT_FOUND, message: 'Comment not found' });
    if (comment.authorId !== userId && comment.question.receiverId !== userId) {
      throw new ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'Not authorized to delete this comment' });
    }

    await this.prisma.profileQuestionComment.delete({ where: { id: commentId } });
    return { message: 'Comment deleted' };
  }

  async deleteQuestion(userId: string, questionId: string): Promise<{ message: string }> {
    const q = await this.prisma.profileQuestion.findUnique({ where: { id: questionId } });
    if (!q) throw new NotFoundException({ code: ErrorCodes.QUESTION_NOT_FOUND, message: 'Question not found' });
    if (q.receiverId !== userId && q.askerId !== userId) throw new ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'Not your question' });

    await this.prisma.profileQuestion.delete({ where: { id: questionId } });
    return { message: 'Question deleted' };
  }
}
