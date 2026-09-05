"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
var NotificationProcessor_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.NotificationProcessor = exports.NOTIFICATION_QUEUE = void 0;
const bull_1 = require("@nestjs/bull");
const common_1 = require("@nestjs/common");
const bull_2 = require("@nestjs/bull");
const client_1 = require("@prisma/client");
const crypto_1 = require("crypto");
const prisma_service_1 = require("../../../prisma/prisma.service");
const notification_category_map_1 = require("../../notifications/notification-category.map");
const queue_constants_1 = require("../queue.constants");
const background_reliability_util_1 = require("../../../common/utils/background-reliability.util");
function stableNotifId(jobId) {
    const digest = (0, crypto_1.createHash)('sha256').update(`notification:${String(jobId)}`).digest('hex');
    return `NTF-${digest.slice(0, 16)}`;
}
exports.NOTIFICATION_QUEUE = 'notification';
let NotificationProcessor = NotificationProcessor_1 = class NotificationProcessor {
    constructor(prisma, deadLetterQueue) {
        this.prisma = prisma;
        this.deadLetterQueue = deadLetterQueue;
        this.logger = new common_1.Logger(NotificationProcessor_1.name);
    }
    async handleSendNotification(job) {
        const { userId, type, title, body, pushData, actionUrl, language, channel } = job.data;
        if (!userId || !type || !title || !body) {
            throw new Error(`Notification job ${job.id} has invalid payload`);
        }
        const category = (0, notification_category_map_1.getCategoryForType)(type);
        const resolvedActionUrl = actionUrl ?? this.deriveActionUrl(pushData);
        let notification;
        try {
            notification = await this.prisma.notification.create({
                data: {
                    notifId: stableNotifId(job.id),
                    userId,
                    type,
                    category,
                    title,
                    body,
                    channel: channel ?? client_1.NotificationChannel.IN_APP,
                    isRead: false,
                    ...(resolvedActionUrl ? { actionUrl: resolvedActionUrl } : {}),
                    ...(language ? { metadata: { language } } : {}),
                },
            });
        }
        catch (e) {
            if (e instanceof client_1.Prisma.PrismaClientKnownRequestError
                && e.code === 'P2002'
                && Array.isArray(e.meta?.target)
                && e.meta.target.includes('notifId')) {
                this.logger.warn(`Notification job ${job.id} redelivered (attempt ${job.attemptsMade}) — row already exists, skipping duplicate push`);
                return;
            }
            throw e;
        }
        this.prisma.emitNotificationCreated({
            userId,
            title,
            body,
            data: {
                ...pushData,
                notificationId: notification.notifId,
                ...(resolvedActionUrl ? { actionUrl: resolvedActionUrl } : {}),
                notificationType: type,
                notificationCategory: category,
            },
        });
        this.logger.debug(`Notification job ${job.id} processed (lang=${language ?? 'default'})`);
    }
    deriveActionUrl(data) {
        if (data?.actionUrl)
            return data.actionUrl;
        if (data?.orderId)
            return `/order/${encodeURIComponent(data.orderId)}`;
        if (data?.orderLinkToken)
            return `/link/${encodeURIComponent(data.orderLinkToken)}`;
        if (data?.roomId ?? data?.chatRoomId)
            return `/chat/${encodeURIComponent(data.roomId ?? data.chatRoomId ?? '')}`;
        if (data?.transactionId ?? data?.txId)
            return `/wallet/transaction?id=${encodeURIComponent(data.transactionId ?? data.txId ?? '')}`;
        if (data?.disputeId)
            return `/dispute/${encodeURIComponent(data.disputeId)}`;
        return undefined;
    }
    async onJobFailed(job, error) {
        this.logger.error(`Notification job ${job.id} FAILED (attempt ${job.attemptsMade}/${job.opts.attempts}): ${error.message}`);
        if (job.attemptsMade >= (job.opts.attempts || 1)) {
            await this.deadLetterQueue.add('notification-failed', {
                originalQueue: exports.NOTIFICATION_QUEUE,
                jobId: job.id,
                data: job.data,
                error: (0, background_reliability_util_1.safeErrorMessage)(error),
                failedAt: new Date().toISOString(),
            }, {
                jobId: (0, queue_constants_1.deadLetterJobId)(exports.NOTIFICATION_QUEUE, job.id),
                removeOnComplete: false,
                removeOnFail: false,
            }).catch((dlqErr) => {
                this.logger.error(`CRITICAL: Dead-letter queue enqueue failed for notification job ${job.id} — event lost`, dlqErr);
            });
        }
    }
};
exports.NotificationProcessor = NotificationProcessor;
__decorate([
    (0, bull_1.Process)({ name: 'send', concurrency: 5 }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], NotificationProcessor.prototype, "handleSendNotification", null);
__decorate([
    (0, bull_1.OnQueueFailed)(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Error]),
    __metadata("design:returntype", Promise)
], NotificationProcessor.prototype, "onJobFailed", null);
exports.NotificationProcessor = NotificationProcessor = NotificationProcessor_1 = __decorate([
    (0, common_1.Injectable)(),
    (0, bull_1.Processor)(exports.NOTIFICATION_QUEUE),
    __param(1, (0, bull_2.InjectQueue)(queue_constants_1.DEAD_LETTER_QUEUE)),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService, Object])
], NotificationProcessor);
