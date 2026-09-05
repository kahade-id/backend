"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SMOKE_ENV_FILE_ENV = exports.SMOKE_MODE_ENV = void 0;
exports.getBootstrapMode = getBootstrapMode;
exports.selectRootModule = selectRootModule;
exports.getSmokeLoopbackHost = getSmokeLoopbackHost;
exports.getSmokeEnvFile = getSmokeEnvFile;
exports.SMOKE_MODE_ENV = 'SMOKE_MODE';
exports.SMOKE_ENV_FILE_ENV = 'SMOKE_ENV_FILE';
function getBootstrapMode(env = process.env) {
    return env[exports.SMOKE_MODE_ENV] === 'true' ? 'read-only-smoke' : 'normal';
}
function selectRootModule(mode, normalModule, smokeModule) {
    return mode === 'read-only-smoke' ? smokeModule : normalModule;
}
function getSmokeLoopbackHost(env = process.env) {
    const host = (env.HOST ?? '').trim().toLowerCase();
    const permittedHosts = new Set(['127.0.0.1', '::1', 'localhost']);
    if (!permittedHosts.has(host)) {
        throw new Error('STARTUP ABORTED: SMOKE_MODE=true requires HOST to be one of 127.0.0.1, ::1, or localhost. ' +
            'Smoke mode must not accept network traffic.');
    }
    return host;
}
function getSmokeEnvFile(env = process.env) {
    const envFile = (env[exports.SMOKE_ENV_FILE_ENV] ?? '').trim();
    if (!envFile.startsWith('/')) {
        throw new Error('STARTUP ABORTED: SMOKE_MODE=true requires SMOKE_ENV_FILE to be an absolute path to the existing runtime configuration.');
    }
    return envFile;
}
