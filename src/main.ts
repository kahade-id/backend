import './instrument';

(BigInt.prototype as any).toJSON = function () {
  const val = Number(this);
  if (val > Number.MAX_SAFE_INTEGER || val < Number.MIN_SAFE_INTEGER) {
    return this.toString();
  }
  return val;
};

import { NestFactory, Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ValidationPipe, Logger } from '@nestjs/common';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { json, urlencoded } from 'express';
import { getBootstrapMode, getSmokeLoopbackHost } from './smoke/bootstrap-mode';
import { createWinstonLogger } from './common/logger/winston.logger';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { PrismaExceptionFilter } from './common/filters/prisma-exception.filter';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ResponseTransformInterceptor } from './common/interceptors/response-transform.interceptor';
import { RequestIdInterceptor } from './common/interceptors/request-id.interceptor';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { CorsIoAdapter } from './common/adapters/ws.adapter';
import { PrismaService } from './prisma/prisma.service';
import { RedisService } from './redis/redis.service';
import { withTimeout } from './common/utils/background-reliability.util';

const PLACEHOLDER_PATTERNS = ['change_me', 'EXAMPLE', '0123456789abcdef'];

// Secrets that must exist and not contain placeholder values
const REQUIRED_SECRETS: Array<{ env: string; name: string; pattern?: string }> = [
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

// JWT and symmetric key secrets must be at least 32 characters to resist brute-force.
// 256-bit entropy minimum for HS256/HS512 signing keys.
const MIN_SECRET_LENGTH = 64;
const HIGH_ENTROPY_SECRETS: string[] = [
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

function validateSecrets(): void {
  const nodeEnv = process.env.NODE_ENV || 'development';
  const isProdLike = ['production', 'staging'].includes(nodeEnv);

  if (!isProdLike) {
    const placeholderViolations = REQUIRED_SECRETS.filter(({ env, pattern }) => {
      const value = process.env[env];
      if (!value) return false;
      const hasDefaultPlaceholder = PLACEHOLDER_PATTERNS.some(p => value.includes(p));
      const hasSpecificPattern = pattern && value.includes(pattern);
      return hasDefaultPlaceholder || hasSpecificPattern;
    });
    if (placeholderViolations.length > 0) {
      Logger.warn(`Placeholder secrets detected in development: ${placeholderViolations.map(s => s.name).join(', ')}. Replace before deploying.`, 'SecretValidation');
    }
    return;
  }

  const violations: string[] = [];

  for (const { env, name, pattern } of REQUIRED_SECRETS) {
    const value = process.env[env];
    const hasDefaultPlaceholder = value && PLACEHOLDER_PATTERNS.some(p => value.includes(p));
    const hasSpecificPattern = value && pattern && value.includes(pattern);
    if (!value || hasDefaultPlaceholder || hasSpecificPattern) {
      violations.push(name);
    }
  }

  // Verify minimum entropy on signing and encryption keys
  for (const env of HIGH_ENTROPY_SECRETS) {
    const value = process.env[env];
    if (value && value.length < MIN_SECRET_LENGTH) {
      violations.push(`${env} (must be at least ${MIN_SECRET_LENGTH} characters — found ${value.length})`);
    }
  }

  // localhost when running in production, which would indicate a misconfiguration.
  if (nodeEnv === 'production') {
    const corsOrigins = process.env.CORS_ORIGINS ?? '';
    if (corsOrigins.includes('localhost') || corsOrigins.includes('127.0.0.1')) {
      violations.push('CORS_ORIGINS (contains localhost in production)');
    }
  }

  if (violations.length > 0) {
    throw new Error(
      `STARTUP ABORTED: The following secrets are missing, too short, or use insecure placeholder values: ${violations.join(', ')}. ` +
      `Set proper secret values in your environment before deploying to production.`,
    );
  }
}

async function bootstrap(): Promise<void> {
  const bootstrapMode = getBootstrapMode();
  const isReadOnlySmoke = bootstrapMode === 'read-only-smoke';
  const smokeHost = isReadOnlySmoke ? getSmokeLoopbackHost() : undefined;
  const rootModule = isReadOnlySmoke
    ? (await import('./smoke/read-only-smoke.module')).ReadOnlySmokeModule
    : (await import('./app.module')).AppModule;
  if (!isReadOnlySmoke) {
    validateSecrets();
  }
  const app = await NestFactory.create(rootModule);
  if (isReadOnlySmoke) {
    validateSecrets();
  }

  const httpServer = app.getHttpAdapter().getInstance();
  const androidPackage = process.env.ANDROID_APPLICATION_ID || 'id.kahade.frontend';
  const androidFingerprints = (process.env.ANDROID_SHA256_CERT_FINGERPRINTS || 'DD:C8:AB:6F:0F:87:B2:D8:91:57:E9:DF:78:F7:64:F7:EE:0E:7C:9D:5A:FE:F5:68:16:A3:8C:1C:34:8A:E7:A1').split(',').map((value: string) => value.trim()).filter(Boolean);
  httpServer.get('/.well-known/assetlinks.json', (_request: any, response: any) => {
    response.type('application/json').set('Cache-Control', 'public, max-age=86400').send([{
      relation: ['delegate_permission/common.handle_all_urls'],
      target: { namespace: 'android_app', package_name: androidPackage, sha256_cert_fingerprints: androidFingerprints },
    }]);
  });
  httpServer.get('/.well-known/apple-app-site-association', (_request: any, response: any) => {
    const teamId = String(process.env.APPLE_TEAM_ID || '').trim();
    if (!teamId) {
      response.status(503).type('application/json').send({ applinks: { details: [] } });
      return;
    }
    response.type('application/json').set('Cache-Control', 'public, max-age=86400').send({ applinks: { details: [{ appIDs: [`${teamId}.id.kahade.frontend`], components: [{ '/': '/user/*' }, { '/': '/u/*' }, { '/': '/profile/*' }, { '/': '/order/*' }, { '/': '/o/*' }, { '/': '/link/*' }, { '/': '/o-l/*' }, { '/': '/notifications*' }, { '/': '/n/*' }, { '/': '/p/*' }, { '/': '/promo/*' }, { '/': '/v/*' }, { '/': '/voucher/*' }, { '/': '/r/*' }, { '/': '/ref/*' }, { '/': '/referral/*' }, { '/': '/reward/*' }, { '/': '/rewards*' }, { '/': '/badge/*' }, { '/': '/badges*' }, { '/': '/t/*' }, { '/': '/template/*' }, { '/': '/templates*' }, { '/': '/help/*' }, { '/': '/legal/*' }, { '/': '/chat/*' }, { '/': '/d/*' }, { '/': '/dispute/*' }, { '/': '/wallet*' }, { '/': '/withdraw/*' }, { '/': '/inbox' }, { '/': '/orders' }, { '/': '/saved' }, { '/': '/ratings' }, { '/': '/analytics' }, { '/': '/support*' }, { '/': '/settings/*' }, { '/': '/search*' }, { '/': '/new-order' }, { '/': '/v1/deeplinks/*' }] }] } });
  });
  const winstonLogger = createWinstonLogger();
  app.useLogger(winstonLogger);
  const logger = new Logger('Bootstrap');

  const nodeEnv = process.env.NODE_ENV;
  const trustedProxyCidr = process.env.TRUSTED_PROXY_CIDR;
  if ((nodeEnv === 'production' || nodeEnv === 'staging') && !trustedProxyCidr) {
    throw new Error('TRUSTED_PROXY_CIDR must be set in production/staging to prevent IP spoofing via X-Forwarded-For');
  }
  app.getHttpAdapter().getInstance().set('trust proxy', trustedProxyCidr ?? 1);

  // Prisma transactions, and Bull jobs before the process exits on SIGTERM/SIGINT.
  app.enableShutdownHooks();

  // B-033: Tighter body size limits for sensitive endpoints BEFORE global parser
  const tightBodyLimit = json({ limit: '1kb' });
  const pinRoutes = ['/v1/wallet/set-pin', '/v1/wallet/verify-pin', '/v1/auth/verify-otp', '/v1/auth/verify-2fa', '/v1/auth/2fa/setup', '/v1/auth/2fa/enable', '/v1/auth/2fa/disable', '/v1/auth/login'];
  app.use(pinRoutes, tightBodyLimit);

  // Global body size limit — must come AFTER per-route overrides
  app.use(json({ limit: '1mb' }));
  app.use(urlencoded({ extended: true, limit: '1mb' }));

  // B-07 (audit-fix): make CSP `connectSrc` configurable from env so the
  // wildcard subdomain entry is not baked into the binary. The default keeps
  // the previous wildcard behavior to avoid breaking existing rollouts, but
  // operators are encouraged to set CSP_CONNECT_SRC to an exact host list
  // (e.g. "https://api.kahade.id wss://api.kahade.id") in production. Wildcard
  // subdomains permit any future-registered subdomain to be loaded as
  // websocket / fetch target.
  const cspConnectSrcEnv = process.env.CSP_CONNECT_SRC?.trim();
  const connectSrc = cspConnectSrcEnv
    ? ["'self'", ...cspConnectSrcEnv.split(/\s+/).filter(Boolean)]
    : ["'self'", "wss://*.kahade.id", "https://*.kahade.id"];

  // Security middleware
  app.use(helmet({
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
  app.use(compression({ threshold: 5120 }));
  app.use(cookieParser());

  // CORS configuration
  // has spaces after commas (e.g. "https://kahade.id, https://app.kahade.id").
  const nodeEnvForCors = process.env.NODE_ENV || 'development';
  // Refuse to start in production/staging without an explicit CORS allow-list
  // — silently defaulting to localhost would mask a misconfiguration.
  if (!process.env.CORS_ORIGINS && ['production', 'staging'].includes(nodeEnvForCors)) {
    throw new Error('STARTUP ABORTED: CORS_ORIGINS must be set in production/staging.');
  }
  const rawCorsOrigins = process.env.CORS_ORIGINS?.split(',').map(o => o.trim()).filter(Boolean) || ['http://localhost:3001'];
  if (['production', 'staging'].includes(nodeEnvForCors)) {
    // Reject empty allow-list after trim/filter — `CORS_ORIGINS=" , "` would
    // otherwise pass the env-presence check above and silently start a server
    // that rejects every browser request.
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
    origin: (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
      // B-06 (audit-fix): undefined Origin is intentionally allowed for native
      // mobile clients (React Native / Expo native fetch does not send Origin)
      // and server-to-server health-checks. CSRF risk is mitigated upstream
      // because all state-mutating endpoints require a bearer Authorization
      // token (sameSite=strict cookies are not used) plus an X-CSRF-Token where
      // applicable -- a cross-site page cannot read or send the bearer token.
      if (!origin) return cb(null, true);
      if (origin === 'null') return cb(new Error('CORS: null origin not allowed'), false);
      if (rawCorsOrigins.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS: origin ${origin} not allowed`), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID', 'Idempotency-Key', 'X-2FA-Code', 'X-CSRF-Token'],
  });

  if (!isReadOnlySmoke) {
    app.useWebSocketAdapter(new CorsIoAdapter(app, rawCorsOrigins));
  }

  // Global prefix
  const apiPrefix = process.env.API_PREFIX || 'v1';
  app.setGlobalPrefix(apiPrefix);

  // Global pipes
  const { SanitizeBodyPipe } = await import('./common/pipes/sanitize-body.pipe');
  app.useGlobalPipes(
    new SanitizeBodyPipe(),
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  // Global interceptors
  const reflector = app.get(Reflector);
  app.useGlobalInterceptors(
    new RequestIdInterceptor(),
    new LoggingInterceptor(),
    new ResponseTransformInterceptor(reflector),
  );

  // NestJS executes filters in LIFO order; PrismaExceptionFilter catches Prisma-specific
  // errors before they fall through to HttpExceptionFilter.
  app.useGlobalFilters(
    new AllExceptionsFilter(app.get(ConfigService)),
    new PrismaExceptionFilter(),
    new HttpExceptionFilter(),
  );

  const swaggerEnabled = !isReadOnlySmoke && (
    process.env.NODE_ENV === 'development' ||
    (process.env.NODE_ENV !== 'production' && !!process.env.SWAGGER_ALLOWLIST)
  );

  if (swaggerEnabled) {
    const swaggerAllowlist = (process.env.SWAGGER_ALLOWLIST ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    const wildcardEntries = swaggerAllowlist.filter(entry => {
      if (entry === '*' || entry === '0.0.0.0/0' || entry === '::/0') return true;
      // Reject any CIDR with /0 prefix regardless of network address (e.g. 10.0.0.0/0)
      const slash = entry.indexOf('/');
      if (slash !== -1) {
        const prefix = parseInt(entry.slice(slash + 1), 10);
        if (prefix === 0) return true;
      }
      return false;
    });
    if (wildcardEntries.length > 0) {
      throw new Error(
        `SWAGGER_ALLOWLIST must not contain wildcard entries (${wildcardEntries.join(', ')}). ` +
        `Specify explicit IPs or narrow CIDR ranges only.`,
      );
    }

    if (swaggerAllowlist.length > 0) {
      /** Convert a dotted-decimal IPv4 string to a 32-bit unsigned integer. */
      const ipToUint32 = (ip: string): number => {
        const parts = ip.split('.').map(Number);
        if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) return NaN;
        return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
      };

      /** Test whether an IPv4 string falls within a CIDR range using correct bitmask arithmetic. */
      const matchesCidr = (ip: string, cidr: string): boolean => {
        const slash = cidr.indexOf('/');
        if (slash === -1) return ip === cidr; // plain IP, exact match
        const prefix = parseInt(cidr.slice(slash + 1), 10);
        if (isNaN(prefix) || prefix < 0 || prefix > 32) return false;
        const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
        const network = ipToUint32(cidr.slice(0, slash));
        const addr = ipToUint32(ip);
        if (isNaN(network) || isNaN(addr)) return false;
        return (addr & mask) === (network & mask);
      };

      const httpAdapter = app.getHttpAdapter().getInstance();
      // Apply the allowlist guard to /docs and its JSON/assets sub-paths.
      const docsGuard = (
        req: { ip?: string; socket?: { remoteAddress?: string } },
        res: { status: (code: number) => { end: (msg: string) => void } },
        next: () => void,
      ) => {
        const raw = (req.ip ?? req.socket?.remoteAddress ?? '');
        // Strip IPv4-mapped IPv6 prefix (::ffff:192.0.2.1 → 192.0.2.1)
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

    const { SwaggerModule, DocumentBuilder } = await import('@nestjs/swagger');
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

  const configService = app.get(ConfigService);
  const port = configService.get<number>('app.port') ?? 3000;
  const server = isReadOnlySmoke
    ? await app.listen(port, smokeHost!)
    : await app.listen(port);

  // PM2 wait_ready must mean the process can actually serve and coordinate
  // background work, not merely that the socket has bound successfully.
  const [, redisResult] = await withTimeout(
    Promise.all([
      app.get(PrismaService).$queryRaw`SELECT 1`,
      app.get(RedisService).getClient().ping(),
    ]),
    5_000,
    'startup dependency readiness probe',
  );
  if (redisResult !== 'PONG') throw new Error('STARTUP ABORTED: Redis did not return PONG');
  process.send?.('ready'); // PM2 wait_ready signal
  logger.log(
    isReadOnlySmoke
      ? `KAHADE Backend read-only smoke running on ${smokeHost}:${port}; queue, scheduler, websocket, and business modules are disabled.`
      : `KAHADE Backend running on port ${port} [${process.env.NODE_ENV || 'development'}]`,
  );

  const shutdownTimeoutMs = configService.get<number>('app.shutdownTimeoutMs') ?? 30000;
  let isShuttingDown = false;

  const gracefulShutdown = async (signal: string) => {
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
    } catch (err) {
      logger.error('Error during graceful shutdown', (err as Error).stack);
      clearTimeout(forceShutdownTimer);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
}
process.on('unhandledRejection', (reason) => {
  const logger = new Logger('UnhandledRejection');
  logger.error('Unhandled promise rejection — marking process unhealthy for supervisor recovery', reason instanceof Error ? reason.stack : reason);
  // A rejected background promise can leave a worker in an unknown state. Do
  // not silently keep serving traffic; PM2/container supervisors can restart it.
  process.exitCode = 1;
});

process.on('uncaughtException', (err) => {
  const logger = new Logger('UncaughtException');
  logger.error('Uncaught exception — shutting down', err.stack);
  process.exit(1);
});

bootstrap().catch((err) => {
  // Startup-time failure (config validation, port bind, etc.) — fail-fast with non-zero exit.
  // eslint-disable-next-line no-console
  console.error('FATAL: bootstrap() failed:', err);
  process.exit(1);
});
