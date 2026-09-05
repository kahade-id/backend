"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.QueueModule = void 0;
const common_1 = require("@nestjs/common");
const bull_1 = require("@nestjs/bull");
const config_1 = require("@nestjs/config");
const email_processor_1 = require("./processors/email.processor");
const notification_processor_1 = require("./processors/notification.processor");
const notification_queue_service_1 = require("./notification-queue.service");
const redis_module_1 = require("../../redis/redis.module");
const template_service_1 = require("../../common/services/template.service");
const queue_constants_1 = require("./queue.constants");
let QueueModule = class QueueModule {
};
exports.QueueModule = QueueModule;
exports.QueueModule = QueueModule = __decorate([
    (0, common_1.Module)({
        imports: [
            config_1.ConfigModule,
            redis_module_1.RedisModule,
            bull_1.BullModule.registerQueue({
                name: email_processor_1.EMAIL_QUEUE,
                limiter: {
                    max: 50,
                    duration: 1000,
                },
                settings: { stalledInterval: 30_000, maxStalledCount: 1 },
                defaultJobOptions: {
                    attempts: 3,
                    timeout: queue_constants_1.QUEUE_JOB_TIMEOUT_MS,
                    backoff: {
                        type: 'exponential',
                        delay: 5000,
                    },
                    removeOnComplete: 100,
                    removeOnFail: 50,
                },
            }),
            bull_1.BullModule.registerQueue({
                name: notification_processor_1.NOTIFICATION_QUEUE,
                settings: { stalledInterval: 30_000, maxStalledCount: 1 },
                defaultJobOptions: {
                    attempts: 3,
                    timeout: queue_constants_1.QUEUE_JOB_TIMEOUT_MS,
                    backoff: {
                        type: 'exponential',
                        delay: 3000,
                    },
                    removeOnComplete: 100,
                    removeOnFail: 50,
                },
            }),
            bull_1.BullModule.registerQueue({
                name: queue_constants_1.DEAD_LETTER_QUEUE,
                settings: { stalledInterval: 60_000, maxStalledCount: 1 },
                defaultJobOptions: {
                    attempts: 1,
                    timeout: queue_constants_1.QUEUE_JOB_TIMEOUT_MS,
                    removeOnComplete: false,
                    removeOnFail: false,
                },
            }),
        ],
        providers: [email_processor_1.EmailProcessor, notification_processor_1.NotificationProcessor, template_service_1.TemplateService, notification_queue_service_1.NotificationQueueService],
        exports: [bull_1.BullModule, template_service_1.TemplateService, notification_queue_service_1.NotificationQueueService],
    })
], QueueModule);
