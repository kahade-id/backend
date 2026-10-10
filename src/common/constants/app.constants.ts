const _parsedIdempotencyTtl = parseInt(process.env.IDEMPOTENCY_TTL_SECONDS || '86400', 10);
export const IDEMPOTENCY_TTL = Number.isFinite(_parsedIdempotencyTtl) && _parsedIdempotencyTtl > 0 ? _parsedIdempotencyTtl : 86400;

export const OTP_MAX_ATTEMPTS = 5;
export const OTP_EXPIRES_MINUTES = 5;
export const OTP_LENGTH = 6;

export const RATING_WINDOW_DAYS = 7;
export const RATING_EDIT_WINDOW_DAYS = 7;

export const ACCOUNT_LOCK_MAX_ATTEMPTS = 5;
export const ACCOUNT_LOCK_DURATION_MINUTES = 30;

// Kebijakan password terpusat di src/modules/auth/password-policy.ts
// (min 8 karakter, tanpa syarat complexity, blocklist password umum).
const MIN_BCRYPT_ROUNDS = 12;
const parsedBcryptRounds = parseInt(process.env.BCRYPT_ROUNDS || '12', 10);
const parsedBcryptRoundsAdmin = parseInt(process.env.BCRYPT_ROUNDS_ADMIN || '14', 10);
export const BCRYPT_ROUNDS = Math.max(MIN_BCRYPT_ROUNDS, Number.isFinite(parsedBcryptRounds) ? parsedBcryptRounds : 12);
export const BCRYPT_ROUNDS_ADMIN = Math.max(MIN_BCRYPT_ROUNDS, Number.isFinite(parsedBcryptRoundsAdmin) ? parsedBcryptRoundsAdmin : 14);

export const JWT_USER_EXPIRES_IN = '15m';
export const JWT_ADMIN_EXPIRES_IN = '30m';
export const JWT_REFRESH_EXPIRES_IN = '7d';
export const JWT_TEMP_EXPIRES_IN = '5m';

export const ORDER_MIN_VALUE = 10000;
export const ORDER_MAX_VALUE = 1000000000;
export const DELIVERY_DEADLINE_DAYS_MIN = 1;
// Production database constraint: delivery_deadline_days BETWEEN 1 AND 14.
// Keep API validation and Prisma storage aligned to avoid a late DB constraint error.
export const DELIVERY_DEADLINE_DAYS_MAX = 14;
export const CONFIRMATION_DEADLINE_DAYS = 1;
/**
 * Wave 3 P0 (2026-09-28) — batas kirim penjual: order PROCESSING yang belum
 * dikirim (belum IN_DELIVERY) melewati paidAt + N hari otomatis di-cancel +
 * refund penuh ke buyer via sweep expire-unshipped-orders (5 menit).
 * Disimpan ke orders.processingDeadlineAt saat pembayaran sukses.
 */
export const PROCESSING_DEADLINE_DAYS = 2;
/**
 * TX-UNIFIED-V2 (P1-3, 2026-10-06) — batas kirim default untuk PREORDER
 * TANPA estimasi eksplisit. Preorder tanpa tanggal estimasi tidak boleh
 * memakai SLA 2 hari (akan membatalkan preorder yang sah) — pakai 30 hari
 * sebagai default yang wajar; seller didorong mengisi estimasi eksplisit.
 */
export const PREORDER_DEFAULT_DEADLINE_DAYS = 30;
export const CONFIRMATION_DEADLINE_DAYS_MAP: Record<string, number> = {
  PRODUCT: 1,
  SERVICE: 2,
  DIGITAL: 1,
};
export const PAYMENT_DEADLINE_DAYS = 2;
export const KYC_THRESHOLD = 2_000_000;
export const WALLET_KYC_FREE_LIMIT = KYC_THRESHOLD;

export const MAX_BANK_ACCOUNTS = 5;

export const DISPUTE_SLA_HOURS = 72;

