"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.createWinstonLogger = createWinstonLogger;
const nest_winston_1 = require("nest-winston");
const winston = __importStar(require("winston"));
const prisma_service_1 = require("../../prisma/prisma.service");
const requestIdInjector = winston.format((info) => {
    const store = prisma_service_1.requestContext.getStore();
    if (store?.requestId && info.requestId === undefined) {
        info.requestId = store.requestId;
    }
    return info;
});
function createWinstonLogger() {
    const nodeEnv = process.env.NODE_ENV || 'development';
    const isProduction = nodeEnv === 'production' || nodeEnv === 'staging';
    return nest_winston_1.WinstonModule.createLogger({
        level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
        format: isProduction
            ? winston.format.combine(requestIdInjector(), winston.format.timestamp(), winston.format.errors({ stack: true }), winston.format.printf((info) => {
                const redact = (text) => {
                    if (typeof text !== 'string')
                        return text;
                    return text
                        .replace(/\bNIK[:\s=]+\d{16}\b/gi, 'NIK:****************')
                        .replace(/\b(?:account|rekening|norek)[_\s]*(?:number|no)?[:\s=]+\d{10,16}\b/gi, (m) => m.replace(/\d+/, '**********'))
                        .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z]{2,}\b/gi, '[EMAIL_REDACTED]')
                        .replace(/(?:\+62|62|0)8\d{8,12}\b/g, '[PHONE_REDACTED]')
                        .replace(/\b(?:password|passwd|secret|token)[:\s=]+\S+/gi, (m) => m.replace(/[:\s=]+\S+/, '=[REDACTED]'))
                        .replace(/\b[A-Z]{2}\d{2}[\s]?[A-Z0-9]{4}[\s]?\d{4}[\s]?\d{4}[\s]?\d{4}[\s]?\d{4}[\s]?\d{0,2}\b/g, '[IBAN_REDACTED]')
                        .replace(/\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13})\b/g, '[CARD_REDACTED]');
                };
                if (info.message)
                    info.message = redact(info.message);
                if (info.stack)
                    info.stack = redact(info.stack);
                return JSON.stringify(info);
            }))
            : winston.format.combine(requestIdInjector(), winston.format.timestamp({ format: 'HH:mm:ss' }), winston.format.colorize(), winston.format.errors({ stack: true }), winston.format.printf(({ timestamp, level, message, context, trace, requestId }) => {
                const redact = (text) => {
                    if (typeof text !== 'string')
                        return text;
                    return text
                        .replace(/\bNIK[:\s=]+\d{16}\b/gi, 'NIK:****************')
                        .replace(/\b(?:account|rekening|norek)[_\s]*(?:number|no)?[:\s=]+\d{10,16}\b/gi, (m) => m.replace(/\d+/, '**********'))
                        .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z]{2,}\b/gi, '[EMAIL_REDACTED]')
                        .replace(/(?:\+62|62|0)8\d{8,12}\b/g, '[PHONE_REDACTED]')
                        .replace(/\b(?:password|passwd|secret|token)[:\s=]+\S+/gi, (m) => m.replace(/[:\s=]+\S+/, '=[REDACTED]'))
                        .replace(/\b[A-Z]{2}\d{2}[\s]?[A-Z0-9]{4}[\s]?\d{4}[\s]?\d{4}[\s]?\d{4}[\s]?\d{4}[\s]?\d{0,2}\b/g, '[IBAN_REDACTED]')
                        .replace(/\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13})\b/g, '[CARD_REDACTED]');
                };
                const msg = redact(message);
                const trc = trace ? redact(trace) : '';
                const ctx = context ? `[${context}]` : '';
                const rid = requestId ? ` (req=${String(requestId).slice(0, 8)})` : '';
                return `${timestamp} ${level} ${ctx} ${msg}${rid}${trc ? `\n${trc}` : ''}`;
            })),
        defaultMeta: {
            service: 'kahade-backend',
            env: nodeEnv,
            version: process.env.APP_VERSION || '1.0.0',
        },
        transports: (() => {
            const list = [
                new winston.transports.Console({
                    handleExceptions: true,
                    handleRejections: true,
                }),
            ];
            if (isProduction) {
                try {
                    const DailyRotateFile = require('winston-daily-rotate-file');
                    list.push(new DailyRotateFile({
                        filename: 'logs/app-%DATE%.log',
                        datePattern: 'YYYY-MM-DD',
                        maxSize: '50m',
                        maxFiles: 10,
                        zippedArchive: true,
                        handleExceptions: true,
                        handleRejections: true,
                    }), new DailyRotateFile({
                        filename: 'logs/error-%DATE%.log',
                        datePattern: 'YYYY-MM-DD',
                        maxSize: '50m',
                        maxFiles: 10,
                        zippedArchive: true,
                        level: 'error',
                    }));
                }
                catch {
                }
            }
            return list;
        })(),
    });
}
