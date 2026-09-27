import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { OpsSettingsService } from './ops-settings.service';

/**
 * Item 9 (batch 2026-09-28) — Middleware mode maintenance global.
 *
 * Bila MAINTENANCE_MODE = "true" di app_settings (via OpsSettingsService,
 * cache 60 dtk), SEMUA request non-admin dijawab:
 *   503 + header Retry-After + body { message }
 *
 * Dikecualikan (tetap bisa diakses saat maintenance):
 * - /v1/admin/*               → admin panel harus tetap bisa mematikan maintenance
 * - /v1/public/maintenance    → splash check tanpa auth
 * - /v1/health                → health check infra / load balancer
 * - /.well-known/*            → verifikasi platform (mis. Apple app-site-association)
 *
 * Default: off (key kosong / "false" → next()).
 * Didaftarkan di main.ts via app.use (bukan MiddlewareConsumer) agar berlaku
 * sebelum semua route termasuk yang tidak lewat guard.
 */
@Injectable()
export class MaintenanceMiddleware implements NestMiddleware {
  private readonly logger = new Logger(MaintenanceMiddleware.name);

  constructor(private readonly settings: OpsSettingsService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    let enabled = false;
    try {
      enabled = this.settings.get('MAINTENANCE_MODE')?.trim().toLowerCase() === 'true';
    } catch {
      // Gagal baca setting (mis. DB belum migrasi) → fail-open ke perilaku normal,
      // jangan matikan API karena kesalahan baca flag.
      return next();
    }
    if (!enabled) return next();

    if (MaintenanceMiddleware.isExempt(req.path)) return next();

    const message =
      this.settings.get('MAINTENANCE_MESSAGE')?.trim() ||
      'Layanan Kahade sedang dalam maintenance. Silakan coba lagi beberapa saat lagi.';
    this.logger.warn(`Maintenance 503 untuk ${req.method} ${req.path}`);
    res
      .status(503)
      .set('Retry-After', String(MaintenanceMiddleware.RETRY_AFTER_SECONDS))
      .json({ message });
  }

  static readonly RETRY_AFTER_SECONDS = 300;

  /** Cek path — dukung global prefix (default "v1") maupun path tanpa prefix. */
  static isExempt(rawPath: string): boolean {
    const path = rawPath || '/';
    // Buang segmen pertama (global prefix, default "v1") bila ada.
    const candidates = [path, path.replace(/^\/[^/]+/, '') || '/'];
    return candidates.some((p) => {
      if (p === '/admin' || p.startsWith('/admin/')) return true;
      if (p === '/public/maintenance') return true;
      if (p === '/health') return true;
      if (p === '/.well-known' || p.startsWith('/.well-known/')) return true;
      return false;
    });
  }
}