/**
 * SLA tahap kedua: setelah sengketa di-ESCALATED (otomatis karena SLA breach
 * atau manual oleh admin), admin punya 3x24 jam untuk memberi putusan.
 * Warning dikirim ke kedua pihak 24 jam sebelum deadline.
 *
 * BAI-097: SUMBER KEBENARAN TUNGGAL angka ini. Jangan definisikan konstanta
 * lokal lain (insiden: dispute-quick-escalation.service.ts sempat memakai 24
 * jam lokal sehingga deadline eskalasi berbeda per jalur). Semua penulis
 * `escalationSlaDeadlineAt` WAJIB memakai konstanta ini; admin UI membaca
 * kolom `escalationSlaDeadlineAt` per sengketa (bukan menghitung sendiri).
 */
export const DISPUTE_ESCALATION_SLA_HOURS = 72;
export const DISPUTE_ESCALATION_SLA_WARNING_HOURS = 24;

/**
 * Kebijakan platform fee saat putusan sengketa FULL_BUYER (transaksi batal
 * total, dana kembali ke pembeli).
 *
 * Perilaku saat ini (false): platform MENAHAN fee — pembeli menerima
 * `sellerReceiveAmount` (nilai order), bukan `buyerPayAmount` penuh.
 * Lihat `AdminDisputesService.resolveDispute` (audit 2026-09-26).
 *
 * REKOMENDASI (audit deferred sengketa 2026-09-26): set `true` — fee ikut
 * refund ke pembeli saat transaksi batal total. Alasan: (1) adil — pembeli
 * tidak menerima apa pun dari transaksi yang gagal; (2) biaya sengketa yang
 * berujung full refund biasanya kesalahan penjual/sistem, bukan pembeli;
 * (3) mengurangi potensi keluhan "uang kembali tidak penuh".
 *
 * KEPUTUSAN PRODUK TERBUKA: JANGAN aktifkan (ubah ke `true`) tanpa
 * persetujuan eksplisit product — ini mengubah aliran dana escrow.
 * Saat `true`, pembeli menerima `buyerPayAmount` penuh dan platform tidak
 * menahan fee untuk order tersebut.
 */
export const DISPUTE_FULL_BUYER_REFUNDS_PLATFORM_FEE = false;

export const CHAT_MESSAGE_MAX_LENGTH = 2000;

/**
 * Batas-batas chat yang ditambahkan bersama fitur Trust & Safety chat
 * (audit 2026-09-13). Semua berbentuk hard limit supaya satu percakapan
 * tidak bisa dipakai untuk menyanderakan performa lawan bicara.
 */
// Search: query di bawah panjang ini mengembalikan terlalu banyak noise.
export const CHAT_SEARCH_MIN_QUERY_LENGTH = 2;
export const CHAT_SEARCH_MAX_LIMIT = 50;
export const CHAT_SEARCH_DEFAULT_LIMIT = 20;
// Pin: alamat kirim & nomor resi, bukan tempat menyimpan seluruh percakapan.
export const CHAT_MAX_PINNED_PER_ROOM = 20;
// Forward: membatasi blast antar-room.
export const CHAT_MAX_FORWARD_TARGETS = 5;
// Reaction.
export const CHAT_MAX_EMOJI_LENGTH = 16;
// Voice note: 10 menit, sama dengan batas ukuran lampiran (10 MB).
export const CHAT_VOICE_MAX_DURATION_SECONDS = 600;
export const CHAT_VOICE_MIN_DURATION_SECONDS = 1;
// Inquiry (chat pra-transaksi): mencegah satu user membuka puluhan room
// untuk spam lawan bicaranya.
export const CHAT_INQUIRY_MAX_ACTIVE_PER_USER = 30;
export const CHAT_INQUIRY_SUBJECT_MAX_LENGTH = 200;
export const CHAT_INQUIRY_FIRST_MESSAGE_MAX_LENGTH = 1000;
// Batch 43 BE-CHAT: pesan sementara — TTL minimum 5 detik, maksimum 7 hari.
export const CHAT_EPHEMERAL_TTL_MIN_SECONDS = 5;
export const CHAT_EPHEMERAL_TTL_MAX_SECONDS = 7 * 24 * 60 * 60;
// Batch 43 BE-CHAT: jeda penghapusan pesan sekali-lihat setelah dibaca.
export const CHAT_VIEW_ONCE_GRACE_SECONDS = 30;
// Batch 43 BE-CHAT: export chat dibatasi 5000 pesan per permintaan.
export const CHAT_EXPORT_MAX_MESSAGES = 5000;
// Batch 43 BE-CHAT: polling — 2..10 opsi, pertanyaan maks 300 karakter.
export const CHAT_POLL_MIN_OPTIONS = 2;
export const CHAT_POLL_MAX_OPTIONS = 10;
export const CHAT_POLL_QUESTION_MAX_LENGTH = 300;
// Batch 43 BE-CHAT: template balasan "/" — maks 50 template per user.
export const CHAT_MAX_REPLY_TEMPLATES_PER_USER = 50;
// Audit 2026-10-03 (BFE-002): satu angka batas ukuran lampiran chat — dipakai
// di FileInterceptor upload (controller) DAN @Max ChatAttachmentDto.fileSize.
// Harus sama dengan batas UploadPurpose.CHAT_ATTACHMENT (50 MiB).
export const CHAT_ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;

