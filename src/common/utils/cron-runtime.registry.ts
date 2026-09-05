export interface CronRuntimeSnapshot {
  name: string;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  consecutiveFailures: number;
  lastError?: string;
  running: boolean;
}

const snapshots = new Map<string, CronRuntimeSnapshot>();

export function registerCronRuntime(name: string): void {
  if (!snapshots.has(name)) {
    snapshots.set(name, { name, consecutiveFailures: 0, running: false });
  }
}

export function markCronStarted(name: string): void {
  registerCronRuntime(name);
  const snapshot = snapshots.get(name)!;
  snapshot.startedAt = new Date().toISOString();
  snapshot.running = true;
}

export function markCronCompleted(name: string): void {
  registerCronRuntime(name);
  const snapshot = snapshots.get(name)!;
  snapshot.completedAt = new Date().toISOString();
  snapshot.running = false;
  snapshot.consecutiveFailures = 0;
  snapshot.lastError = undefined;
}

export function markCronFailed(name: string, error: unknown): void {
  registerCronRuntime(name);
  const snapshot = snapshots.get(name)!;
  snapshot.failedAt = new Date().toISOString();
  snapshot.running = false;
  snapshot.consecutiveFailures += 1;
  snapshot.lastError = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
}

export function getCronRuntimeSnapshots(): CronRuntimeSnapshot[] {
  return Array.from(snapshots.values()).map(snapshot => ({ ...snapshot }));
}

export function resetCronRuntimeSnapshots(): void {
  snapshots.clear();
}
