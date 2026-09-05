"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RUNTIME_ENV_FILE_ENV = void 0;
exports.getRuntimeEnvFile = getRuntimeEnvFile;
const node_path_1 = require("node:path");
exports.RUNTIME_ENV_FILE_ENV = 'RUNTIME_ENV_FILE';
function getRuntimeEnvFile(env = process.env) {
    const envFile = (env[exports.RUNTIME_ENV_FILE_ENV] ?? '').trim();
    if (!envFile)
        return undefined;
    if (!(0, node_path_1.isAbsolute)(envFile)) {
        throw new Error('STARTUP ABORTED: RUNTIME_ENV_FILE must be an absolute path when configured.');
    }
    return envFile;
}
