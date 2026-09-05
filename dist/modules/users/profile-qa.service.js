"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProfileQAService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const sanitize_util_1 = require("../../common/utils/sanitize.util");
const ErrorCodes = __importStar(require("../../common/constants/error-codes"));
const SPAM_PATTERNS = [
    /(.)\1{9,}/i,
    /(https?:\/\/[^\s]+){3,}/gi,
    /\b(buy now|click here|free money|act now|limited offer|congratulations you won)\b/gi,
];
const PROFANITY_WORDS = [
    'anjing', 'bangsat', 'bajingan', 'kontol', 'memek', 'ngentot', 'babi', 'tolol', 'goblok', 'bodoh',
];
function containsProfanity(text) {
    const lower = text.toLowerCase();
    return PROFANITY_WORDS.some(word => {
        const regex = new RegExp(`(?:^|\\s|[^a-zA-Z])${word}(?:$|\\s|[^a-zA-Z]|an|nya|in|kan|lah|kah)`, 'i');
        return regex.test(lower);
    });
}
function isSpam(text) {
    return SPAM_PATTERNS.some(pattern => {
        pattern.lastIndex = 0;
        return pattern.test(text);
    });
}
let ProfileQAService = class ProfileQAService {
    constructor(prisma) {
        this.prisma = prisma;
        this.commentSelect = {
            id: true,
            content: true,
            parentId: true,
            createdAt: true,
            author: { select: { username: true, fullName: true, avatarUrl: true } },
        };
    }
    async askQuestion(askerId, receiverUsername, question) {
        const trimmed = question.trim();
        if (trimmed.length < 5)
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Question must be at least 5 characters' });
        if (containsProfanity(trimmed)) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Question contains inappropriate language' });
        }
        if (isSpam(trimmed)) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Question appears to be spam' });
        }
        const receiver = await this.prisma.user.findUnique({
            where: { username: receiverUsername.toLowerCase() },
            select: { id: true, profileVisible: true, isActive: true, isBanned: true, deletedAt: true },
        });
        if (!receiver || !receiver.profileVisible || !receiver.isActive || receiver.isBanned || receiver.deletedAt) {
            throw new common_1.NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
        }
        if (receiver.id === askerId)
            throw new common_1.BadRequestException({ code: ErrorCodes.CANNOT_ASK_SELF, message: 'Cannot ask a question on your own profile' });
        const block = await this.prisma.blockList.findFirst({
            where: { OR: [{ blockerId: askerId, blockedId: receiver.id }, { blockerId: receiver.id, blockedId: askerId }] },
        });
        if (block)
            throw new common_1.NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
        const q = await this.prisma.profileQuestion.create({
            data: { askerId, receiverId: receiver.id, question: trimmed },
        });
        return { id: q.id, question: q.question, createdAt: q.createdAt };
    }
    async answerQuestion(userId, questionId, answer) {
        const trimmed = answer.trim();
        if (trimmed.length < 1)
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Answer is required' });
        if (containsProfanity(trimmed)) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Answer contains inappropriate language' });
        }
        if (isSpam(trimmed)) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Answer appears to be spam' });
        }
        const q = await this.prisma.profileQuestion.findUnique({ where: { id: questionId } });
        if (!q)
            throw new common_1.NotFoundException({ code: ErrorCodes.QUESTION_NOT_FOUND, message: 'Question not found' });
        if (q.receiverId !== userId)
            throw new common_1.ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'Only the receiver can answer' });
        const sanitized = (0, sanitize_util_1.escapeHtml)(trimmed);
        const updated = await this.prisma.profileQuestion.update({
            where: { id: questionId },
            data: { answer: sanitized, answeredAt: new Date() },
        });
        return { id: updated.id, answer: updated.answer, answeredAt: updated.answeredAt };
    }
    async getProfileQuestions(username, page, limit) {
        const user = await this.prisma.user.findUnique({
            where: { username: username.toLowerCase() },
            select: { id: true, profileVisible: true, isActive: true, isBanned: true, deletedAt: true },
        });
        if (!user || !user.profileVisible || !user.isActive || user.isBanned || user.deletedAt) {
            throw new common_1.NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
        }
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
        const [questions, total] = await Promise.all([
            this.prisma.profileQuestion.findMany({
                where: publicQuestionWhere,
                orderBy: [{ answeredAt: 'desc' }, { id: 'asc' }],
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
            })),
            total,
            page: safePage,
            limit: safeLimit,
            totalPages: Math.ceil(total / safeLimit),
        };
    }
    async getMyQuestions(userId, type, page, limit) {
        if (type !== 'received' && type !== 'asked') {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Invalid question type' });
        }
        const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
        const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(1, Math.floor(limit)), 50) : 20;
        const skip = (safePage - 1) * safeLimit;
        const where = type === 'received' ? { receiverId: userId, isHidden: false } : { askerId: userId };
        const [questions, total] = await Promise.all([
            this.prisma.profileQuestion.findMany({
                where,
                orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
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
            })),
            total,
            page: safePage,
            limit: safeLimit,
            totalPages: Math.ceil(total / safeLimit),
        };
    }
    async addComment(userId, questionId, content, parentId) {
        const trimmedContent = content.trim();
        if (trimmedContent.length < 1)
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Comment is required' });
        if (containsProfanity(trimmedContent)) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Comment contains inappropriate language' });
        }
        if (isSpam(trimmedContent)) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Comment appears to be spam' });
        }
        const q = await this.prisma.profileQuestion.findUnique({
            where: { id: questionId },
            select: { id: true, receiverId: true, isPublic: true, isHidden: true, answeredAt: true },
        });
        if (!q)
            throw new common_1.NotFoundException({ code: ErrorCodes.QUESTION_NOT_FOUND, message: 'Question not found' });
        if (!q.isPublic || q.isHidden)
            throw new common_1.ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'Question is not publicly visible' });
        if (!q.answeredAt)
            throw new common_1.BadRequestException({ code: ErrorCodes.FORBIDDEN, message: 'Cannot comment on unanswered questions' });
        const block = await this.prisma.blockList.findFirst({
            where: { OR: [{ blockerId: userId, blockedId: q.receiverId }, { blockerId: q.receiverId, blockedId: userId }] },
        });
        if (block)
            throw new common_1.NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });
        if (parentId) {
            const parent = await this.prisma.profileQuestionComment.findUnique({ where: { id: parentId } });
            if (!parent || parent.questionId !== questionId || parent.isHidden) {
                throw new common_1.BadRequestException({ code: ErrorCodes.COMMENT_NOT_FOUND, message: 'Parent comment not found' });
            }
            if (parent.parentId) {
                throw new common_1.BadRequestException({ code: ErrorCodes.FORBIDDEN, message: 'Cannot reply to a nested comment' });
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
    async getComments(questionId, page, limit) {
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
        if (!q)
            throw new common_1.NotFoundException({ code: ErrorCodes.QUESTION_NOT_FOUND, message: 'Question not found' });
        if (!q.isPublic || q.isHidden || !q.answeredAt || !q.receiver.profileVisible || !q.receiver.isActive || q.receiver.isBanned || q.receiver.deletedAt) {
            throw new common_1.ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'Question is not publicly visible' });
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
    async deleteComment(userId, commentId) {
        const comment = await this.prisma.profileQuestionComment.findUnique({
            where: { id: commentId },
            include: { question: { select: { receiverId: true } } },
        });
        if (!comment)
            throw new common_1.NotFoundException({ code: ErrorCodes.COMMENT_NOT_FOUND, message: 'Comment not found' });
        if (comment.authorId !== userId && comment.question.receiverId !== userId) {
            throw new common_1.ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'Not authorized to delete this comment' });
        }
        await this.prisma.profileQuestionComment.delete({ where: { id: commentId } });
        return { message: 'Comment deleted' };
    }
    async deleteQuestion(userId, questionId) {
        const q = await this.prisma.profileQuestion.findUnique({ where: { id: questionId } });
        if (!q)
            throw new common_1.NotFoundException({ code: ErrorCodes.QUESTION_NOT_FOUND, message: 'Question not found' });
        if (q.receiverId !== userId && q.askerId !== userId)
            throw new common_1.ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: 'Not your question' });
        await this.prisma.profileQuestion.delete({ where: { id: questionId } });
        return { message: 'Question deleted' };
    }
};
exports.ProfileQAService = ProfileQAService;
exports.ProfileQAService = ProfileQAService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], ProfileQAService);
