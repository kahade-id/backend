import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';
import { throwError } from 'rxjs';
import { Request, Response } from 'express';

// B-46 (audit-fix): expand the redaction list to cover everything that can
// land in a request body and might log a credential or PII to disk:
//   - bank account numbers / names (encrypted at rest, but request body is plaintext)
//   - identity numbers (KTP / NIK)
//   - phone numbers passed for OTP requests
//   - signed/idempotency/csrf headers that may be echoed back into a body
//   - private keys, jwt secrets that might leak via copy-paste in support tooling
const REDACT_FIELDS = new Set([
  'password', 'passwd', 'newPassword', 'confirmPassword', 'currentPassword', 'oldPassword',
  'pin', 'walletPin', 'walletPinHash', 'newPin', 'currentPin',
  'cardNumber', 'card_number', 'cvv', 'cvc', 'expiryDate',
  'token', 'accessToken', 'refreshToken', 'secret', 'apiKey', 'api_key', 'privateKey',
  'authorization', 'otp', 'otpCode', 'mfaCode', 'captchaAnswer',
  'backupCode', 'code', 'emailOtpCode',
  'accountNumber', 'account_number', 'accountName', 'beneficiaryAccount', 'beneficiaryName',
  'ktp', 'nik', 'idNumber', 'identityNumber',
  'phoneNumber', 'phone',
  'idempotencyKey', 'idempotency_key', 'csrfToken', 'csrf_token',
]);

function redactBody(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body;
  if (Array.isArray(body)) return body.map(redactBody);
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(body as Record<string, unknown>)) {
    if (REDACT_FIELDS.has(key)) {
      result[key] = '[REDACTED]';
    } else if (val && typeof val === 'object') {
      result[key] = redactBody(val);
    } else {
      result[key] = val;
    }
  }
  return result;
}

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const ctx = context.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();

    const { method, ip } = req;
    const safeUrl = req.path || req.url.split('?')[0];
    const requestId = (req as any).requestId ?? req.headers['x-request-id'] ?? '-';
    const userId = (req as any).user?.id ?? (req as any).admin?.id ?? '-';
    const userAgent = String(req.headers['user-agent'] ?? '-').slice(0, 256).replace(/[\r\n\t]/g, ' ');
    const startTime = Date.now();

    if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
      this.logger.debug(
        `${method} ${safeUrl} body=${JSON.stringify(redactBody(req.body))}`,
      );
    }

    return next.handle().pipe(
      tap(() => {
        const duration = Date.now() - startTime;
        const statusCode = res.statusCode;
        const logData = {
          requestId,
          userId,
          method,
          path: safeUrl,
          statusCode,
          duration,
          ip,
          userAgent,
        };
        this.logger.log(JSON.stringify(logData));
      }),
      catchError((error) => {
        const duration = Date.now() - startTime;
        const statusCode = error?.status ?? 500;
        const logData = {
          requestId,
          userId,
          method,
          path: safeUrl,
          statusCode,
          duration,
          ip,
          error: error?.message ?? 'Unknown error',
        };
        if (statusCode >= 500) {
          this.logger.error(JSON.stringify(logData));
        } else {
          this.logger.warn(JSON.stringify(logData));
        }
        return throwError(() => error);
      }),
    );
  }
}
