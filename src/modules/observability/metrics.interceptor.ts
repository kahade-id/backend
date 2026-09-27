/**
 * Kahade — interceptor metrik request (G482 audit 2026-09-26).
 *
 * Didaftarkan global via APP_INTERCEPTOR di ObservabilityModule. Mengukur
 * latency wall-clock tiap request HTTP dan meneruskannya ke MetricsService
 * (yang memfilter hanya route kunci) + ErrorSpikeTracker untuk detektor
 * alert login/OTP (G485).
 *
 * Sinyal error login/OTP: request ke /v1/auth/* yang berakhir 4xx/5xx —
 * dicatat per kategori `login` (login, refresh, register) dan `otp`
 * (otp request/verify/trigger). Hanya kegagalan AUTENTIKASI yang dihitung,
 * bukan 404/429 generik, supaya threshold tidak terpicu noise.
 */
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { MetricsService, ErrorSpikeTracker } from './metrics.service';

const LOGIN_PATHS = ['/v1/auth/login', '/v1/auth/refresh', '/v1/auth/register', '/v1/auth/admin/login'];
const OTP_PATHS = [
  '/v1/auth/otp',
  '/v1/auth/phone-otp',
  '/v1/auth/webhooks/fonnte',
  '/v1/auth/request-otp',
  '/v1/auth/verify-otp',
];

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(
    private readonly metrics: MetricsService,
    private readonly spikes: ErrorSpikeTracker,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<{ method: string; path?: string; url: string }>();
    const response = http.getResponse<{ statusCode: number }>();
    const startedAt = Date.now();
    const path = request.path ?? request.url?.split('?')[0] ?? '';
    const method = request.method;

    return next.handle().pipe(
      tap({
        next: () => this.finish(path, method, response.statusCode ?? 200, startedAt),
        error: (err: unknown) => {
          const status =
            typeof (err as { status?: unknown })?.status === 'number'
              ? (err as { status: number }).status
              : 500;
          this.finish(path, method, status, startedAt);
        },
      }),
    );
  }

  private finish(path: string, method: string, status: number, startedAt: number): void {
    const latencyMs = Date.now() - startedAt;
    this.metrics.recordRequest(path, method, status, latencyMs);
    if (status >= 400) {
      if (LOGIN_PATHS.some((p) => path === p || path.startsWith(p + '/'))) {
        this.spikes.record('login');
      }
      if (OTP_PATHS.some((p) => path === p || path.startsWith(p + '/'))) {
        this.spikes.record('otp');
      }
    }
  }
}
