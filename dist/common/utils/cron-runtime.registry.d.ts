export interface CronRuntimeSnapshot {
    name: string;
    startedAt?: string;
    completedAt?: string;
    failedAt?: string;
    consecutiveFailures: number;
    lastError?: string;
    running: boolean;
}
export declare function registerCronRuntime(name: string): void;
export declare function markCronStarted(name: string): void;
export declare function markCronCompleted(name: string): void;
export declare function markCronFailed(name: string, error: unknown): void;
export declare function getCronRuntimeSnapshots(): CronRuntimeSnapshot[];
export declare function resetCronRuntimeSnapshots(): void;
