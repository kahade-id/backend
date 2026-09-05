"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerCronRuntime = registerCronRuntime;
exports.markCronStarted = markCronStarted;
exports.markCronCompleted = markCronCompleted;
exports.markCronFailed = markCronFailed;
exports.getCronRuntimeSnapshots = getCronRuntimeSnapshots;
exports.resetCronRuntimeSnapshots = resetCronRuntimeSnapshots;
const snapshots = new Map();
function registerCronRuntime(name) {
    if (!snapshots.has(name)) {
        snapshots.set(name, { name, consecutiveFailures: 0, running: false });
    }
}
function markCronStarted(name) {
    registerCronRuntime(name);
    const snapshot = snapshots.get(name);
    snapshot.startedAt = new Date().toISOString();
    snapshot.running = true;
}
function markCronCompleted(name) {
    registerCronRuntime(name);
    const snapshot = snapshots.get(name);
    snapshot.completedAt = new Date().toISOString();
    snapshot.running = false;
    snapshot.consecutiveFailures = 0;
    snapshot.lastError = undefined;
}
function markCronFailed(name, error) {
    registerCronRuntime(name);
    const snapshot = snapshots.get(name);
    snapshot.failedAt = new Date().toISOString();
    snapshot.running = false;
    snapshot.consecutiveFailures += 1;
    snapshot.lastError = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
}
function getCronRuntimeSnapshots() {
    return Array.from(snapshots.values()).map(snapshot => ({ ...snapshot }));
}
function resetCronRuntimeSnapshots() {
    snapshots.clear();
}
