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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
var EmailProcessor_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.EmailProcessor = exports.EMAIL_QUEUE = void 0;
const bull_1 = require("@nestjs/bull");
const common_1 = require("@nestjs/common");
const bull_2 = require("@nestjs/bull");
const config_1 = require("@nestjs/config");
const nodemailer = __importStar(require("nodemailer"));
const redis_service_1 = require("../../../redis/redis.service");
const template_service_1 = require("../../../common/services/template.service");
const queue_constants_1 = require("../queue.constants");
const background_reliability_util_1 = require("../../../common/utils/background-reliability.util");
exports.EMAIL_QUEUE = 'email';
const PERMANENT_ERROR_PATTERNS = [
    /invalid.*(?:email|address|recipient|mailbox)/i,
    /user.*(?:unknown|not found|does not exist)/i,
    /mailbox.*(?:not found|unavailable|disabled|full)/i,
    /address.*rejected/i,
    /no such user/i,
    /account.*(?:disabled|suspended|closed)/i,
    /domain.*(?:not found|invalid)/i,
    /relay.*denied/i,
    /blacklisted/i,
    /spam.*rejected/i,
    /policy.*rejection/i,
    /permanent.*failure/i,
];
const PERMANENT_SMTP_CODES = new Set([
    550, 551, 552, 553, 554,
    521, 525, 541, 571,
]);
function isPermanentFailure(error) {
    const message = error.message || '';
    if (PERMANENT_ERROR_PATTERNS.some(p => p.test(message))) {
        return true;
    }
    const codeMatch = message.match(/\b([45]\d{2})\b/);
    if (codeMatch) {
        const code = parseInt(codeMatch[1], 10);
        if (PERMANENT_SMTP_CODES.has(code)) {
            return true;
        }
    }
    const responseCode = error && typeof error === 'object'
        ? error.responseCode
        : undefined;
    if (typeof responseCode === 'number' && PERMANENT_SMTP_CODES.has(responseCode)) {
        return true;
    }
    return false;
}
function htmlToPlainText(html) {
    let text = html;
    text = text.replace(/<\/?(p|br|div|h[1-6]|li|tr|blockquote|hr)[^>]*>/gi, '\n');
    text = text.replace(/<\/(td|th)>/gi, '\t');
    text = text.replace(/<a[^>]+href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '$2 ($1)');
    text = text.replace(/<[^>]*>/g, '');
    text = text.replace(/&amp;/g, '&');
    text = text.replace(/&lt;/g, '<');
    text = text.replace(/&gt;/g, '>');
    text = text.replace(/&quot;/g, '"');
    text = text.replace(/&#39;/g, "'");
    text = text.replace(/&nbsp;/g, ' ');
    text = text.replace(/\n{3,}/g, '\n\n');
    text = text.replace(/[ \t]+$/gm, '');
    return text.trim();
}
const MAX_EMAIL_LENGTH = 254;
const MAX_SUBJECT_LENGTH = 998;
const MAX_HTML_LENGTH = 1_000_000;
function isValidEmailJobData(data) {
    if (!data || typeof data !== 'object')
        return false;
    const d = data;
    const hasHtml = typeof d.html === 'string' && d.html.length > 0 && d.html.length <= MAX_HTML_LENGTH;
    const hasTemplate = typeof d.templateName === 'string' && d.templateName.length > 0;
    return (typeof d.to === 'string' && d.to.length > 0 && d.to.length <= MAX_EMAIL_LENGTH &&
        typeof d.subject === 'string' && d.subject.length > 0 && d.subject.length <= MAX_SUBJECT_LENGTH &&
        (hasHtml || hasTemplate));
}
let EmailProcessor = EmailProcessor_1 = class EmailProcessor {
    constructor(configService, redisService, templateService, deadLetterQueue) {
        this.configService = configService;
        this.redisService = redisService;
        this.templateService = templateService;
        this.deadLetterQueue = deadLetterQueue;
        this.logger = new common_1.Logger(EmailProcessor_1.name);
        this.transporter = null;
    }
    onModuleDestroy() {
        this.transporter?.close();
    }
    getTransporter() {
        if (!this.transporter) {
            this.transporter = nodemailer.createTransport({
                host: this.configService.get('smtp.host'),
                port: this.configService.get('smtp.port') || 587,
                secure: this.configService.get('smtp.secure') || false,
                auth: {
                    user: this.configService.get('smtp.user'),
                    pass: this.configService.get('smtp.pass'),
                },
                pool: true,
                maxConnections: 5,
                maxMessages: 100,
                connectionTimeout: 5_000,
                greetingTimeout: 5_000,
                socketTimeout: queue_constants_1.QUEUE_JOB_TIMEOUT_MS,
            });
        }
        return this.transporter;
    }
    async handleSendEmail(job) {
        if (!isValidEmailJobData(job.data)) {
            throw new Error(`Email job ${job.id} has invalid payload shape or exceeds field length limits`);
        }
        const { to, subject, text } = job.data;
        this.logger.log(`Processing email job ${job.id}`);
        let html;
        if (job.data.templateName) {
            try {
                const ctx = { ...job.data.templateContext, subject, year: new Date().getFullYear() };
                html = this.templateService.render(job.data.templateName, ctx);
            }
            catch (templateError) {
                this.logger.error(`Email job ${job.id} template rendering failed for "${job.data.templateName}": ${templateError.message}`);
                await job.moveToFailed({ message: `Template rendering failed: ${templateError.message}` }, true);
                return;
            }
        }
        else {
            html = job.data.html;
        }
        try {
            const transporter = this.getTransporter();
            await transporter.sendMail({
                from: this.configService.get('smtp.from') || this.configService.get('smtp.fromAddress') || '',
                to,
                subject,
                html,
                text: text || htmlToPlainText(html),
            });
            this.logger.log(`Email job ${job.id} sent successfully`);
        }
        catch (error) {
            if (error instanceof Error && isPermanentFailure(error)) {
                this.logger.warn(`Email job ${job.id} permanent failure (skipping retries): ${error.message}`);
                await job.moveToFailed({ message: `Permanent failure: ${error.message}` }, true);
                return;
            }
            throw error;
        }
    }
    async onJobFailed(job, error) {
        const sanitizedMessage = (0, background_reliability_util_1.safeErrorMessage)(error)
            .replace(/pass(?:word)?[:=]\s*\S+/gi, 'pass:[REDACTED]')
            .replace(/user[:=]\s*\S+/gi, 'user:[REDACTED]')
            .replace(/auth(?:entication)?.*?failed/gi, 'authentication failed');
        const errorType = isPermanentFailure(error) ? 'PERMANENT' : 'TRANSIENT';
        this.logger.error(`Email job ${job.id} FAILED [${errorType}] (attempt ${job.attemptsMade}/${job.opts.attempts}): ${sanitizedMessage}`);
        if (job.attemptsMade >= (job.opts.attempts || 1)) {
            const failureData = {
                jobId: job.id,
                error: sanitizedMessage,
                errorType,
                failedAt: new Date().toISOString(),
            };
            await this.redisService.hset('email_queue_failures', job.id.toString(), JSON.stringify(failureData));
            await this.redisService.expire('email_queue_failures', 7 * 24 * 60 * 60);
            await this.deadLetterQueue.add('email-failed', {
                originalQueue: exports.EMAIL_QUEUE,
                jobId: job.id,
                data: { to: job.data.to, subject: job.data.subject, templateName: job.data.templateName },
                error: sanitizedMessage,
                errorType,
                failedAt: new Date().toISOString(),
            }, {
                jobId: (0, queue_constants_1.deadLetterJobId)(exports.EMAIL_QUEUE, job.id),
                removeOnComplete: false,
                removeOnFail: false,
            }).catch((dlqErr) => {
                this.logger.error(`CRITICAL: Dead-letter queue enqueue failed for email job ${job.id} — event lost`, dlqErr);
            });
        }
    }
    onJobCompleted(job) {
        this.logger.debug(`Email job ${job.id} completed after ${job.attemptsMade} attempt(s)`);
    }
};
exports.EmailProcessor = EmailProcessor;
__decorate([
    (0, bull_1.Process)({ name: 'send', concurrency: 3 }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], EmailProcessor.prototype, "handleSendEmail", null);
__decorate([
    (0, bull_1.OnQueueFailed)(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Error]),
    __metadata("design:returntype", Promise)
], EmailProcessor.prototype, "onJobFailed", null);
__decorate([
    (0, bull_1.OnQueueCompleted)(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], EmailProcessor.prototype, "onJobCompleted", null);
exports.EmailProcessor = EmailProcessor = EmailProcessor_1 = __decorate([
    (0, common_1.Injectable)(),
    (0, bull_1.Processor)(exports.EMAIL_QUEUE),
    __param(3, (0, bull_2.InjectQueue)(queue_constants_1.DEAD_LETTER_QUEUE)),
    __metadata("design:paramtypes", [config_1.ConfigService,
        redis_service_1.RedisService,
        template_service_1.TemplateService, Object])
], EmailProcessor);
