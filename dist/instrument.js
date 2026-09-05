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
const Sentry = __importStar(require("@sentry/nestjs"));
const profiling_node_1 = require("@sentry/profiling-node");
const PII_PATTERNS = [
    { re: /\b\d{16}\b/g, replacement: '[NIK_REDACTED]' },
    { re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replacement: '[EMAIL_REDACTED]' },
    { re: /\b(?:\+62|62|0)8\d{8,12}\b/g, replacement: '[PHONE_REDACTED]' },
    { re: /password[:=]\s*\S+/gi, replacement: 'password:[REDACTED]' },
    { re: /\b[A-Z]{2}\d{2}[\s]?[A-Z0-9]{4}[\s]?\d{4}[\s]?\d{4}[\s]?\d{4}[\s]?\d{4}[\s]?\d{0,2}\b/g, replacement: '[IBAN_REDACTED]' },
    { re: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13})\b/g, replacement: '[CARD_REDACTED]' },
];
function scrubPiiString(str) {
    if (!str)
        return str;
    let result = str;
    for (const { re, replacement } of PII_PATTERNS) {
        result = result.replace(re, replacement);
    }
    return result;
}
if (process.env.SENTRY_DSN) {
    Sentry.init({
        dsn: process.env.SENTRY_DSN,
        environment: process.env.NODE_ENV ?? 'development',
        enabled: ['production', 'staging'].includes(process.env.NODE_ENV ?? ''),
        tracesSampleRate: (() => {
            const raw = parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE ?? (['production', 'staging'].includes(process.env.NODE_ENV ?? '') ? '0.1' : '0'));
            if (!Number.isFinite(raw))
                return 0;
            return Math.min(1, Math.max(0, raw));
        })(),
        integrations: [
            (0, profiling_node_1.nodeProfilingIntegration)(),
        ],
        beforeSend(event) {
            if (event.message) {
                event.message = scrubPiiString(event.message);
            }
            if (event.exception?.values) {
                for (const exc of event.exception.values) {
                    exc.value = scrubPiiString(exc.value);
                }
            }
            if (event.breadcrumbs) {
                for (const bc of event.breadcrumbs) {
                    if (bc.message)
                        bc.message = scrubPiiString(bc.message);
                }
            }
            if (event.request) {
                if (event.request.url) {
                    event.request.url = event.request.url.split('?')[0];
                }
                if (event.request.query_string) {
                    event.request.query_string = '[REDACTED]';
                }
                delete event.request.cookies;
                if (event.request.headers) {
                    delete event.request.headers['authorization'];
                    delete event.request.headers['cookie'];
                    delete event.request.headers['x-csrf-token'];
                }
                if (event.request.data && typeof event.request.data === 'string') {
                    event.request.data = scrubPiiString(event.request.data);
                }
            }
            return event;
        },
    });
}
