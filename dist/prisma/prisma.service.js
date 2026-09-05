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
var PrismaService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.PrismaService = exports.requestContext = void 0;
const common_1 = require("@nestjs/common");
const client_1 = require("@prisma/client");
const async_hooks_1 = require("async_hooks");
exports.requestContext = new async_hooks_1.AsyncLocalStorage();
const isProduction = process.env.NODE_ENV === 'production';
const connectionLimit = parseInt(process.env.DATABASE_CONNECTION_LIMIT || (isProduction ? '10' : '5'), 10);
const datasourceUrl = (() => {
    const raw = process.env.DATABASE_URL;
    if (!raw)
        return undefined;
    try {
        const url = new URL(raw);
        if (!url.searchParams.has('connection_limit')) {
            url.searchParams.set('connection_limit', String(connectionLimit));
        }
        if (!url.searchParams.has('pool_timeout')) {
            url.searchParams.set('pool_timeout', process.env.DB_POOL_TIMEOUT || '10');
        }
        if (!url.searchParams.has('connect_timeout')) {
            url.searchParams.set('connect_timeout', process.env.DB_CONNECT_TIMEOUT || '15');
        }
        if (!url.searchParams.has('statement_timeout')) {
            url.searchParams.set('statement_timeout', process.env.DB_STATEMENT_TIMEOUT || '30000');
        }
        return url.toString();
    }
    catch {
        const sep = raw.includes('?') ? '&' : '?';
        const poolTimeout = process.env.DB_POOL_TIMEOUT || '10';
        const connectTimeout = process.env.DB_CONNECT_TIMEOUT || '15';
        const stmtTimeout = process.env.DB_STATEMENT_TIMEOUT || '30000';
        return `${raw}${sep}connection_limit=${connectionLimit}&pool_timeout=${poolTimeout}&connect_timeout=${connectTimeout}&statement_timeout=${stmtTimeout}`;
    }
})();
let PrismaService = PrismaService_1 = class PrismaService extends client_1.PrismaClient {
    constructor() {
        super({
            ...(datasourceUrl ? { datasources: { db: { url: datasourceUrl } } } : {}),
        });
        this.logger = new common_1.Logger(PrismaService_1.name);
        this.notificationCreatedCallbacks = [];
    }
    get extended() {
        return (this._extendedClient ?? this);
    }
    onNotificationCreated(callback) {
        if (!this.notificationCreatedCallbacks.includes(callback)) {
            this.notificationCreatedCallbacks.push(callback);
        }
    }
    emitNotificationCreated(data) {
        for (const cb of this.notificationCreatedCallbacks) {
            try {
                const result = cb(data);
                if (result instanceof Promise) {
                    result.catch((err) => {
                        this.logger.error(`Notification callback error: ${err.message}`);
                    });
                }
            }
            catch (err) {
                this.logger.error(`Notification callback error: ${err.message}`);
            }
        }
    }
    async onModuleInit() {
        this.applyExtension();
        this.applyRequestIdMiddleware();
        if (process.env.OPENAPI_GENERATE === 'true') {
            this.logger.warn('OPENAPI_GENERATE=true — skipping database connection for contract generation');
            return;
        }
        await this.$connect();
        try {
            await this.$executeRaw `SET statement_timeout = '30s'`;
            this.logger.log('Database statement_timeout set to 30s');
        }
        catch (err) {
            this.logger.warn(`Failed to set statement_timeout: ${err.message}. Configure via DATABASE_URL: ?options=-c%20statement_timeout%3D30000`);
        }
        this.logPoolConfig();
        this.validateSoftDeleteModels();
    }
    logPoolConfig() {
        const poolTimeout = process.env.DB_POOL_TIMEOUT || '10';
        const connectTimeout = process.env.DB_CONNECT_TIMEOUT || '15';
        const stmtTimeout = process.env.DB_STATEMENT_TIMEOUT || '30000';
        this.logger.log(`Database pool config: connection_limit=${connectionLimit}, ` +
            `pool_timeout=${poolTimeout}s, connect_timeout=${connectTimeout}s, ` +
            `statement_timeout=${stmtTimeout}ms, ` +
            `env=${isProduction ? 'production' : 'development'}`);
    }
    applyRequestIdMiddleware() {
        this.$use(async (params, next) => {
            const ctx = exports.requestContext.getStore();
            const reqId = ctx?.requestId;
            const start = Date.now();
            try {
                const result = await next(params);
                const duration = Date.now() - start;
                if (duration > 1000) {
                    this.logger.warn(`Slow query: ${params.model}.${params.action} took ${duration}ms` +
                        (reqId ? ` [reqId=${reqId}]` : ''));
                }
                return result;
            }
            catch (error) {
                const duration = Date.now() - start;
                this.logger.error(`Query failed: ${params.model}.${params.action} after ${duration}ms` +
                    (reqId ? ` [reqId=${reqId}]` : '') +
                    ` — ${error.message}`);
                throw error;
            }
        });
    }
    validateSoftDeleteModels() {
        const SOFT_DELETE_MODELS = ['User', 'BankAccount', 'AdminUser', 'ChatMessage'];
        const dmmf = client_1.Prisma.dmmf;
        if (!dmmf?.datamodel?.models) {
            this.logger.warn('Could not validate SOFT_DELETE_MODELS — DMMF not available');
            return;
        }
        const modelNames = new Set(dmmf.datamodel.models.map((m) => m.name));
        for (const name of SOFT_DELETE_MODELS) {
            if (!modelNames.has(name)) {
                this.logger.error(`SOFT_DELETE_MODELS contains unknown model: "${name}". Soft-delete middleware will silently skip it.`);
            }
            else {
                const model = dmmf.datamodel.models.find((m) => m.name === name);
                const hasDeletedAt = model?.fields?.some((f) => f.name === 'deletedAt');
                if (!hasDeletedAt) {
                    this.logger.error(`SOFT_DELETE_MODELS model "${name}" is missing a "deletedAt" field.`);
                }
            }
        }
    }
    async onModuleDestroy() {
        if (process.env.OPENAPI_GENERATE === 'true')
            return;
        await this.$disconnect();
    }
    applyExtension() {
        const SOFT_DELETE_MODELS = ['User', 'BankAccount', 'AdminUser', 'ChatMessage'];
        const READ_ACTIONS = [
            'findMany', 'findFirst', 'findUnique', 'count', 'aggregate',
            'groupBy', 'findUniqueOrThrow', 'findFirstOrThrow',
        ];
        const WRITE_ACTIONS = ['update', 'updateMany'];
        const HARD_DELETE_ACTIONS = ['delete', 'deleteMany'];
        const logger = this.logger;
        const extended = this.$extends({
            query: {
                $allModels: {
                    async $allOperations({ model, operation, args, query }) {
                        if (!model || !SOFT_DELETE_MODELS.includes(model)) {
                            return query(args);
                        }
                        if (READ_ACTIONS.includes(operation)) {
                            if (!args)
                                args = {};
                            if (!args.where)
                                args.where = {};
                            if (args.where.deletedAt === undefined) {
                                args.where = { ...args.where, deletedAt: null };
                            }
                        }
                        if (WRITE_ACTIONS.includes(operation)) {
                            if (!args)
                                args = {};
                            if (!args.where)
                                args.where = {};
                            if (args.where.deletedAt === undefined) {
                                if (process.env.NODE_ENV === 'development') {
                                    logger.debug(`[SoftDeleteGuard] Auto-injecting deletedAt:null on ${model}.${operation}`);
                                }
                                args.where = { ...args.where, deletedAt: null };
                            }
                        }
                        if (HARD_DELETE_ACTIONS.includes(operation)) {
                            logger.error(`[SoftDeleteGuard] BLOCKED hard ${operation} on soft-delete model ${model}. ` +
                                `Use update with { deletedAt: new Date() } instead.`);
                            throw new Error(`Hard ${operation} is not allowed on soft-delete model "${model}". ` +
                                `Set deletedAt instead.`);
                        }
                        return query(args);
                    },
                },
            },
        });
        this._extendedClient = extended;
        Object.assign(this, extended);
        if (typeof this['$transaction'] !== 'function') {
            throw new Error('PrismaService: $extends() failed — soft-delete middleware is NOT active. ' +
                'This likely means a Prisma version upgrade changed the internal structure. ' +
                'Do NOT start the application without soft-delete protection.');
        }
    }
};
exports.PrismaService = PrismaService;
exports.PrismaService = PrismaService = PrismaService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [])
], PrismaService);
