import { Controller, Get, Header, Param, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { UsersService } from '../users/users.service';
import { OrderLinksService } from '../orders/order-links.service';

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function appSchemeUrl(path: string): string {
  return `kahade-frontend://${path.replace(/^\/+/, '')}`;
}

const USERNAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9_-]|\.(?=[a-zA-Z0-9])){2,29}$/;
const PUBLIC_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

function page({ title, description, appUrl, detail }: { title: string; description: string; appUrl: string; detail: string }): string {
  const safeTitle = escapeHtml(title);
  const safeDescription = escapeHtml(description);
  const safeDetail = escapeHtml(detail);
  const encodedAppUrl = JSON.stringify(appUrl);
  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="noindex,nofollow" />
<meta property="og:title" content="${safeTitle}" />
<meta property="og:description" content="${safeDescription}" />
<title>${safeTitle} · Kahade</title>
<style>
body{margin:0;background:#f7f7f8;color:#18181b;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}
main{max-width:520px;width:100%;background:#fff;border-radius:20px;padding:28px;box-shadow:0 10px 35px rgba(24,24,27,.1)}
h1{font-size:24px;margin:0 0 12px}p{line-height:1.55;color:#52525b}.detail{padding:16px;border-radius:12px;background:#f4f4f5;margin:20px 0;white-space:pre-wrap}.actions{display:flex;gap:12px;flex-wrap:wrap}a{display:inline-block;padding:13px 18px;border-radius:10px;text-decoration:none;font-weight:700}.primary{background:#18181b;color:#fff}.secondary{background:#e4e4e7;color:#18181b}.muted{font-size:13px;color:#71717a;margin-top:20px}
</style>
<script>window.setTimeout(function(){try{window.location.href=${encodedAppUrl}}catch(e){}},180)</script>
</head>
<body><main><h1>${safeTitle}</h1><p>${safeDescription}</p><div class="detail">${safeDetail}</div><div class="actions"><a class="primary" href="${escapeHtml(appUrl)}">Buka di aplikasi Kahade</a><a class="secondary" href="https://kahade.id/">Lanjutkan di Kahade Web</a></div><p class="muted">Jika aplikasi belum terpasang, halaman ini tetap dapat dibuka di browser. Setelah aplikasi dipasang, buka link ini kembali.</p></main></body>
</html>`;
}

@Controller('deeplinks')
export class DeepLinksController {
  constructor(
    private readonly usersService: UsersService,
    private readonly orderLinksService: OrderLinksService,
  ) {}

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @Get('user/:username')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async profile(@Param('username') username: string, @Res() response: Response): Promise<void> {
    const safeUsername = String(username ?? '').trim().toLowerCase();
    if (!USERNAME_RE.test(safeUsername)) {
      response.status(404).send(page({ title: 'Profil tidak ditemukan', description: 'Profil publik Kahade tidak tersedia.', appUrl: appSchemeUrl('u/invalid'), detail: 'Username pada tautan tidak valid.' }));
      return;
    }
    let detail = `Profil publik @${safeUsername}`;
    let title = `Profil @${safeUsername}`;
    try {
      const profile = await this.usersService.getPublicProfile(safeUsername);
      const record = profile as Record<string, unknown>;
      title = String(record.fullName ?? record.username ?? title);
      detail = `@${String(record.username ?? safeUsername)}\n${String(record.bio ?? 'Profil publik Kahade')}`;
    } catch {
      detail = `Profil @${safeUsername} belum dapat dimuat. Buka aplikasi untuk melihat status terbaru.`;
    }
    response.status(200).send(page({ title, description: 'Profil publik Kahade.', appUrl: appSchemeUrl(`u/${encodeURIComponent(safeUsername)}`), detail }));
  }

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @Get('profile/:username')
  async profileAlias(@Param('username') username: string, @Res() response: Response): Promise<void> {
    return this.profile(username, response);
  }

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @Get('order-link/:token')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async orderLink(@Param('token') token: string, @Res() response: Response): Promise<void> {
    const safeToken = String(token ?? '').trim();
    if (!PUBLIC_ID_RE.test(safeToken)) {
      response.status(404).send(page({ title: 'Tautan tidak ditemukan', description: 'Tautan transaksi Kahade tidak tersedia.', appUrl: appSchemeUrl('o-l/invalid'), detail: 'Token tautan tidak valid.' }));
      return;
    }
    let title = 'Tautan transaksi Kahade';
    let detail = 'Tinjau detail tautan transaksi di aplikasi Kahade.';
    try {
      const link = await this.orderLinksService.getLinkByToken(safeToken);
      const record = link as Record<string, unknown>;
      title = String(record.title ?? title);
      detail = `${String(record.description ?? 'Tautan escrow Kahade')}\nNilai: Rp ${String(record.orderValue ?? '—')}\nPembuat: ${String((record.creator as Record<string, unknown> | undefined)?.username ?? 'Pengguna Kahade')}`;
    } catch {
      detail = 'Tautan ini mungkin sudah kedaluwarsa, dibatalkan, atau sudah digunakan. Buka aplikasi untuk mendapatkan status terbaru.';
    }
    response.status(200).send(page({ title, description: 'Tautan transaksi escrow Kahade.', appUrl: appSchemeUrl(`o-l/${encodeURIComponent(safeToken)}`), detail }));
  }

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @Get('order/:orderId')
  @Header('Content-Type', 'text/html; charset=utf-8')
  order(@Param('orderId') orderId: string, @Res() response: Response): void {
    const safeId = String(orderId ?? '').trim();
    if (!PUBLIC_ID_RE.test(safeId)) {
      response.status(404).send(page({ title: 'Transaksi tidak ditemukan', description: 'Detail transaksi Kahade tidak tersedia.', appUrl: appSchemeUrl('o/invalid'), detail: 'ID transaksi tidak valid.' }));
      return;
    }
    response.status(200).send(page({ title: 'Detail transaksi Kahade', description: 'Detail transaksi hanya dapat dibuka setelah autentikasi.', appUrl: appSchemeUrl(`o/${encodeURIComponent(safeId)}`), detail: `ID transaksi: ${safeId}\nMasuk ke aplikasi untuk melihat status, pihak buyer/seller, escrow, delivery proof, dan dispute.` }));
  }

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @Get('notification/:notificationId')
  @Header('Content-Type', 'text/html; charset=utf-8')
  notification(@Param('notificationId') notificationId: string, @Res() response: Response): void {
    const safeId = String(notificationId ?? '').trim();
    if (!PUBLIC_ID_RE.test(safeId)) {
      response.status(404).send(page({ title: 'Notifikasi tidak ditemukan', description: 'Notifikasi Kahade tidak tersedia.', appUrl: appSchemeUrl('n/invalid'), detail: 'ID notifikasi tidak valid.' }));
      return;
    }
    response.status(200).send(page({ title: 'Notifikasi Kahade', description: 'Notifikasi akan dibuka di aplikasi Kahade setelah autentikasi.', appUrl: appSchemeUrl(`n/${encodeURIComponent(safeId)}`), detail: `ID notifikasi: ${safeId}` }));
  }
}
