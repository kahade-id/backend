"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.QUEUE_JOB_TIMEOUT_MS = exports.DEAD_LETTER_QUEUE = void 0;
exports.deadLetterJobId = deadLetterJobId;
exports.DEAD_LETTER_QUEUE = 'dead-letter';
exports.QUEUE_JOB_TIMEOUT_MS = 120_000;
function deadLetterJobId(originalQueue, jobId) {
    return `${originalQueue}:${String(jobId)}`;
}
