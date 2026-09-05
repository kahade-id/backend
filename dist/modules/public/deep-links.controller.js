"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeepLinksController = void 0;
const common_1 = require("@nestjs/common");
const throttler_1 = require("@nestjs/throttler");
const public_decorator_1 = require("../../common/decorators/public.decorator");
const users_service_1 = require("../users/users.service");
const order_links_service_1 = require("../orders/order-links.service");
function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
function appSchemeUrl(path) {
    return `kahade-frontend://${path.replace(/^\/+/, '')}`;
}
const USERNAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9_-]|\.(?=[a-zA-Z0-9])){2,29}$/;
const PUBLIC_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
function page({ title, description, appUrl, detail }) {
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
let DeepLinksController = class DeepLinksController {
    constructor(usersService, orderLinksService) {
        this.usersService = usersService;
        this.orderLinksService = orderLinksService;
    }
    async profile(username, response) {
        const safeUsername = String(username ?? '').trim().toLowerCase();
        if (!USERNAME_RE.test(safeUsername)) {
            response.status(404).send(page({ title: 'Profil tidak ditemukan', description: 'Profil publik Kahade tidak tersedia.', appUrl: appSchemeUrl('u/invalid'), detail: 'Username pada tautan tidak valid.' }));
            return;
        }
        let detail = `Profil publik @${safeUsername}`;
        let title = `Profil @${safeUsername}`;
        try {
            const profile = await this.usersService.getPublicProfile(safeUsername);
            const record = profile;
            title = String(record.fullName ?? record.username ?? title);
            detail = `@${String(record.username ?? safeUsername)}\n${String(record.bio ?? 'Profil publik Kahade')}`;
        }
        catch {
            detail = `Profil @${safeUsername} belum dapat dimuat. Buka aplikasi untuk melihat status terbaru.`;
        }
        response.status(200).send(page({ title, description: 'Profil publik Kahade.', appUrl: appSchemeUrl(`u/${encodeURIComponent(safeUsername)}`), detail }));
    }
    async profileAlias(username, response) {
        return this.profile(username, response);
    }
    async orderLink(token, response) {
        const safeToken = String(token ?? '').trim();
        if (!PUBLIC_ID_RE.test(safeToken)) {
            response.status(404).send(page({ title: 'Tautan tidak ditemukan', description: 'Tautan transaksi Kahade tidak tersedia.', appUrl: appSchemeUrl('o-l/invalid'), detail: 'Token tautan tidak valid.' }));
            return;
        }
        let title = 'Tautan transaksi Kahade';
        let detail = 'Tinjau detail tautan transaksi di aplikasi Kahade.';
        try {
            const link = await this.orderLinksService.getLinkByToken(safeToken);
            const record = link;
            title = String(record.title ?? title);
            detail = `${String(record.description ?? 'Tautan escrow Kahade')}\nNilai: Rp ${String(record.orderValue ?? '—')}\nPembuat: ${String(record.creator?.username ?? 'Pengguna Kahade')}`;
        }
        catch {
            detail = 'Tautan ini mungkin sudah kedaluwarsa, dibatalkan, atau sudah digunakan. Buka aplikasi untuk mendapatkan status terbaru.';
        }
        response.status(200).send(page({ title, description: 'Tautan transaksi escrow Kahade.', appUrl: appSchemeUrl(`o-l/${encodeURIComponent(safeToken)}`), detail }));
    }
    order(orderId, response) {
        const safeId = String(orderId ?? '').trim();
        if (!PUBLIC_ID_RE.test(safeId)) {
            response.status(404).send(page({ title: 'Transaksi tidak ditemukan', description: 'Detail transaksi Kahade tidak tersedia.', appUrl: appSchemeUrl('o/invalid'), detail: 'ID transaksi tidak valid.' }));
            return;
        }
        response.status(200).send(page({ title: 'Detail transaksi Kahade', description: 'Detail transaksi hanya dapat dibuka setelah autentikasi.', appUrl: appSchemeUrl(`o/${encodeURIComponent(safeId)}`), detail: `ID transaksi: ${safeId}\nMasuk ke aplikasi untuk melihat status, pihak buyer/seller, escrow, delivery proof, dan dispute.` }));
    }
    notification(notificationId, response) {
        const safeId = String(notificationId ?? '').trim();
        if (!PUBLIC_ID_RE.test(safeId)) {
            response.status(404).send(page({ title: 'Notifikasi tidak ditemukan', description: 'Notifikasi Kahade tidak tersedia.', appUrl: appSchemeUrl('n/invalid'), detail: 'ID notifikasi tidak valid.' }));
            return;
        }
        response.status(200).send(page({ title: 'Notifikasi Kahade', description: 'Notifikasi akan dibuka di aplikasi Kahade setelah autentikasi.', appUrl: appSchemeUrl(`n/${encodeURIComponent(safeId)}`), detail: `ID notifikasi: ${safeId}` }));
    }
};
exports.DeepLinksController = DeepLinksController;
__decorate([
    (0, public_decorator_1.Public)(),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 60 } }),
    (0, common_1.Get)('user/:username'),
    (0, common_1.Header)('Content-Type', 'text/html; charset=utf-8'),
    __param(0, (0, common_1.Param)('username')),
    __param(1, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], DeepLinksController.prototype, "profile", null);
__decorate([
    (0, public_decorator_1.Public)(),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 60 } }),
    (0, common_1.Get)('profile/:username'),
    __param(0, (0, common_1.Param)('username')),
    __param(1, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], DeepLinksController.prototype, "profileAlias", null);
__decorate([
    (0, public_decorator_1.Public)(),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 60 } }),
    (0, common_1.Get)('order-link/:token'),
    (0, common_1.Header)('Content-Type', 'text/html; charset=utf-8'),
    __param(0, (0, common_1.Param)('token')),
    __param(1, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], DeepLinksController.prototype, "orderLink", null);
__decorate([
    (0, public_decorator_1.Public)(),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 60 } }),
    (0, common_1.Get)('order/:orderId'),
    (0, common_1.Header)('Content-Type', 'text/html; charset=utf-8'),
    __param(0, (0, common_1.Param)('orderId')),
    __param(1, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], DeepLinksController.prototype, "order", null);
__decorate([
    (0, public_decorator_1.Public)(),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 60 } }),
    (0, common_1.Get)('notification/:notificationId'),
    (0, common_1.Header)('Content-Type', 'text/html; charset=utf-8'),
    __param(0, (0, common_1.Param)('notificationId')),
    __param(1, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], DeepLinksController.prototype, "notification", null);
exports.DeepLinksController = DeepLinksController = __decorate([
    (0, common_1.Controller)('deeplinks'),
    __metadata("design:paramtypes", [users_service_1.UsersService,
        order_links_service_1.OrderLinksService])
], DeepLinksController);