export const TYPING_SERVER_AUTO_STOP_MS = 4000;
/**
 * Berapa lama server menahan status "sedang mengetik" sebelum mengirim
 * typing.stop sendiri. Nilai lama (4 s) lebih pendek dari jeda mengetik
 * normal, sehingga indikator berkedip padam walau lawan bicara masih
 * menulis.
 */
export const TYPING_HOLD_MS = 8000;
/**
 * Interval minimum antar broadcast typing.start. Klien mengirim heartbeat
 * tiap ketikan; tanpa ini, server membanjiri socket dengan event yang
 * identik (lihat realtime.gateway.ts).
 */
export const TYPING_REBROADCAST_INTERVAL_MS = 2500;

export const WALLET_DAILY_TOPUP_LIMIT = 50000000;
export const WALLET_DAILY_WITHDRAW_LIMIT = 50000000;
export const WALLET_MIN_WITHDRAW = 50000;
export const WALLET_MAX_WITHDRAW_PER_TX = 25000000;

export const WALLET_MIN_TRANSFER = 1000;
export const WALLET_MAX_TRANSFER_PER_TX = 25000000;
export const WALLET_DAILY_TRANSFER_LIMIT = 50000000;

// Standard platform fee: 2.5% of order value, clamped to [Rp 2.500, Rp 250.000].
// The clamp applies BEFORE any reductions (Kahade Plus subscription, voucher,
// rank-based discount, promo). Reductions may bring the effective fee below
// the Rp 2.500 floor (down to Rp 0).
export const KAHADE_FEE_RATE = 2.5;
// Kahade Plus subscriber rate (applied as a reduction from the standard fee,
// never higher than the clamped standard fee).
export const KAHADE_PLUS_FEE_RATE = 0.5;
// Hard limits applied to the STANDARD fee only (in sen).
export const FEE_MIN_SEN = 250_000;     // Rp 2.500
export const FEE_MAX_SEN = 25_000_000;  // Rp 250.000

export const SUBSCRIPTION_MONTHLY_PRICE = 99000;
export const SUBSCRIPTION_YEARLY_PRICE = 899000;

// Benefit 1 Kahade+: kuota pembebasan fee per periode billing —
// Rp 990.000 = 99.000.000 sen. Reset tiap awal periode billing.
export const PLUS_FEE_WAIVER_QUOTA_SEN = 99_000_000;
// Benefit 1: limit kuota dalam IDR (untuk response API).
export const PLUS_FEE_WAIVER_QUOTA_IDR = 990_000;

// Benefit 3 Kahade+: cap default klaim asuransi (IDR). Syarat & cap detail
// menyusul dari tim produk — nilai ini hanya placeholder.
export const INSURANCE_DEFAULT_CAP_IDR = 10_000_000;

// DBL-005 (audit integrasi 2026-10-01): konstanta UPLOAD_MAX_*_MB mati
// DIHAPUS — grep menunjukkan nol pemakaian di luar definisi dan nilainya
// bertentangan dengan penegakan aktual (mis. chat 10 vs 50 MB aktual).
// Batas upload yang benar-benar ditegakkan ada di
// src/modules/upload/upload.service.ts (MAX_FILE_SIZE).

