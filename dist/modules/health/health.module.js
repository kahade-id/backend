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
var CronHealthIndicator_1, R2HealthIndicator_1, SmtpHealthIndicator_1, HealthController_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.HealthModule = exports.HealthController = void 0;
const common_1 = require("@nestjs/common");
const terminus_1 = require("@nestjs/terminus");
const terminus_2 = require("@nestjs/terminus");
const config_1 = require("@nestjs/config");
const public_decorator_1 = require("../../common/decorators/public.decorator");
const throttler_1 = require("@nestjs/throttler");
const prisma_service_1 = require("../../prisma/prisma.service");
const redis_service_1 = require("../../redis/redis.service");
const fs = __importStar(require("fs"));
const nodemailer = __importStar(require("nodemailer"));
const internal_readiness_util_1 = require("./internal-readiness.util");
const background_reliability_util_1 = require("../../common/utils/background-reliability.util");
const cron_runtime_registry_1 = require("../../common/utils/cron-runtime.registry");
const bull_1 = require("@nestjs/bull");
const audit_log_service_1 = require("../../common/services/audit-log.service");
const queue_constants_1 = require("../queue/queue.constants");
const email_processor_1 = require("../queue/processors/email.processor");
const notification_processor_1 = require("../queue/processors/notification.processor");
let RedisHealthIndicator = class RedisHealthIndicator extends terminus_2.HealthIndicator {
    constructor(redis) {
        super();
        this.redis = redis;
    }
    async isHealthy(key) {
        try {
            const result = await (0, background_reliability_util_1.withTimeout)(this.redis.getClient().ping(), 2_000, `Redis health probe ${key}`);
            return this.getStatus(key, result === 'PONG');
        }
        catch {
            return this.getStatus(key, false);
        }
    }
};
RedisHealthIndicator = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [redis_service_1.RedisService])
], RedisHealthIndicator);
let DiskHealthIndicator = class DiskHealthIndicator extends terminus_2.HealthIndicator {
    async isHealthy(key) {
        try {
            const stats = fs.statfsSync('/');
            const totalBytes = stats.bsize * stats.blocks;
            const freeBytes = stats.bsize * stats.bavail;
            const usedPercent = Math.round(((totalBytes - freeBytes) / totalBytes) * 100);
            const freeMb = Math.round(freeBytes / 1024 / 1024);
            const isHealthy = usedPercent < 90;
            return this.getStatus(key, isHealthy, { usedPercent, freeMb });
        }
        catch {
            return this.getStatus(key, false, { message: 'disk check unavailable' });
        }
    }
};
DiskHealthIndicator = __decorate([
    (0, common_1.Injectable)()
], DiskHealthIndicator);
let CronHealthIndicator = CronHealthIndicator_1 = class CronHealthIndicator extends terminus_2.HealthIndicator {
    constructor(redis) {
        super();
        this.redis = redis;
    }
    async isHealthy(key) {
        try {
            const results = {};
            let allOk = true;
            const runtimeSnapshots = new Map((0, cron_runtime_registry_1.getCronRuntimeSnapshots)().map(snapshot => [snapshot.name, snapshot]));
            for (const cronName of CronHealthIndicator_1.CRITICAL_CRONS) {
                const snapshot = runtimeSnapshots.get(cronName);
                const raw = await this.redis.get(`cron_heartbeat:${cronName}`);
                if (!raw && !snapshot) {
                    results[cronName] = { ok: false, state: 'awaiting-first-run' };
                    allOk = false;
                    continue;
                }
                if (snapshot && (snapshot.running || snapshot.consecutiveFailures > 0)) {
                    results[cronName] = {
                        ranAt: snapshot.startedAt,
                        ageHours: snapshot.startedAt ? Math.max(0, (Date.now() - new Date(snapshot.startedAt).getTime()) / 3600_000) : undefined,
                        ok: false,
                        state: snapshot.running ? 'running' : 'failed',
                    };
                    allOk = false;
                    continue;
                }
                if (!raw) {
                    results[cronName] = { ranAt: snapshot?.completedAt, ok: true, state: 'in-process' };
                    continue;
                }
                try {
                    const data = JSON.parse(raw);
                    const ageMs = Date.now() - new Date(data.ranAt).getTime();
                    const ageHours = Math.round(ageMs / 3600_000 * 10) / 10;
                    const state = typeof data.state === 'string' ? data.state : 'completed';
                    const ok = Number.isFinite(ageMs) && state === 'completed' && ageHours < 36;
                    results[cronName] = { ranAt: data.ranAt, ageHours, ok, state };
                    if (!ok)
                        allOk = false;
                }
                catch {
                    results[cronName] = { ok: false };
                    allOk = false;
                }
            }
            return this.getStatus(key, allOk, results);
        }
        catch {
            return this.getStatus(key, false, { message: 'cron health check unavailable' });
        }
    }
};
CronHealthIndicator.CRITICAL_CRONS = [
    'auto-complete-orders', 'auto-escalate-disputes', 'data-cleanup',
    'deadline-reminders', 'dlq-monitor', 'expire-dispute-calls',
    'expire-unconfirmed-orders', 'expire-unpaid-orders', 'fraud-challenge-escalation',
    'notification-archival', 'orphaned-upload-cleanup', 'pending-topup-cleanup',
    'pending-withdraw-cleanup', 'process-scheduled-withdrawals', 'proof-expiry',
    'redis-hash-cleanup', 'subscription-expiry', 'topup-counter-correction',
    'wallet-daily-reset', 'webhook-inbox-retry', 'daily-reconciliation',
    'withdrawal-reconciliation',
];
CronHealthIndicator = CronHealthIndicator_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [redis_service_1.RedisService])
], CronHealthIndicator);
let MidtransHealthIndicator = class MidtransHealthIndicator extends terminus_2.HealthIndicator {
    constructor(config) {
        super();
        this.config = config;
    }
    async isHealthy(key) {
        const serverKey = this.config.get('midtrans.serverKey');
        if (!serverKey) {
            return this.getStatus(key, false, { message: 'Midtrans server key not configured' });
        }
        const isProduction = this.config.get('midtrans.isProduction') ?? false;
        const baseUrl = isProduction
            ? 'https://api.midtrans.com'
            : 'https://api.sandbox.midtrans.com';
        const abortController = new AbortController();
        const timeout = setTimeout(() => abortController.abort(), 5000);
        try {
            const auth = Buffer.from(`${serverKey}:`).toString('base64');
            const response = await fetch(`${baseUrl}/v2/charge`, {
                method: 'GET',
                headers: { Authorization: `Basic ${auth}` },
                signal: abortController.signal,
            });
            clearTimeout(timeout);
            const ok = response.status !== 401 && response.status !== 403 && response.status < 500;
            return this.getStatus(key, ok, { statusCode: response.status });
        }
        catch {
            clearTimeout(timeout);
            return this.getStatus(key, false, { message: 'Midtrans API unreachable' });
        }
    }
};
MidtransHealthIndicator = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [config_1.ConfigService])
], MidtransHealthIndicator);
let R2HealthIndicator = R2HealthIndicator_1 = class R2HealthIndicator extends terminus_2.HealthIndicator {
    constructor(config) {
        super();
        this.config = config;
        this.logger = new common_1.Logger(R2HealthIndicator_1.name);
    }
    async isHealthy(key) {
        const accountId = this.config.get('r2.accountId');
        const accessKeyId = this.config.get('r2.accessKeyId');
        const secretAccessKey = this.config.get('r2.secretAccessKey');
        const bucketPublic = this.config.get('r2.bucketPublic');
        if (!accountId || !accessKeyId || !secretAccessKey) {
            return this.getStatus(key, false, { message: 'R2 credentials not configured' });
        }
        if (!bucketPublic) {
            return this.getStatus(key, false, { message: 'R2 bucket not configured' });
        }
        const endpointUrl = `https://${accountId}.r2.cloudflarestorage.com`;
        const abortController = new AbortController();
        const timeout = setTimeout(() => abortController.abort(), 5000);
        try {
            const url = `${endpointUrl}/${bucketPublic}?list-type=2&max-keys=1`;
            const now = new Date();
            const dateStr = now.toISOString().replace(/[:-]/g, '').replace(/\.\d{3}/, '');
            const dateShort = dateStr.slice(0, 8);
            const region = 'auto';
            const service = 's3';
            const { createHmac, createHash } = await Promise.resolve().then(() => __importStar(require('crypto')));
            const canonicalHeaders = `host:${accountId}.r2.cloudflarestorage.com\nx-amz-content-sha256:UNSIGNED-PAYLOAD\nx-amz-date:${dateStr}\n`;
            const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
            const canonicalRequest = `GET\n/${bucketPublic}\nlist-type=2&max-keys=1\n${canonicalHeaders}\n${signedHeaders}\nUNSIGNED-PAYLOAD`;
            const scope = `${dateShort}/${region}/${service}/aws4_request`;
            const stringToSign = `AWS4-HMAC-SHA256\n${dateStr}\n${scope}\n${createHash('sha256').update(canonicalRequest).digest('hex')}`;
            const kDate = createHmac('sha256', `AWS4${secretAccessKey}`).update(dateShort).digest();
            const kRegion = createHmac('sha256', kDate).update(region).digest();
            const kService = createHmac('sha256', kRegion).update(service).digest();
            const kSigning = createHmac('sha256', kService).update('aws4_request').digest();
            const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
            const authHeader = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    Authorization: authHeader,
                    'x-amz-date': dateStr,
                    'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
                    Host: `${accountId}.r2.cloudflarestorage.com`,
                },
                signal: abortController.signal,
            });
            clearTimeout(timeout);
            const ok = response.status === 200;
            if (!ok) {
                this.logger.warn(`R2 healthcheck non-200 for bucket=${bucketPublic}: status=${response.status}`);
            }
            return this.getStatus(key, ok, { statusCode: response.status });
        }
        catch {
            clearTimeout(timeout);
            return this.getStatus(key, false, { message: 'R2 storage unreachable' });
        }
    }
};
R2HealthIndicator = R2HealthIndicator_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [config_1.ConfigService])
], R2HealthIndicator);
let SmtpHealthIndicator = SmtpHealthIndicator_1 = class SmtpHealthIndicator extends terminus_2.HealthIndicator {
    constructor(config) {
        super();
        this.config = config;
        this.logger = new common_1.Logger(SmtpHealthIndicator_1.name);
    }
    async isHealthy(key) {
        const host = this.config.get('smtp.host');
        if (!host) {
            return this.getStatus(key, false, { message: 'SMTP not configured' });
        }
        const transporter = nodemailer.createTransport({
            host,
            port: this.config.get('smtp.port') || 587,
            secure: this.config.get('smtp.secure') || false,
            auth: {
                user: this.config.get('smtp.user'),
                pass: this.config.get('smtp.pass'),
            },
            connectionTimeout: 5000,
            greetingTimeout: 5000,
            socketTimeout: 5000,
        });
        try {
            await transporter.verify();
            return this.getStatus(key, true);
        }
        catch (err) {
            this.logger.warn(`SMTP healthcheck failed: ${err instanceof Error ? err.stack : String(err)}`);
            const safeMessage = err instanceof Error && err.name ? `SMTP error (${err.name})` : 'SMTP unreachable';
            return this.getStatus(key, false, { message: safeMessage });
        }
        finally {
            transporter.close();
        }
    }
};
SmtpHealthIndicator = SmtpHealthIndicator_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [config_1.ConfigService])
], SmtpHealthIndicator);
let WebhookInboxHealthIndicator = class WebhookInboxHealthIndicator extends terminus_2.HealthIndicator {
    constructor(prisma, redis) {
        super();
        this.prisma = prisma;
        this.redis = redis;
    }
    async isHealthy(key) {
        try {
            const now = new Date();
            const [retryable, deadLettered, heartbeatRaw, failureAlert] = await Promise.all([
                this.prisma.webhookLog.count({
                    where: {
                        source: 'MIDTRANS',
                        isProcessed: false,
                        deadLetteredAt: null,
                        OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
                    },
                }),
                this.prisma.webhookLog.count({
                    where: { source: 'MIDTRANS', isProcessed: false, deadLetteredAt: { not: null } },
                }),
                this.redis.get('cron_heartbeat:webhook_inbox_retry'),
                this.redis.get('cron_alert:webhook_inbox_retry_failed'),
            ]);
            let heartbeatAgeSeconds = null;
            if (heartbeatRaw) {
                try {
                    const heartbeat = JSON.parse(heartbeatRaw);
                    const ranAt = heartbeat.ranAt ? new Date(heartbeat.ranAt).getTime() : NaN;
                    if (Number.isFinite(ranAt))
                        heartbeatAgeSeconds = Math.max(0, Math.round((Date.now() - ranAt) / 1000));
                }
                catch {
                    heartbeatAgeSeconds = null;
                }
            }
            const heartbeatHealthy = heartbeatAgeSeconds !== null && heartbeatAgeSeconds < 600;
            const healthy = heartbeatHealthy && deadLettered === 0 && !failureAlert;
            return this.getStatus(key, healthy, { retryable, deadLettered, heartbeatAgeSeconds, failureAlert: Boolean(failureAlert) });
        }
        catch {
            return this.getStatus(key, false, { message: 'webhook inbox health check unavailable' });
        }
    }
};
WebhookInboxHealthIndicator = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService, redis_service_1.RedisService])
], WebhookInboxHealthIndicator);
let HealthController = HealthController_1 = class HealthController {
    constructor(health, prismaIndicator, redisIndicator, diskIndicator, cronIndicator, midtransIndicator, r2Indicator, smtpIndicator, webhookInboxIndicator, prisma, config, redis, emailQueue, notificationQueue, auditLogQueue, deadLetterQueue) {
        this.health = health;
        this.prismaIndicator = prismaIndicator;
        this.redisIndicator = redisIndicator;
        this.diskIndicator = diskIndicator;
        this.cronIndicator = cronIndicator;
        this.midtransIndicator = midtransIndicator;
        this.r2Indicator = r2Indicator;
        this.smtpIndicator = smtpIndicator;
        this.webhookInboxIndicator = webhookInboxIndicator;
        this.prisma = prisma;
        this.config = config;
        this.redis = redis;
        this.emailQueue = emailQueue;
        this.notificationQueue = notificationQueue;
        this.auditLogQueue = auditLogQueue;
        this.deadLetterQueue = deadLetterQueue;
        this.logger = new common_1.Logger(HealthController_1.name);
    }
    async check() {
        const maintenanceFlag = await this.redis.get('app:maintenance');
        if (maintenanceFlag) {
            let parsed = {};
            try {
                parsed = JSON.parse(maintenanceFlag);
            }
            catch { }
            if (parsed.enabled) {
                return {
                    status: 'ok',
                    maintenance: true,
                    maintenanceMessage: parsed.message || 'Scheduled maintenance in progress.',
                };
            }
        }
        const envMaintenance = this.config.get('MAINTENANCE_MODE');
        if (envMaintenance === 'true' || envMaintenance === '1') {
            return {
                status: 'ok',
                maintenance: true,
                maintenanceMessage: this.config.get('MAINTENANCE_MESSAGE') || 'Scheduled maintenance in progress.',
            };
        }
        const result = await this.health.check([
            () => this.prismaIndicator.pingCheck('database', this.prisma),
            () => this.redisIndicator.isHealthy('redis'),
            () => this.diskIndicator.isHealthy('disk'),
            () => this.midtransIndicator.isHealthy('midtrans'),
            () => this.r2Indicator.isHealthy('r2_storage'),
            () => this.smtpIndicator.isHealthy('smtp'),
            () => this.queueIndicator('queues'),
        ]);
        return { ...result, maintenance: false };
    }
    async internalReady(request) {
        if (!(0, internal_readiness_util_1.isLoopbackInternalProbe)(request.socket.remoteAddress, {
            'x-forwarded-for': request.header('x-forwarded-for') ?? undefined,
        })) {
            throw new common_1.NotFoundException();
        }
        try {
            const [, redisResult] = await (0, background_reliability_util_1.withTimeout)(Promise.all([
                this.prisma.$queryRaw `SELECT 1`,
                this.redis.getClient().ping(),
            ]), 2_000, 'internal readiness dependency probe');
            if (redisResult !== 'PONG')
                throw new Error('Redis did not return PONG');
            return { status: 'ready' };
        }
        catch {
            throw new common_1.ServiceUnavailableException('Dependencies are not ready');
        }
    }
    async queueIndicator(key) {
        try {
            const queues = [
                ['email', this.emailQueue],
                ['notification', this.notificationQueue],
                ['audit-log', this.auditLogQueue],
                ['dead-letter', this.deadLetterQueue],
            ];
            if (queues.some(([, queue]) => !queue)) {
                return this.healthIndicatorStatus(key, true, { mode: 'disabled' });
            }
            const runnableQueues = queues;
            const counts = await (0, background_reliability_util_1.withTimeout)(Promise.all(runnableQueues.map(async ([name, queue]) => [name, await queue.getJobCounts()])), 2_000, 'Bull queue health probe');
            const info = Object.fromEntries(counts.map(([name, value]) => [name, value]));
            const depth = (value) => {
                if (!value || typeof value !== 'object')
                    return Number.MAX_SAFE_INTEGER;
                return Object.values(value)
                    .reduce((total, count) => total + (typeof count === 'number' ? count : 0), 0);
            };
            const deadLetter = info['dead-letter'];
            const healthy = Object.values(info).every(count => depth(count) < 10_000)
                && depth(deadLetter) === 0;
            this.logger.debug(`Bull queue health depths: ${JSON.stringify(Object.fromEntries(Object.entries(info).map(([name, value]) => [name, depth(value)])))}`);
            return this.healthIndicatorStatus(key, healthy, {});
        }
        catch {
            return this.healthIndicatorStatus(key, false, { message: 'queue health check unavailable' });
        }
    }
    healthIndicatorStatus(key, healthy, info) {
        return healthy ? { [key]: { status: 'up', ...info } } : { [key]: { status: 'down', ...info } };
    }
    checkWebhooks() {
        return this.health.check([
            () => this.webhookInboxIndicator.isHealthy('webhooks'),
        ]);
    }
    checkCrons() {
        return this.health.check([
            () => this.cronIndicator.isHealthy('crons'),
        ]);
    }
};
exports.HealthController = HealthController;
__decorate([
    (0, common_1.Get)(),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 10 } }),
    (0, terminus_2.HealthCheck)(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], HealthController.prototype, "check", null);
