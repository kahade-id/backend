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
var AuditLogProcessor_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuditLogProcessor = void 0;
const bull_1 = require("@nestjs/bull");
const common_1 = require("@nestjs/common");
const bull_2 = require("@nestjs/bull");
const audit_log_service_1 = require("../../../common/services/audit-log.service");
const queue_constants_1 = require("../queue.constants");
const background_reliability_util_1 = require("../../../common/utils/background-reliability.util");
let AuditLogProcessor = AuditLogProcessor_1 = class AuditLogProcessor {
    constructor(auditLogService, deadLetterQueue) {
        this.auditLogService = auditLogService;
        this.deadLetterQueue = deadLetterQueue;
        this.logger = new common_1.Logger(AuditLogProcessor_1.name);
    }
    async handleWrite(job) {
        const { type, params } = job.data;
        if (type === 'user') {
            await this.auditLogService.writeUserAction(params);
        }
        else {
            await this.auditLogService.writeAdminAction(params);
        }
    }
    async handleFailed(job, err) {
        if (job.attemptsMade >= (job.opts.attempts ?? 3)) {
            this.logger.error(`[AuditLog] CRITICAL: Exhausted retries for ${job.data.type} audit log — forwarding to dead-letter queue`, err.message);
            await this.deadLetterQueue.add('audit-log-failed', {
                originalQueue: audit_log_service_1.AUDIT_LOG_QUEUE,
                jobId: job.id,
                data: job.data,
                error: (0, background_reliability_util_1.safeErrorMessage)(err),
                failedAt: new Date().toISOString(),
            }, {
                jobId: (0, queue_constants_1.deadLetterJobId)(audit_log_service_1.AUDIT_LOG_QUEUE, job.id),
                removeOnComplete: false,
                removeOnFail: false,
            }).catch((dlqErr) => {
                this.logger.error(`[AuditLog] CRITICAL: Dead-letter queue enqueue failed — audit event lost`, dlqErr);
            });
        }
    }
};
exports.AuditLogProcessor = AuditLogProcessor;
__decorate([
    (0, bull_1.Process)('write'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], AuditLogProcessor.prototype, "handleWrite", null);
__decorate([
    (0, bull_1.OnQueueFailed)(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Error]),
    __metadata("design:returntype", Promise)
], AuditLogProcessor.prototype, "handleFailed", null);
exports.AuditLogProcessor = AuditLogProcessor = AuditLogProcessor_1 = __decorate([
    (0, bull_1.Processor)(audit_log_service_1.AUDIT_LOG_QUEUE),
    __param(1, (0, bull_2.InjectQueue)(queue_constants_1.DEAD_LETTER_QUEUE)),
    __metadata("design:paramtypes", [audit_log_service_1.AuditLogService, Object])
], AuditLogProcessor);