export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
export const SEARCH_MAX_RESULTS = MAX_LIMIT;

// ============================================================
// SHOWCASE (Section 3 — konten sosial + feed discover)
// ============================================================
/** Batas item showcase per user (dipindah dari UsersService.MAX_SHOWCASE_ITEMS). */
export const SHOWCASE_MAX_ITEMS = 20;
/** Batas gambar per item showcase. */
export const SHOWCASE_MAX_IMAGES = 8;
/** Batas gambar per item showcase untuk subscriber Kahade+ aktif (Benefit 7). */
export const SHOWCASE_MAX_IMAGES_SUBSCRIBER = 18;
/** Batas atas absolut validasi DTO — enforce per-user di service layer. */
export const SHOWCASE_MAX_IMAGES_ABSOLUTE = 18;
export const SHOWCASE_TITLE_MAX_LENGTH = 100;
export const SHOWCASE_DESCRIPTION_MAX_LENGTH = 500;
/** Panjang maksimum descriptionHtml (Benefit 7); backend simpan apa adanya. */
export const SHOWCASE_DESCRIPTION_HTML_MAX_LENGTH = 10000;
export const SHOWCASE_CATEGORY_MAX_LENGTH = 60;
export const SHOWCASE_COMMENT_MAX_LENGTH = 1000;
/** Batas balasan per komentar root di GET comments (S-3: cegah response raksasa). */
export const SHOWCASE_REPLY_LIMIT = 20;
/** Feed discover: cursor-based, jadi limitnya lebih kecil dari MAX_LIMIT (100)
 *  supaya satu halaman tetap ringan (tiap item ikut memuat author + gambar). */
export const SHOWCASE_FEED_DEFAULT_LIMIT = 20;
export const SHOWCASE_FEED_MAX_LIMIT = 50;
// ── Batch 19 TIM A (item 1 & 2): video & media etalase ──
// Pilihan angka (didokumentasikan di docs/batch19-tim-a-kontrak-api.md):
// 100 MiB ≈ video 720p ±2–3 menit pada bitrate wajar; 180 detik = batas konten
// etalase pendek (bukan hosting video panjang). Validasi server-side, fail closed.
/** Ukuran maksimum file video showcase (bytes). */
export const SHOWCASE_VIDEO_MAX_BYTES = 100 * 1024 * 1024;
/** Durasi maksimum video showcase (detik). */
export const SHOWCASE_VIDEO_MAX_DURATION_SEC = 180;
/** Durasi minimum video showcase (detik) — menolak file 0-detik/korup. */
export const SHOWCASE_VIDEO_MIN_DURATION_SEC = 1;
/**
 * UPV-04 (audit upload video 2026-10-03): dimensi maksimum video showcase
 * (px, sisi terpanjang). 3840 = 4K UHD — video 8K/absurd ditolak fail-closed
 * (beban decode di HP + storage/bandwidth). Ditegakkan di
 * `processShowcaseVideo` via hasil ffprobe.
 */
export const SHOWCASE_VIDEO_MAX_DIMENSION_PX = 3840;
/**
 * Guard kasar multer di POST /upload/direct.
 *
 * UPV-08 (audit upload video 2026-10-03): HARUS di bawah
 * `client_max_body_size` nginx untuk jalur upload agar guard multer yang trip
 * duluan — sehingga 413 terstruktur `{ code: 'PAYLOAD_TOO_LARGE' }` dari
 * `MulterTooLargeInterceptor` yang sampai ke klien, bukan halaman 413 HTML
 * mentah nginx.
 *
 * Bug #2 (2026-10-07): nilai lama ("105M", 105.000.000 byte) SALAH HITUNG —
 * 104 MiB = 109.051.904 byte LEBIH BESAR dari 105.000.000, jadi nginx-lah yang
 * menolak lebih dulu. Config nginx (`deploy/nginx.conf` + `nginx/nginx.conf`)
 * kini memakai `client_max_body_size 115M` (120.795.136 byte) khusus jalur
 * `/v1/upload/` — selisih ~11 MiB di atas guard multer, tetap di atas batas
 * video showcase 100 MiB, dan route JSON lain tetap dibatasi 1m seperti
 * sebelumnya.
 */
