"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.databaseConfig = void 0;
const config_1 = require("@nestjs/config");
exports.databaseConfig = (0, config_1.registerAs)('database', () => {
    const baseUrl = process.env.DATABASE_URL || '';
    if (!baseUrl) {
        throw new Error('DATABASE_URL environment variable is required');
    }
    const url = new URL(baseUrl);
    if (!url.searchParams.has('connection_limit')) {
        url.searchParams.set('connection_limit', process.env.DB_POOL_SIZE || '20');
    }
    if (!url.searchParams.has('pool_timeout')) {
        url.searchParams.set('pool_timeout', process.env.DB_POOL_TIMEOUT || '10');
    }
    if (!url.searchParams.has('connect_timeout')) {
        url.searchParams.set('connect_timeout', process.env.DB_CONNECT_TIMEOUT || '15');
    }
    if (!url.searchParams.has('statement_timeout')) {
        url.searchParams.set('statement_timeout', process.env.DB_STATEMENT_TIMEOUT || '30000');
    }
    return {
        url: url.toString(),
        poolSize: parseInt(process.env.DB_POOL_SIZE || '20', 10),
        poolTimeout: parseInt(process.env.DB_POOL_TIMEOUT || '10', 10),
        statementTimeout: parseInt(process.env.DB_STATEMENT_TIMEOUT || '30000', 10),
    };
});
