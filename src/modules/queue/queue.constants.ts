export const DEAD_LETTER_QUEUE = 'dead-letter';

export const QUEUE_JOB_TIMEOUT_MS = 120_000;

/**
 * Bull emits failure callbacks at-least-once. A stable DLQ id makes forwarding
 * idempotent across duplicate failed/stalled events.
 */
export function deadLetterJobId(originalQueue: string, jobId: string | number): string {
  return `${originalQueue}:${String(jobId)}`;
}
