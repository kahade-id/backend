export declare enum CircuitState {
    CLOSED = "CLOSED",
    OPEN = "OPEN",
    HALF_OPEN = "HALF_OPEN"
}
export interface CircuitBreakerOptions {
    failureThreshold: number;
    recoveryTimeMs: number;
    halfOpenMaxAttempts: number;
    name: string;
    isTransientError?: (error: unknown) => boolean;
}
export declare class CircuitBreaker {
    private readonly logger;
    private state;
    private failureCount;
    private lastFailureTime;
    private halfOpenAttempts;
    private halfOpenInFlight;
    private readonly options;
    private readonly isTransientError;
    constructor(options?: Partial<CircuitBreakerOptions>);
    getState(): CircuitState;
    execute<T>(fn: () => Promise<T>): Promise<T>;
    private onSuccess;
    private onTransientFailure;
    reset(): void;
}
