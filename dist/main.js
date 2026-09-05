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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("./instrument");
BigInt.prototype.toJSON = function () {
    const val = Number(this);
    if (val > Number.MAX_SAFE_INTEGER || val < Number.MIN_SAFE_INTEGER) {
        return this.toString();
    }
    return val;
};
const core_1 = require("@nestjs/core");
const config_1 = require("@nestjs/config");
const common_1 = require("@nestjs/common");
const helmet_1 = __importDefault(require("helmet"));
const compression_1 = __importDefault(require("compression"));
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const express_1 = require("express");
const bootstrap_mode_1 = require("./smoke/bootstrap-mode");
const winston_logger_1 = require("./common/logger/winston.logger");
const http_exception_filter_1 = require("./common/filters/http-exception.filter");
const prisma_exception_filter_1 = require("./common/filters/prisma-exception.filter");
const all_exceptions_filter_1 = require("./common/filters/all-exceptions.filter");
const response_transform_interceptor_1 = require("./common/interceptors/response-transform.interceptor");
const request_id_interceptor_1 = require("./common/interceptors/request-id.interceptor");
const logging_interceptor_1 = require("./common/interceptors/logging.interceptor");
const ws_adapter_1 = require("./common/adapters/ws.adapter");
const prisma_service_1 = require("./prisma/prisma.service");
const redis_service_1 = require("./redis/redis.service");
const background_reliability_util_1 = require("./common/utils/background-reliability.util");
const PLACEHOLDER_PATTERNS = ['change_me', 'EXAMPLE', '0123456789abcdef'];
const REQUIRED_SECRETS = [
    { env: 'JWT_SECRET', name: 'JWT_SECRET' },
    { env: 'JWT_REFRESH_SECRET', name: 'JWT_REFRESH_SECRET' },
    { env: 'JWT_ADMIN_SECRET', name: 'JWT_ADMIN_SECRET' },
    { env: 'AES_SECRET_KEY', name: 'AES_SECRET_KEY' },
    { env: 'HMAC_SECRET_KEY', name: 'HMAC_SECRET_KEY' },
    { env: 'JWT_ADMIN_REFRESH_SECRET', name: 'JWT_ADMIN_REFRESH_SECRET' },
    { env: 'JWT_TEMP_SECRET', name: 'JWT_TEMP_SECRET' },
    { env: 'AES_KDF_SALT', name: 'AES_KDF_SALT' },
    { env: 'MIDTRANS_IRIS_KEY', name: 'MIDTRANS_IRIS_KEY', pattern: 'xxxxxxx' },
    { env: 'WALLET_PIN_PEPPER', name: 'WALLET_PIN_PEPPER' },
];
const MIN_SECRET_LENGTH = 64;
const HIGH_ENTROPY_SECRETS = [
    'JWT_SECRET',
    'JWT_REFRESH_SECRET',
    'JWT_ADMIN_SECRET',
    'JWT_ADMIN_REFRESH_SECRET',
    'JWT_TEMP_SECRET',
    'AES_SECRET_KEY',
    'HMAC_SECRET_KEY',
    'AES_KDF_SALT',
    'WALLET_PIN_PEPPER',
];
function validateSecrets() {
    const nodeEnv = process.env.NODE_ENV || 'development';
    const isProdLike = ['production', 'staging'].includes(nodeEnv);
    if (!isProdLike) {
        const placeholderViolations = REQUIRED_SECRETS.filter(({ env, pattern }) => {
            const value = process.env[env];
            if (!value)
                return false;
            const hasDefaultPlaceholder = PLACEHOLDER_PATTERNS.some(p => value.includes(p));
            const hasSpecificPattern = pattern && value.includes(pattern);
            return hasDefaultPlaceholder || hasSpecificPattern;
        });
        if (placeholderViolations.length > 0) {
            common_1.Logger.warn(`Placeholder secrets detected in development: ${placeholderViolations.map(s => s.name).join(', ')}. Replace before deploying.`, 'SecretValidation');
        }
        return;
    }
    const violations = [];
    for (const { env, name, pattern } of REQUIRED_SECRETS) {
        const value = process.env[env];
        const hasDefaultPlaceholder = value && PLACEHOLDER_PATTERNS.some(p => value.includes(p));
        const hasSpecificPattern = value && pattern && value.includes(pattern);
        if (!value || hasDefaultPlaceholder || hasSpecificPattern) {
            violations.push(name);
        }
    }
    for (const env of HIGH_ENTROPY_SECRETS) {
        const value = process.env[env];
        if (value && value.length < MIN_SECRET_LENGTH) {
            violations.push(`${env} (must be at least ${MIN_SECRET_LENGTH} characters — found ${value.length})`);
        }
    }
    if (nodeEnv === 'production') {
        const corsOrigins = process.env.CORS_ORIGINS ?? '';
        if (corsOrigins.includes('localhost') || corsOrigins.includes('127.0.0.1')) {
            violations.push('CORS_ORIGINS (contains localhost in production)');
        }
    }
    if (violations.length > 0) {
        throw new Error(`STARTUP ABORTED: The following secrets are missing, too short, or use insecure placeholder values: ${violations.join(', ')}. ` +
            `Set proper secret values in your environment before deploying to production.`);
    }
}
async function bootstrap() {
    const bootstrapMode = (0, bootstrap_mode_1.getBootstrapMode)();
    const isReadOnlySmoke = bootstrapMode === 'read-only-smoke';
    const smokeHost = isReadOnlySmoke ? (0, bootstrap_mode_1.getSmokeLoopbackHost)() : undefined;
    const rootModule = isReadOnlySmoke
        ? (await Promise.resolve().then(() => __importStar(require('./smoke/read-only-smoke.module')))).ReadOnlySmokeModule
        : (await Promise.resolve().then(() => __importStar(require('./app.module')))).AppModule;
    if (!isReadOnlySmoke) {
        validateSecrets();
    }
    const app = await core_1.NestFactory.create(rootModule);
    if (isReadOnlySmoke) {
        validateSecrets();
    }
    const httpServer = app.getHttpAdapter().getInstance();
    const androidPackage = process.env.ANDROID_APPLICATION_ID || 'id.kahade.frontend';
    const androidFingerprints = (process.env.ANDROID_SHA256_CERT_FINGERPRINTS || 'DD:C8:AB:6F:0F:87:B2:D8:91:57:E9:DF:78:F7:64:F7:EE:0E:7C:9D:5A:FE:F5:68:16:A3:8C:1C:34:8A:E7:A1').split(',').map((value) => value.trim()).filter(Boolean);
    httpServer.get('/.well-known/assetlinks.json', (_request, response) => {
        response.type('application/json').set('Cache-Control', 'public, max-age=86400').send([{
                relation: ['delegate_permission/common.handle_all_urls'],
                target: { namespace: 'android_app', package_name: androidPackage, sha256_cert_fingerprints: androidFingerprints },
            }]);
    });
    httpServer.get('/.well-known/apple-app-site-association', (_request, response) => {
        const teamId = String(process.env.APPLE_TEAM_ID || '').trim();
        if (!teamId) {
            response.status(503).type('application/json').send({ applinks: { details: [] } });
            return;
        }
        response.type('application/json').set('Cache-Control', 'public, max-age=86400').send({ applinks: { details: [{ appIDs: [`${teamId}.id.kahade.frontend`], components: [{ '/': '/user/*' }, { '/': '/u/*' }, { '/': '/profile/*' }, { '/': '/order/*' }, { '/': '/o/*' }, { '/': '/link/*' }, { '/': '/o-l/*' }, { '/': '/notifications*' }, { '/': '/n/*' }, { '/': '/p/*' }, { '/': '/promo/*' }, { '/': '/v/*' }, { '/': '/voucher/*' }, { '/': '/r/*' }, { '/': '/ref/*' }, { '/': '/referral/*' }, { '/': '/reward/*' }, { '/': '/rewards*' }, { '/': '/badge/*' }, { '/': '/badges*' }, { '/': '/t/*' }, { '/': '/template/*' }, { '/': '/templates*' }, { '/': '/help/*' }, { '/': '/legal/*' }, { '/': '/chat/*' }, { '/': '/d/*' }, { '/': '/dispute/*' }, { '/': '/wallet*' }, { '/': '/withdraw/*' }, { '/': '/inbox' }, { '/': '/orders' }, { '/': '/saved' }, { '/': '/ratings' }, { '/': '/analytics' }, { '/': '/support*' }, { '/': '/settings/*' }, { '/': '/search*' }, { '/': '/new-order' }, { '/': '/v1/deeplinks/*' }] }] } });
    });
    const winstonLogger = (0, winston_logger_1.createWinstonLogger)();
    app.useLogger(winstonLogger);
    const logger = new common_1.Logger('Bootstrap');
    const nodeEnv = process.env.NODE_ENV;
    const trustedProxyCidr = process.env.TRUSTED_PROXY_CIDR;
    if ((nodeEnv === 'production' || nodeEnv === 'staging') && !trustedProxyCidr) {
        throw new Error('TRUSTED_PROXY_CIDR must be set in production/staging to prevent IP spoofing via X-Forwarded-For');
    }
    app.getHttpAdapter().getInstance().set('trust proxy', trustedProxyCidr ?? 1);
    app.enableShutdownHooks();
    const tightBodyLimit = (0, express_1.json)({ limit: '1kb' });
    const pinRoutes = ['/v1/wallet/set-pin', '/v1/wallet/verify-pin', '/v1/auth/verify-otp', '/v1/auth/verify-2fa', '/v1/auth/2fa/setup', '/v1/auth/2fa/enable', '/v1/auth/2fa/disable', '/v1/auth/login'];
    app.use(pinRoutes, tightBodyLimit);
    app.use((0, express_1.json)({ limit: '1mb' }));
    app.use((0, express_1.urlencoded)({ extended: true, limit: '1mb' }));
    const cspConnectSrcEnv = process.env.CSP_CONNECT_SRC?.trim();
    const connectSrc = cspConnectSrcEnv
        ? ["'self'", ...cspConnectSrcEnv.split(/\s+/).filter(Boolean)]
        : ["'self'", "wss://*.kahade.id", "https://*.kahade.id"];
    app.use((0, helmet_1.default)({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'none'"],
                scriptSrc: ["'none'"],
                connectSrc,
                objectSrc: ["'none'"],
                frameAncestors: ["'none'"],
                formAction: ["'none'"],
                baseUri: ["'none'"],
            },
        },
        hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
        referrerPolicy: { policy: 'no-referrer' },
    }));
    app.use((0, compression_1.default)({ threshold: 5120 }));
    app.use((0, cookie_parser_1.default)());
    const nodeEnvForCors = process.env.NODE_ENV || 'development';
    if (!process.env.CORS_ORIGINS && ['production', 'staging'].includes(nodeEnvForCors)) {
        throw new Error('STARTUP ABORTED: CORS_ORIGINS must be set in production/staging.');
    }
    const rawCorsOrigins = process.env.CORS_ORIGINS?.split(',').map(o => o.trim()).filter(Boolean) || ['http://localhost:3001'];
    if (['production', 'staging'].includes(nodeEnvForCors)) {
        if (process.env.CORS_ORIGINS && rawCorsOrigins.length === 0) {
            throw new Error('STARTUP ABORTED: CORS_ORIGINS is set but parsed to an empty list. Provide at least one origin.');
        }
        if (rawCorsOrigins.some(o => o.trim() === '*')) {
            throw new Error('STARTUP ABORTED: CORS_ORIGINS must not contain wildcards (*) in production/staging.');
        }
        const httpOrigins = rawCorsOrigins.filter(o => !o.trim().startsWith('https://') && !o.includes('localhost'));
        if (httpOrigins.length > 0) {
            logger.warn(`CORS warning: non-HTTPS origins in ${nodeEnvForCors}: ${httpOrigins.join(', ')}`);
        }
    }
    app.enableCors({
        origin: (origin, cb) => {
            if (!origin)
                return cb(null, true);
            if (origin === 'null')
                return cb(new Error('CORS: null origin not allowed'), false);
            if (rawCorsOrigins.includes(origin))
                return cb(null, true);
            return cb(new Error(`CORS: origin ${origin} not allowed`), false);
        },
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID', 'Idempotency-Key', 'X-2FA-Code', 'X-CSRF-Token'],
    });
    if (!isReadOnlySmoke) {
        app.useWebSocketAdapter(new ws_adapter_1.CorsIoAdapter(app, rawCorsOrigins));
    }
    const apiPrefix = process.env.API_PREFIX || 'v1';
    app.setGlobalPrefix(apiPrefix);
    const { SanitizeBodyPipe } = await Promise.resolve().then(() => __importStar(require('./common/pipes/sanitize-body.pipe')));
    app.useGlobalPipes(new SanitizeBodyPipe(), new common_1.ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: false },
    }));
    const reflector = app.get(core_1.Reflector);
    app.useGlobalInterceptors(new request_id_interceptor_1.RequestIdInterceptor(), new logging_interceptor_1.LoggingInterceptor(), new response_transform_interceptor_1.ResponseTransformInterceptor(reflector));
    app.useGlobalFilters(new all_exceptions_filter_1.AllExceptionsFilter(app.get(config_1.ConfigService)), new prisma_exception_filter_1.PrismaExceptionFilter(), new http_exception_filter_1.HttpExceptionFilter());
    const swaggerEnabled = !isReadOnlySmoke && (process.env.NODE_ENV === 'development' ||
        (process.env.NODE_ENV !== 'production' && !!process.env.SWAGGER_ALLOWLIST));
    if (swaggerEnabled) {
        const swaggerAllowlist = (process.env.SWAGGER_ALLOWLIST ?? '')
            .split(',')
            .map(s => s.trim())
            .filter(Boolean);
        const wildcardEntries = swaggerAllowlist.filter(entry => {
            if (entry === '*' || entry === '0.0.0.0/0' || entry === '::/0')
                return true;
            const slash = entry.indexOf('/');
            if (slash !== -1) {
                const prefix = parseInt(entry.slice(slash + 1), 10);
                if (prefix === 0)
                    return true;
            }
            return false;
        });
        if (wildcardEntries.length > 0) {
            throw new Error(`SWAGGER_ALLOWLIST must not contain wildcard entries (${wildcardEntries.join(', ')}). ` +
                `Specify explicit IPs or narrow CIDR ranges only.`);
        }
        if (swaggerAllowlist.length > 0) {
            const ipToUint32 = (ip) => {
                const parts = ip.split('.').map(Number);
                if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255))
                    return NaN;
                return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
            };
            const matchesCidr = (ip, cidr) => {
                const slash = cidr.indexOf('/');
                if (slash === -1)
                    return ip === cidr;
                const prefix = parseInt(cidr.slice(slash + 1), 10);
                if (isNaN(prefix) || prefix < 0 || prefix > 32)
                    return false;
                const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
                const network = ipToUint32(cidr.slice(0, slash));
                const addr = ipToUint32(ip);
                if (isNaN(network) || isNaN(addr))
                    return false;
                return (addr & mask) === (network & mask);
            };
            const httpAdapter = app.getHttpAdapter().getInstance();
            const docsGuard = (req, res, next) => {
                const raw = (req.ip ?? req.socket?.remoteAddress ?? '');
                const remoteIp = raw.replace(/^::ffff:/, '');
                const allowed = swaggerAllowlist.some(entry => matchesCidr(remoteIp, entry));
                if (!allowed) {
                    res.status(403).end('Forbidden');
                    return;
                }
                next();
            };
            httpAdapter.use('/docs', docsGuard);
            httpAdapter.use('/docs-json', docsGuard);
            logger.log(`Swagger /docs restricted to: ${swaggerAllowlist.join(', ')}`);
        }
        const { SwaggerModule, DocumentBuilder } = await Promise.resolve().then(() => __importStar(require('@nestjs/swagger')));
        const swaggerConfig = new DocumentBuilder()
            .setTitle('Kahade API')
            .setDescription('PT Kawal Hak Dengan Aman — Platform Escrow P2C Indonesia')
            .setVersion('1.0')
            .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'access-token')
            .addCookieAuth('refresh_token', { type: 'apiKey', in: 'cookie', name: 'kahade_refresh_token' })
            .addTag('auth', 'Authentication & Authorization')
            .addTag('users', 'User Profile & Stats')
            .addTag('wallet', 'Wallet & Transactions')
            .addTag('orders', 'Escrow Orders')
            .addTag('payments', 'Payment Webhooks')
            .addTag('health', 'Health Checks')
            .build();
        const document = SwaggerModule.createDocument(app, swaggerConfig);
        SwaggerModule.setup('docs', app, document);
        logger.log('Swagger docs available at /docs');
    }
    const configService = app.get(config_1.ConfigService);
    const port = configService.get('app.port') ?? 3000;
    const server = isReadOnlySmoke
        ? await app.listen(port, smokeHost)
        : await app.listen(port);
    const [, redisResult] = await (0, background_reliability_util_1.withTimeout)(Promise.all([
        app.get(prisma_service_1.PrismaService).$queryRaw `SELECT 1`,
        app.get(redis_service_1.RedisService).getClient().ping(),
    ]), 5_000, 'startup dependency readiness probe');
    if (redisResult !== 'PONG')
        throw new Error('STARTUP ABORTED: Redis did not return PONG');
    process.send?.('ready');
    logger.log(isReadOnlySmoke
        ? `KAHADE Backend read-only smoke running on ${smokeHost}:${port}; queue, scheduler, websocket, and business modules are disabled.`
        : `KAHADE Backend running on port ${port} [${process.env.NODE_ENV || 'development'}]`);
    const shutdownTimeoutMs = configService.get('app.shutdownTimeoutMs') ?? 30000;
    let isShuttingDown = false;
    const gracefulShutdown = async (signal) => {
        if (isShuttingDown) {
            logger.warn(`Received ${signal} during shutdown — ignoring (already shutting down)`);
            return;
        }
        isShuttingDown = true;
        logger.log(`Received ${signal} — starting graceful shutdown (timeout: ${shutdownTimeoutMs}ms)`);
        server.close(() => {
            logger.log('HTTP server closed — no new connections accepted');
        });
        const forceShutdownTimer = setTimeout(() => {
            logger.error('Graceful shutdown timed out — forcing exit');
            process.exit(1);
        }, shutdownTimeoutMs);
        forceShutdownTimer.unref();
        try {
            await app.close();
            logger.log('Application closed successfully');
            clearTimeout(forceShutdownTimer);
            process.exit(0);
        }
        catch (err) {
            logger.error('Error during graceful shutdown', err.stack);
            clearTimeout(forceShutdownTimer);
            process.exit(1);
        }
    };
    process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
}
process.on('unhandledRejection', (reason) => {
    const logger = new common_1.Logger('UnhandledRejection');
    logger.error('Unhandled promise rejection — marking process unhealthy for supervisor recovery', reason instanceof Error ? reason.stack : reason);
    process.exitCode = 1;
});
process.on('uncaughtException', (err) => {
    const logger = new common_1.Logger('UncaughtException');
    logger.error('Uncaught exception — shutting down', err.stack);
    process.exit(1);
});
bootstrap().catch((err) => {
    console.error('FATAL: bootstrap() failed:', err);
    process.exit(1);
});
