import { WinstonModule } from 'nest-winston';
import * as winston from 'winston';
import { requestContext } from '../../prisma/prisma.service';

/**
 * Winston format that injects `requestId` from AsyncLocalStorage into every log
 * entry, so any service-level `this.logger.log('...')` call automatically carries
 * the correlation id set by RequestIdInterceptor.
 */
const requestIdInjector = winston.format((info) => {
  const store = requestContext.getStore();
  if (store?.requestId && info.requestId === undefined) {
    (info as unknown as { requestId: string }).requestId = store.requestId;
  }
  return info;
});

/**
 * NestJS built-in Logger writes plain text to stdout, which cannot be parsed by
 * log aggregators (ELK, Grafana Loki, Datadog, etc.). Winston outputs structured
 * JSON in production, making logs queryable and alertable.
 *
 * Levels: error > warn > info > http > verbose > debug > silly
 *
 * Usage in main.ts:
 *   import { createWinstonLogger } from './common/logger/winston.logger';
 *   app.useLogger(createWinstonLogger());
 */
export function createWinstonLogger(): ReturnType<typeof WinstonModule.createLogger> {
  const nodeEnv = process.env.NODE_ENV || 'development';
  const isProduction = nodeEnv === 'production' || nodeEnv === 'staging';

  return WinstonModule.createLogger({
    level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
    format: isProduction
      ? winston.format.combine(
          requestIdInjector(),
          winston.format.timestamp(),
          winston.format.errors({ stack: true }),
          winston.format.printf((info) => {
            const redact = (text: unknown): unknown => {
              if (typeof text !== 'string') return text;
              return text
                .replace(/\bNIK[:\s=]+\d{16}\b/gi, 'NIK:****************')
                .replace(/\b(?:account|rekening|norek)[_\s]*(?:number|no)?[:\s=]+\d{10,16}\b/gi, (m) => m.replace(/\d+/, '**********'))
                .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z]{2,}\b/gi, '[EMAIL_REDACTED]')
                .replace(/(?:\+62|62|0)8\d{8,12}\b/g, '[PHONE_REDACTED]')
                .replace(/\b(?:password|passwd|secret|token)[:\s=]+\S+/gi, (m) => m.replace(/[:\s=]+\S+/, '=[REDACTED]'))
                .replace(/\b[A-Z]{2}\d{2}[\s]?[A-Z0-9]{4}[\s]?\d{4}[\s]?\d{4}[\s]?\d{4}[\s]?\d{4}[\s]?\d{0,2}\b/g, '[IBAN_REDACTED]')
                .replace(/\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13})\b/g, '[CARD_REDACTED]');
            };
            if (info.message) info.message = redact(info.message);
            if (info.stack) info.stack = redact(info.stack);
            return JSON.stringify(info);
          }),
        )
      : winston.format.combine(
          requestIdInjector(),
          winston.format.timestamp({ format: 'HH:mm:ss' }),
          winston.format.colorize(),
          winston.format.errors({ stack: true }),
          winston.format.printf(({ timestamp, level, message, context, trace, requestId }) => {
            const redact = (text: string): string => {
              if (typeof text !== 'string') return text;
              return text
                .replace(/\bNIK[:\s=]+\d{16}\b/gi, 'NIK:****************')
                .replace(/\b(?:account|rekening|norek)[_\s]*(?:number|no)?[:\s=]+\d{10,16}\b/gi, (m) => m.replace(/\d+/, '**********'))
                .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z]{2,}\b/gi, '[EMAIL_REDACTED]')
                .replace(/(?:\+62|62|0)8\d{8,12}\b/g, '[PHONE_REDACTED]')
                .replace(/\b(?:password|passwd|secret|token)[:\s=]+\S+/gi, (m) => m.replace(/[:\s=]+\S+/, '=[REDACTED]'))
                .replace(/\b[A-Z]{2}\d{2}[\s]?[A-Z0-9]{4}[\s]?\d{4}[\s]?\d{4}[\s]?\d{4}[\s]?\d{4}[\s]?\d{0,2}\b/g, '[IBAN_REDACTED]')
                .replace(/\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13})\b/g, '[CARD_REDACTED]');
            };
            const msg = redact(message as string);
            const trc = trace ? redact(trace as string) : '';
            const ctx = context ? `[${context}]` : '';
            const rid = requestId ? ` (req=${String(requestId).slice(0, 8)})` : '';
            return `${timestamp} ${level} ${ctx} ${msg}${rid}${trc ? `\n${trc}` : ''}`;
          }),
        ),
    defaultMeta: {
      service: 'kahade-backend',
      env: nodeEnv,
      // If not set, it defaults to 1.0.0. Ensure it's documented in .env.example.
      version: process.env.APP_VERSION || '1.0.0',
    },
    transports: (() => {
      const list: winston.transport[] = [
        new winston.transports.Console({
          handleExceptions: true,
          handleRejections: true,
        }),
      ];

      if (isProduction) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const DailyRotateFile = require('winston-daily-rotate-file');
          list.push(
            new DailyRotateFile({
              filename: 'logs/app-%DATE%.log',
              datePattern: 'YYYY-MM-DD',
              maxSize: '50m',
              maxFiles: 10,
              zippedArchive: true,
              handleExceptions: true,
              handleRejections: true,
            }),
            new DailyRotateFile({
              filename: 'logs/error-%DATE%.log',
              datePattern: 'YYYY-MM-DD',
              maxSize: '50m',
              maxFiles: 10,
              zippedArchive: true,
              level: 'error',
            }),
          );
        } catch {
          // winston-daily-rotate-file not installed; console-only logging
        }
      }

      return list;
    })(),
  });
}
