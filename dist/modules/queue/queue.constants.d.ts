export declare const DEAD_LETTER_QUEUE = "dead-letter";
export declare const QUEUE_JOB_TIMEOUT_MS = 120000;
export declare function deadLetterJobId(originalQueue: string, jobId: string | number): string;
