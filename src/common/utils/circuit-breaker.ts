import { Logger, ServiceUnavailableException } from '@nestjs/common';

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export interface CircuitBreakerOptions {
  failureThreshold: number;
  recoveryTimeMs: number;
  halfOpenMaxAttempts: number;
  name: string;
  isTransientError?: (error: unknown) => boolean;
}

function defaultIsTransientError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return true;

  const err = error as Record<string, unknown>;

  const status = (err as any)?.status ?? (err as any)?.statusCode ?? (err as any)?.response?.statusCode;
  if (typeof status === 'number') {
    if (status >= 400 && status < 500) return false;
  }

  const code = (err as any)?.response?.code ?? (err as any)?.code;
  if (typeof code === 'string') {
    const businessCodes = [
      'BANK_ACCOUNT_NOT_FOUND',
      'CARD_TOKEN_REQUIRED',
      'INVALID_PAYMENT_METHOD',
    ];
    if (businessCodes.includes(code)) return false;
  }

  const name = (err as any)?.name;
  if (name === 'BadRequestException' || name === 'NotFoundException' || name === 'ForbiddenException') {
    return false;
  }

  return true;
}

const DEFAULT_OPTIONS: CircuitBreakerOptions = {
  failureThreshold: 5,
  recoveryTimeMs: 30_000,
  halfOpenMaxAttempts: 1,
  name: 'CircuitBreaker',
};

export class CircuitBreaker {
  private readonly logger: Logger;
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount = 0;
  private lastFailureTime = 0;
  private halfOpenAttempts = 0;
  private halfOpenInFlight = false;
  private readonly options: CircuitBreakerOptions;
  private readonly isTransientError: (error: unknown) => boolean;

  constructor(options?: Partial<CircuitBreakerOptions>) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.isTransientError = this.options.isTransientError ?? defaultIsTransientError;
    this.logger = new Logger(this.options.name);
  }

  getState(): CircuitState {
    return this.state;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === CircuitState.OPEN) {
      if (Date.now() - this.lastFailureTime >= this.options.recoveryTimeMs) {
        this.state = CircuitState.HALF_OPEN;
        this.halfOpenAttempts = 0;
        this.halfOpenInFlight = false;
        this.logger.warn(`${this.options.name}: Circuit transitioning from OPEN to HALF_OPEN`);
      } else {
        throw new ServiceUnavailableException({
          code: 'SERVICE_CIRCUIT_OPEN',
          message: 'Service temporarily unavailable. Please try again later.',
        });
      }
    }

    if (this.state === CircuitState.HALF_OPEN) {
      if (this.halfOpenInFlight || this.halfOpenAttempts >= this.options.halfOpenMaxAttempts) {
        throw new ServiceUnavailableException({
          code: 'SERVICE_CIRCUIT_OPEN',
          message: 'Service temporarily unavailable. Please try again later.',
        });
      }
      this.halfOpenInFlight = true;
      this.halfOpenAttempts++;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      if (this.isTransientError(error)) {
        this.onTransientFailure();
      } else {
        if (this.state === CircuitState.HALF_OPEN) {
          this.onSuccess();
        }
      }
      throw error;
    }
  }

  private onSuccess(): void {
    if (this.state === CircuitState.HALF_OPEN) {
      this.logger.log(`${this.options.name}: Circuit transitioning from HALF_OPEN to CLOSED`);
    }
    this.failureCount = 0;
    this.halfOpenAttempts = 0;
    this.halfOpenInFlight = false;
    this.state = CircuitState.CLOSED;
  }

  private onTransientFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === CircuitState.HALF_OPEN) {
      this.halfOpenInFlight = false;
      this.state = CircuitState.OPEN;
      this.logger.error(
        `${this.options.name}: Circuit transitioning from HALF_OPEN to OPEN after probe failure`,
      );
      return;
    }

    if (this.failureCount >= this.options.failureThreshold) {
      this.state = CircuitState.OPEN;
      this.logger.error(
        `${this.options.name}: Circuit OPENED after ${this.failureCount} consecutive failures`,
      );
    }
  }

  reset(): void {
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.halfOpenAttempts = 0;
    this.halfOpenInFlight = false;
    this.logger.log(`${this.options.name}: Circuit manually reset to CLOSED`);
  }
}