__decorate([
    (0, common_1.Get)('internal-ready'),
    (0, throttler_1.SkipThrottle)(),
    __param(0, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], HealthController.prototype, "internalReady", null);
__decorate([
    (0, common_1.Get)('webhooks'),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 10 } }),
    (0, terminus_2.HealthCheck)(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], HealthController.prototype, "checkWebhooks", null);
__decorate([
    (0, common_1.Get)('crons'),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 10 } }),
    (0, terminus_2.HealthCheck)(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], HealthController.prototype, "checkCrons", null);
exports.HealthController = HealthController = HealthController_1 = __decorate([
    (0, public_decorator_1.Public)(),
    (0, common_1.Controller)('health'),
    __param(12, (0, common_1.Optional)()),
    __param(12, (0, bull_1.InjectQueue)(email_processor_1.EMAIL_QUEUE)),
    __param(13, (0, common_1.Optional)()),
    __param(13, (0, bull_1.InjectQueue)(notification_processor_1.NOTIFICATION_QUEUE)),
    __param(14, (0, common_1.Optional)()),
    __param(14, (0, bull_1.InjectQueue)(audit_log_service_1.AUDIT_LOG_QUEUE)),
    __param(15, (0, common_1.Optional)()),
    __param(15, (0, bull_1.InjectQueue)(queue_constants_1.DEAD_LETTER_QUEUE)),
    __metadata("design:paramtypes", [terminus_2.HealthCheckService,
        terminus_2.PrismaHealthIndicator,
        RedisHealthIndicator,
        DiskHealthIndicator,
        CronHealthIndicator,
        MidtransHealthIndicator,
        R2HealthIndicator,
        SmtpHealthIndicator,
        WebhookInboxHealthIndicator,
        prisma_service_1.PrismaService,
        config_1.ConfigService,
        redis_service_1.RedisService, Object, Object, Object, Object])
], HealthController);
let HealthModule = class HealthModule {
};
exports.HealthModule = HealthModule;
exports.HealthModule = HealthModule = __decorate([
    (0, common_1.Module)({
        imports: [terminus_1.TerminusModule],
        controllers: [HealthController],
        providers: [
            RedisHealthIndicator,
            DiskHealthIndicator,
            CronHealthIndicator,
            MidtransHealthIndicator,
            R2HealthIndicator,
            SmtpHealthIndicator,
            WebhookInboxHealthIndicator,
        ],
    })
], HealthModule);