export const UPLOAD_DIRECT_MULTER_MAX_BYTES = 104 * 1024 * 1024;
/** Lebar thumbnail video showcase (px); tinggi mengikuti aspek rasio. */
export const SHOWCASE_VIDEO_THUMBNAIL_WIDTH = 640;

// ---------------------------------------------------------------------------
// Story (2026-10-10): foto + video pendek ala WhatsApp Status.
// ---------------------------------------------------------------------------
/** Foto story maks 10 MB (server re-encode JPEG 1600 px). */
export const STORY_MEDIA_MAX_BYTES = 10 * 1024 * 1024;
/** Video story maks 50 MB — cukup untuk 60 dtk 1080p dari kamera HP. */
export const STORY_VIDEO_MAX_BYTES = 50 * 1024 * 1024;
/** Durasi video story maks 60 detik (Instagram Stories), min 1 detik. */
export const STORY_VIDEO_MAX_DURATION_SEC = 60;
export const STORY_VIDEO_MIN_DURATION_SEC = 1;
/** Lebar poster JPEG video story (ffmpeg) — dipakai tray/viewer/admin. */
export const STORY_VIDEO_THUMBNAIL_WIDTH = 640;
/** PERF-FIX (NP-001): lebar thumbnail foto showcase (px); tinggi mengikuti
 * aspek rasio. Dihasilkan server-side saat upload SHOWCASE_IMAGE via sharp —
 * feed memuat varian kecil ini, bukan file full-res. */
export const SHOWCASE_IMAGE_THUMBNAIL_WIDTH = 640;
/** Jumlah frame minimum & maksimum untuk satu set spin360. */
export const SHOWCASE_SPIN360_MIN_FRAMES = 8;
export const SHOWCASE_SPIN360_MAX_FRAMES = 24;
/** Panjang maksimum groupKey spin360 (alnum, dash, underscore). */
export const SHOWCASE_SPIN360_GROUP_KEY_MAX_LENGTH = 64;
// ── Batch 19 TIM A (item 4): highlight etalase ──
/** Batas highlight per user. */
export const SHOWCASE_MAX_HIGHLIGHTS = 20;
/** Batas produk per highlight. */
export const SHOWCASE_HIGHLIGHT_MAX_PRODUCTS = 50;
/** Panjang judul highlight. */
export const SHOWCASE_HIGHLIGHT_TITLE_MAX_LENGTH = 80;
/** Satu view dihitung sekali per (viewer, showcase) dalam window ini. */
export const SHOWCASE_VIEW_DEDUPE_TTL_SECONDS = 3600;
/** Sort "foryou": ukuran pool kandidat per segmen. Pool dibatasi supaya satu
 *  request feed tidak memuat ribuan baris (tiap item ikut memuat author +
 *  gambar); skor personal dihitung di aplikasi dari pool ini. */
export const SHOWCASE_FOR_YOU_AFFINITY_POOL = 150;
export const SHOWCASE_FOR_YOU_FOLLOWED_POOL = 100;
export const SHOWCASE_FOR_YOU_RECENT_POOL = 150;
/** Sort "foryou": batas sinyal yang dibaca untuk membangun profil afinitas. */
export const SHOWCASE_FOR_YOU_LIKE_SIGNAL_LIMIT = 200;
export const SHOWCASE_FOR_YOU_FOLLOW_SIGNAL_LIMIT = 500;
/** Sort "foryou": `now` dibulatkan ke bucket ini supaya skor yang dihitung
 *  ulang antar-halaman identik bit-per-bit (syarat keyset pagination
 *  in-memory tetap valid bila halaman 2 diminta beberapa menit kemudian). */
export const SHOWCASE_FOR_YOU_SCORE_TIME_BUCKET_MS = 15 * 60 * 1000;
/** B1-001 (perf): TTL cache Redis untuk sinyal afinitas viewer (like 200 +
 *  follow 500 terakhir). Sinyal berubah lambat; 10 menit = kompromi wajar. */
