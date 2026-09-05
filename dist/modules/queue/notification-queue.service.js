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
var NotificationQueueService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.NotificationQueueService = void 0;
const common_1 = require("@nestjs/common");
const bull_1 = require("@nestjs/bull");
const notification_processor_1 = require("./processors/notification.processor");
let NotificationQueueService = NotificationQueueService_1 = class NotificationQueueService {
    constructor(notificationQueue) {
        this.notificationQueue = notificationQueue;
        this.logger = new common_1.Logger(NotificationQueueService_1.name);
    }
    async enqueue(data) {
        const jobData = {
            ...data,
            language: data.language ?? 'id',
        };
        try {
            await this.notificationQueue.add('send', jobData);
            return;
        }
        catch (error) {
            this.logger.error(`Notification enqueue failed for type=${String(jobData.type)}`, error instanceof Error ? error.stack : String(error));
            return;
        }
    }
    async enqueueMany(data) {
        if (data.length === 0)
            return 0;
        const jobs = data.map((item) => ({
            name: 'send',
            data: {
                ...item,
                language: item.language ?? 'id',
            },
        }));
        try {
            await this.notificationQueue.addBulk(jobs);
            return jobs.length;
        }
        catch (error) {
            this.logger.error(`Notification bulk enqueue failed for ${jobs.length} jobs`, error instanceof Error ? error.stack : String(error));
            return 0;
        }
    }
};
exports.NotificationQueueService = NotificationQueueService;
exports.NotificationQueueService = NotificationQueueService = NotificationQueueService_1 = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, bull_1.InjectQueue)(notification_processor_1.NOTIFICATION_QUEUE)),
    __metadata("design:paramtypes", [Object])
], NotificationQueueService);
