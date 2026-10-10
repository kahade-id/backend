import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { Response } from 'express';

/**
 * Batch 139 BE-API2 (item 120): sanitasi atribusi field error validasi sebelum
 * diteruskan ke klien. Hanya entry `{ field: string, messages: string[] }`
 * yang dilewatkan — tanpa target/value (data user) atau metadata internal.
 */
function sanitizeValidationFields(raw: unknown[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const entry of raw.slice(0, 50)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.field !== 'string' || e.field.length > 200) continue;
    const messages = Array.isArray(e.messages)
      ? e.messages.filter((m): m is string => typeof m === 'string').slice(0, 10)
      : [];
    const clean: Record<string, unknown> = { field: e.field, messages };
    if (Array.isArray(e.children)) {
      const children = sanitizeValidationFields(e.children);
      if (children.length > 0) clean.children = children;
    }
    out.push(clean);
  }
  return out;
}

@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const requestId = response.get('X-Request-ID');
    const status = exception.getStatus();
    const exceptionResponse = exception.getResponse();

    let errorCode: string;
    let message: string;
    let details: string[] | undefined;
    let fields: Array<Record<string, unknown>> | undefined;
    let data: Record<string, unknown> | undefined;

    if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
      const resp = exceptionResponse as Record<string, unknown>;
      errorCode = (resp.code as string) || this.getDefaultErrorCode(status);

      if (Array.isArray(resp.message)) {
        message = (resp.message[0] as string) || this.getDefaultMessage(status);
        details = resp.message.length > 1 ? (resp.message as string[]) : undefined;
      } else {
        message = (resp.message as string) || this.getDefaultMessage(status);
      }

      // Batch 139 BE-API2 (item 120): teruskan atribusi field error validasi
      // (dari validation-exception.factory.ts) dengan sanitasi — hanya field
      // + messages bertipe aman yang dilewatkan, maksimal 50 field.
      if (Array.isArray(resp.fields)) {
        const sanitized = sanitizeValidationFields(resp.fields);
        if (sanitized.length > 0) fields = sanitized;
      }
      // BES-01/RK-01 (audit etalase 2026-10-10): state akhir yang disertakan
      // service pada error (mis. 409 SHOWCASE_ALREADY_LIKED → {liked, likeCount})
      // diteruskan sebagai `errors.data` — hanya objek datar bernilai
      // primitif, maks 20 kunci bernama aman.
      if (resp.data && typeof resp.data === 'object' && !Array.isArray(resp.data)) {
        const entries = Object.entries(resp.data as Record<string, unknown>)
          .filter(
            ([key, value]) =>
              /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(key) &&
              (value === null || ['string', 'number', 'boolean'].includes(typeof value)),
          )
          .slice(0, 20);
        if (entries.length > 0) data = Object.fromEntries(entries);
      }
    } else if (typeof exceptionResponse === 'string') {
      errorCode = this.getDefaultErrorCode(status);
      message = exceptionResponse;
    } else {
      errorCode = this.getDefaultErrorCode(status);
      message = this.getDefaultMessage(status);
    }

    const errorBody: Record<string, unknown> = {
      code: errorCode,
      message,
    };
    if (details) {
      errorBody.details = details;
    }
    if (fields) {
      errorBody.fields = fields;
    }
    if (data) {
      errorBody.data = data;
    }
    if (requestId) {
      errorBody.requestId = requestId;
    }
    // ADM-426: 429 selalu membawa Retry-After (header + body) agar klien
    // bisa menampilkan countdown. Nilai dari guard via `retryAfter` (detik).
    if (status === HttpStatus.TOO_MANY_REQUESTS) {
      const retryAfter =
        typeof exceptionResponse === 'object' && exceptionResponse !== null
          ? Number((exceptionResponse as Record<string, unknown>).retryAfter)
          : NaN;
      const seconds = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter) : 60;
      response.setHeader('Retry-After', String(seconds));
      errorBody.retryAfter = seconds;
    }

    response.status(status).json({
      success: false,
      message,
      data: null,
      errors: errorBody,
    });
  }

  private getDefaultErrorCode(status: number): string {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return 'BAD_REQUEST';
      case HttpStatus.UNAUTHORIZED:
        return 'UNAUTHORIZED';
      case HttpStatus.FORBIDDEN:
        return 'FORBIDDEN';
      case HttpStatus.NOT_FOUND:
        return 'NOT_FOUND';
      case HttpStatus.CONFLICT:
        return 'CONFLICT';
      case HttpStatus.UNPROCESSABLE_ENTITY:
        return 'UNPROCESSABLE_ENTITY';
      case HttpStatus.TOO_MANY_REQUESTS:
        return 'RATE_LIMIT_EXCEEDED';
      case HttpStatus.INTERNAL_SERVER_ERROR:
        return 'INTERNAL_SERVER_ERROR';
      case HttpStatus.SERVICE_UNAVAILABLE:
        return 'SERVICE_UNAVAILABLE';
      default:
        return 'UNKNOWN_ERROR';
    }
  }

  private getDefaultMessage(status: number): string {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return 'Bad request';
      case HttpStatus.UNAUTHORIZED:
        return 'Unauthorized';
      case HttpStatus.FORBIDDEN:
        return 'Forbidden';
      case HttpStatus.NOT_FOUND:
        return 'Resource not found';
      case HttpStatus.CONFLICT:
        return 'Conflict';
      case HttpStatus.UNPROCESSABLE_ENTITY:
        return 'Unprocessable entity';
      case HttpStatus.TOO_MANY_REQUESTS:
        return 'Rate limit exceeded';
      case HttpStatus.INTERNAL_SERVER_ERROR:
        return 'Internal server error';
      case HttpStatus.SERVICE_UNAVAILABLE:
        return 'Service unavailable';
      default:
        return 'An error occurred';
    }
  }
}
