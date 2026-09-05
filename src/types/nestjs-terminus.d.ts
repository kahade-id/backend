declare module '@nestjs/terminus' {
  import { DynamicModule } from '@nestjs/common';
  import { PrismaClient } from '@prisma/client';

  export interface HealthIndicatorResult {
    [key: string]: {
      status: 'up' | 'down';
      [key: string]: unknown;
    };
  }

  export interface HealthCheckResult {
    status: 'ok' | 'error' | 'shutting_down';
    info?: Record<string, { status: 'up' | 'down'; [key: string]: unknown }>;
    error?: Record<string, { status: 'up' | 'down'; [key: string]: unknown }>;
    details: Record<string, { status: 'up' | 'down'; [key: string]: unknown }>;
  }

  export class HealthIndicator {
    protected getStatus(
      key: string,
      isHealthy: boolean,
      data?: Record<string, unknown>,
    ): HealthIndicatorResult;
  }

  export class HealthCheckService {
    check(
      indicators: Array<() => Promise<HealthIndicatorResult>>,
    ): Promise<HealthCheckResult>;
  }

  export class PrismaHealthIndicator {
    pingCheck(key: string, prisma: PrismaClient): Promise<HealthIndicatorResult>;
  }

  export function HealthCheck(): MethodDecorator;

  export interface TerminusModuleOptions {
    errorLogStyle?: 'pretty' | 'json';
    gracefulShutdownTimeoutMs?: number;
    logger?: boolean;
  }

  export class TerminusModule {
    static forRoot(options?: TerminusModuleOptions): DynamicModule;
    static forRootAsync(options: unknown): DynamicModule;
    static register(options?: TerminusModuleOptions): DynamicModule;
  }
}
