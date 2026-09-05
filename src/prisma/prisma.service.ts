import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { AsyncLocalStorage } from 'async_hooks';

export const requestContext = new AsyncLocalStorage<{ requestId: string }>();

type NotificationCreatedCallback = (data: { userId: string; title: string; body: string; data?: Record<string, string> }) => void | Promise<void>;

const isProduction = process.env.NODE_ENV === 'production';
const connectionLimit = parseInt(process.env.DATABASE_CONNECTION_LIMIT || (isProduction ? '10' : '5'), 10);
const datasourceUrl = (() => {
  const raw = process.env.DATABASE_URL;
  if (!raw) return undefined;
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
  } catch {
    const sep = raw.includes('?') ? '&' : '?';
    const poolTimeout = process.env.DB_POOL_TIMEOUT || '10';
    const connectTimeout = process.env.DB_CONNECT_TIMEOUT || '15';
    const stmtTimeout = process.env.DB_STATEMENT_TIMEOUT || '30000';
    return `${raw}${sep}connection_limit=${connectionLimit}&pool_timeout=${poolTimeout}&connect_timeout=${connectTimeout}&statement_timeout=${stmtTimeout}`;
  }
})();

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private notificationCreatedCallbacks: NotificationCreatedCallback[] = [];
  private _extendedClient: unknown;

  constructor() {
    super({
      ...(datasourceUrl ? { datasources: { db: { url: datasourceUrl } } } : {}),
    });
  }

  get extended(): PrismaClient {
    return (this._extendedClient ?? this) as PrismaClient;
  }

  onNotificationCreated(callback: NotificationCreatedCallback): void {
    if (!this.notificationCreatedCallbacks.includes(callback)) {
      this.notificationCreatedCallbacks.push(callback);
    }
  }

  emitNotificationCreated(data: { userId: string; title: string; body: string; data?: Record<string, string> }): void {
    for (const cb of this.notificationCreatedCallbacks) {
      try {
        const result = cb(data);
        if (result instanceof Promise) {
          result.catch((err: unknown) => {
            this.logger.error(`Notification callback error: ${(err as Error).message}`);
          });
        }
      } catch (err) {
        this.logger.error(`Notification callback error: ${(err as Error).message}`);
      }
    }
  }

  async onModuleInit(): Promise<void> {
    this.applyExtension();
    this.applyRequestIdMiddleware();
    if (process.env.OPENAPI_GENERATE === 'true') {
      this.logger.warn('OPENAPI_GENERATE=true — skipping database connection for contract generation');
      return;
    }
    await this.$connect();
    try {
      await (this as any).$executeRaw`SET statement_timeout = '30s'`;
      this.logger.log('Database statement_timeout set to 30s');
    } catch (err) {
      this.logger.warn(`Failed to set statement_timeout: ${(err as Error).message}. Configure via DATABASE_URL: ?options=-c%20statement_timeout%3D30000`);
    }
    this.logPoolConfig();
    this.validateSoftDeleteModels();
  }

  private logPoolConfig(): void {
    const poolTimeout = process.env.DB_POOL_TIMEOUT || '10';
    const connectTimeout = process.env.DB_CONNECT_TIMEOUT || '15';
    const stmtTimeout = process.env.DB_STATEMENT_TIMEOUT || '30000';
    this.logger.log(
      `Database pool config: connection_limit=${connectionLimit}, ` +
      `pool_timeout=${poolTimeout}s, connect_timeout=${connectTimeout}s, ` +
      `statement_timeout=${stmtTimeout}ms, ` +
      `env=${isProduction ? 'production' : 'development'}`,
    );
  }

  private applyRequestIdMiddleware(): void {
    (this as any).$use(async (params: any, next: (params: any) => Promise<any>) => {
      const ctx = requestContext.getStore();
      const reqId = ctx?.requestId;
      const start = Date.now();
      try {
        const result = await next(params);
        const duration = Date.now() - start;
        if (duration > 1000) {
          this.logger.warn(
            `Slow query: ${params.model}.${params.action} took ${duration}ms` +
            (reqId ? ` [reqId=${reqId}]` : ''),
          );
        }
        return result;
      } catch (error) {
        const duration = Date.now() - start;
        this.logger.error(
          `Query failed: ${params.model}.${params.action} after ${duration}ms` +
          (reqId ? ` [reqId=${reqId}]` : '') +
          ` — ${(error as Error).message}`,
        );
        throw error;
      }
    });
  }

  private validateSoftDeleteModels(): void {
    const SOFT_DELETE_MODELS = ['User', 'BankAccount', 'AdminUser', 'ChatMessage'];
    // Prisma 5 exposes the datamodel as the static `Prisma.dmmf`. The private
    // instance fields this used to read (`_baseDmmf` / `_dmmf`) no longer exist,
    // so the check silently degraded to a warning on every boot and never
    // actually validated anything.
    const dmmf = Prisma.dmmf;
    if (!dmmf?.datamodel?.models) {
      this.logger.warn('Could not validate SOFT_DELETE_MODELS — DMMF not available');
      return;
    }
    const modelNames = new Set(dmmf.datamodel.models.map((m: { name: string }) => m.name));
    for (const name of SOFT_DELETE_MODELS) {
      if (!modelNames.has(name)) {
        this.logger.error(`SOFT_DELETE_MODELS contains unknown model: "${name}". Soft-delete middleware will silently skip it.`);
      } else {
        const model = dmmf.datamodel.models.find((m: { name: string }) => m.name === name);
        const hasDeletedAt = model?.fields?.some((f: { name: string }) => f.name === 'deletedAt');
        if (!hasDeletedAt) {
          this.logger.error(`SOFT_DELETE_MODELS model "${name}" is missing a "deletedAt" field.`);
        }
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (process.env.OPENAPI_GENERATE === 'true') return;
    await this.$disconnect();
  }

  private applyExtension(): void {
    const SOFT_DELETE_MODELS: ReadonlyArray<string> = ['User', 'BankAccount', 'AdminUser', 'ChatMessage'];

    const READ_ACTIONS: ReadonlyArray<string> = [
      'findMany', 'findFirst', 'findUnique', 'count', 'aggregate',
      'groupBy', 'findUniqueOrThrow', 'findFirstOrThrow',
    ];
    const WRITE_ACTIONS: ReadonlyArray<string> = ['update', 'updateMany'];
    const HARD_DELETE_ACTIONS: ReadonlyArray<string> = ['delete', 'deleteMany'];
    const logger = this.logger;

    const extended = (this as unknown as { $extends: (arg: Record<string, unknown>) => unknown }).$extends({
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }: { model: string | undefined; operation: string; args: Record<string, Record<string, unknown>> | undefined; query: (args: unknown) => Promise<unknown> }) {
            if (!model || !SOFT_DELETE_MODELS.includes(model)) {
              return query(args);
            }

            if (READ_ACTIONS.includes(operation)) {
              if (!args) args = {};
              if (!args.where) args.where = {};
              if (args.where.deletedAt === undefined) {
                args.where = { ...args.where, deletedAt: null };
              }
            }

            if (WRITE_ACTIONS.includes(operation)) {
              if (!args) args = {};
              if (!args.where) args.where = {};
              if (args.where.deletedAt === undefined) {
                if (process.env.NODE_ENV === 'development') {
                  logger.debug(`[SoftDeleteGuard] Auto-injecting deletedAt:null on ${model}.${operation}`);
                }
                args.where = { ...args.where, deletedAt: null };
              }
            }

            if (HARD_DELETE_ACTIONS.includes(operation)) {
              logger.error(
                `[SoftDeleteGuard] BLOCKED hard ${operation} on soft-delete model ${model}. ` +
                `Use update with { deletedAt: new Date() } instead.`,
              );
              throw new Error(
                `Hard ${operation} is not allowed on soft-delete model "${model}". ` +
                `Set deletedAt instead.`,
              );
            }

            return query(args);
          },
        },
      },
    });

    this._extendedClient = extended;
    Object.assign(this, extended);

    if (typeof (this as Record<string, unknown>)['$transaction'] !== 'function') {
      throw new Error(
        'PrismaService: $extends() failed — soft-delete middleware is NOT active. ' +
        'This likely means a Prisma version upgrade changed the internal structure. ' +
        'Do NOT start the application without soft-delete protection.',
      );
    }
  }
}
