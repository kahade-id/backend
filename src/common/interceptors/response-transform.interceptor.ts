import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Decimal } from '@prisma/client/runtime/library';
import { ALLOW_RESPONSE_FIELDS_KEY } from '../decorators/allow-response-fields.decorator';

/**
 * Standard API response envelope.
 *
 * All API responses are wrapped in this format by `ResponseTransformInterceptor`.
 *
 * Shape:
 * ```json
 * {
 *   "success": true,
 *   "message": "Success",
 *   "data": { ... } | null,
 *   "errors": null
 * }
 * ```
 *
 * On error (handled by exception filters):
 * ```json
 * {
 *   "success": false,
 *   "message": "Error description",
 *   "data": null,
 *   "errors": { ... } | null
 * }
 * ```
 */
export interface ApiResponse<T> {
  success: boolean;
  message: string;
  data: T | null;
  errors: null;
}

const SENSITIVE_FIELDS = new Set([
  'password',
  'passwordHash',
  'walletPin',
  'walletPinHash',
  'ktpNumber',
  'ktpNumberHash',
  'accountNumber',
  'accountNumberHash',
  'otpSecret',
  'mfaSecret',
  'twoFactorSecret',
  'refreshToken',
  'secret',
  'backupCodes',
  'pushToken',
  'ktpPhotoUrl',
  // Paired with ktpPhotoUrl: both hold AES-encrypted S3 keys for private KYC
  // documents. Only ktpPhotoUrl was listed, so a handler that returned a whole
  // KycRequest row would strip the KTP photo but pass the selfie through. No
  // current handler does (both submit paths project explicit fields), which is
  // exactly why this belongs in the deny-list — it is the backstop for the day
  // one of them starts returning the full record.
  'selfiePhotoUrl',
]);

@Injectable()
export class ResponseTransformInterceptor<T> implements NestInterceptor<T, ApiResponse<T>> {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<ApiResponse<T>> {
    const allowedFields = this.reflector.get<string[] | undefined>(
      ALLOW_RESPONSE_FIELDS_KEY,
      context.getHandler(),
    );
    const allowSet = allowedFields ? new Set(allowedFields) : null;

    return next.handle().pipe(
      map((data): ApiResponse<T> => {
        const serializedData = this.serializeBigInt(data, allowSet);

        if (serializedData && typeof serializedData === 'object' && 'success' in serializedData) {
          return serializedData as ApiResponse<T>;
        }

        if (serializedData === null || serializedData === undefined) {
          return {
            success: true as const,
            message: 'Success',
            data: null,
            errors: null,
          };
        }

        if (typeof serializedData === 'string') {
          return {
            success: true as const,
            message: serializedData,
            data: null,
            errors: null,
          };
        }

        return {
          success: true as const,
          message: 'Success',
          data: serializedData as T,
          errors: null,
        };
      }),
    );
  }

  private static readonly MAX_DEPTH = 12;

  private serializeBigInt(data: unknown, allowSet: Set<string> | null, depth = 0): unknown {
    if (data === null || data === undefined) {
      return data;
    }

    if (depth > ResponseTransformInterceptor.MAX_DEPTH) {
      return '[max depth]';
    }

    if (typeof data === 'bigint') {
      return data.toString();
    }

    if (data instanceof Date) {
      return Number.isNaN(data.getTime()) ? null : data.toISOString();
    }

    if (data instanceof Decimal) {
      return data.toNumber();
    }

    if (Array.isArray(data)) {
      return data.map(item => this.serializeBigInt(item, allowSet, depth + 1));
    }

    if (typeof data === 'object') {
      const serialized: Record<string, unknown> = {};
      for (const key in data) {
        if (Object.prototype.hasOwnProperty.call(data, key)) {
          if (SENSITIVE_FIELDS.has(key) && (!allowSet || !allowSet.has(key))) continue;
          serialized[key] = this.serializeBigInt((data as Record<string, unknown>)[key], allowSet, depth + 1);
        }
      }
      return serialized;
    }

    return data;
  }
}