export const SHOWCASE_FOR_YOU_SIGNALS_CACHE_TTL_SECONDS = 600;
/** B1-001 (perf): TTL cache Redis untuk merged candidate pool per
 *  (viewerId, filter hash, bucket skor). Disamakan dengan bucket 15 menit —
 *  skor dihitung ulang dari pool yang sama persis, ranking tidak berubah. */
export const SHOWCASE_FOR_YOU_POOL_CACHE_TTL_SECONDS = 900;
/** SH-B-004: satu share nyata dihitung sekali per (viewer, showcase) dalam window ini. */
export const SHOWCASE_SHARE_DEDUPE_TTL_SECONDS = 86400;
export const SHOWCASE_SEARCH_MIN_LENGTH = 2;
export const SHOWCASE_SEARCH_MAX_LENGTH = 100;

export const ORDER_LINK_EXPIRY_HOURS = 48;
export const ORDER_LINK_TOKEN_LENGTH = 32;

export const DELIVERY_REVIEW_WINDOW_DAYS = 3;

export const AUTO_COMPLETE_GRACE_PERIOD_HOURS = 48;

export const POST_COMPLETION_DISPUTE_WINDOW_HOURS = 72;

export const ESCROW_RELEASE_HOLD_HOURS = POST_COMPLETION_DISPUTE_WINDOW_HOURS;

export const MAX_ESCROW_BALANCE = 500_000_000;

export const INVOICE_COMPANY_NAME = process.env.INVOICE_COMPANY_NAME || 'PT Kawal Hak Dengan Aman';
export const INVOICE_COMPANY_ADDRESS = process.env.INVOICE_COMPANY_ADDRESS || 'Jl. Jenderal Sudirman Kav. 52-53, Senayan, Kebayoran Baru, Jakarta Selatan 12190, Indonesia';

export const MAX_REFERRALS = 100;

// Dispute call (WebRTC) lifecycle windows. These live here because two independent
// components must agree on them: `dispute-call.service.ts` (request/accept/end) and
// `scheduler/services/expire-dispute-calls.service.ts` (the cron that reaps stale rows).
// They previously disagreed — the service reused its 900s *call duration* cap as the
// *request expiry* window while the cron used 600s, so a request could be accepted
// after the cron already considered it expired.
export const DISPUTE_CALL_REQUEST_EXPIRY_SECONDS = 600;
export const DISPUTE_CALL_MAX_DURATION_SECONDS = 900;

const RESERVED_USERNAMES_EN = [
  'admin', 'support', 'root', 'system', 'official', 'help', 'info', 'api',
  'www', 'moderator', 'staff', 'login', 'register', 'verify-email',
  'set-username', 'forgot-password', 'reset-password', '2fa-verify',
  'escrow', 'wallet', 'dispute', 'chat', 'badges', 'voucher', 'ratings',
  'referral', 'user', 'followers', 'following', 'null', 'undefined',
  'test', 'demo', 'billing', 'payment', 'security', 'terms', 'privacy',
  'delete', 'account', 'settings', 'dashboard', 'status', 'about',
  'contact', 'home', 'search', 'notifications', 'profile',
];

// Deeplink path segments (Instagram-style: kahade.id/:username, kahade.id/p/:id).
// These MUST NOT be usable as usernames, otherwise the landing router cannot
// distinguish a profile URL from a reserved route. Kept in a separate list so
// the intent is explicit; merged into RESERVED_USERNAMES below.
const RESERVED_USERNAMES_DEEPLINK = [
  'p', 'v', 'r', 'faq', 'verify', 'transfer', 'download', 'static',
  'images', 'order-link', 'explore',
];

const RESERVED_USERNAMES_ID = [
  'transaksi', 'notifikasi', 'profil', 'langganan', 'sesi', 'pengaturan',
  'lainnya', 'bantuan', 'template-transaksi', 'analitik', 'cara-kerja',
  'beranda', 'keamanan', 'hapus', 'akun', 'pembayaran', 'tagihan',
  'syarat', 'kebijakan',
];

export const RESERVED_USERNAMES = [
  'kahade',
  ...RESERVED_USERNAMES_EN,
  ...RESERVED_USERNAMES_ID,
  ...RESERVED_USERNAMES_DEEPLINK,
];
