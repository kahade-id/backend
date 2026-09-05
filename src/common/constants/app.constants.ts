const _parsedIdempotencyTtl = parseInt(process.env.IDEMPOTENCY_TTL_SECONDS || '86400', 10);
export const IDEMPOTENCY_TTL = Number.isFinite(_parsedIdempotencyTtl) && _parsedIdempotencyTtl > 0 ? _parsedIdempotencyTtl : 86400;

export const OTP_MAX_ATTEMPTS = 5;
export const OTP_EXPIRES_MINUTES = 5;
export const OTP_LENGTH = 6;

export const RATING_WINDOW_DAYS = 7;
export const RATING_EDIT_WINDOW_DAYS = 7;

export const ACCOUNT_LOCK_MAX_ATTEMPTS = 5;
export const ACCOUNT_LOCK_DURATION_MINUTES = 30;

export const PASSWORD_MIN_LENGTH = 12;
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

export const CHAT_MESSAGE_MAX_LENGTH = 2000;

export const TYPING_SERVER_AUTO_STOP_MS = 4000;

export const WALLET_DAILY_TOPUP_LIMIT = 50000000;
export const WALLET_DAILY_WITHDRAW_LIMIT = 50000000;
export const WALLET_MIN_WITHDRAW = 50000;
export const WALLET_MAX_WITHDRAW_PER_TX = 25000000;

export const WALLET_MIN_TRANSFER = 1000;
export const WALLET_MAX_TRANSFER_PER_TX = 25000000;
export const WALLET_DAILY_TRANSFER_LIMIT = 50000000;

// Standard platform fee: 2.5% of order value, clamped to [Rp 5.000, Rp 250.000].
// The clamp applies BEFORE any reductions (Kahade Plus subscription, voucher,
// rank-based discount, promo). Reductions may bring the effective fee below
// the Rp 5.000 floor (down to Rp 0).
export const KAHADE_FEE_RATE = 2.5;
// Kahade Plus subscriber rate (applied as a reduction from the standard fee,
// never higher than the clamped standard fee).
export const KAHADE_PLUS_FEE_RATE = 0.5;
// Hard limits applied to the STANDARD fee only (in sen).
export const FEE_MIN_SEN = 500_000;     // Rp 5.000
export const FEE_MAX_SEN = 25_000_000;  // Rp 250.000

export const SUBSCRIPTION_MONTHLY_PRICE = 29000;
export const SUBSCRIPTION_ANNUAL_PRICE = 299000;

export const UPLOAD_MAX_AVATAR_MB = 2;
export const UPLOAD_MAX_CHAT_MB = 10;
export const UPLOAD_MAX_KYC_MB = 5;
export const UPLOAD_MAX_EVIDENCE_MB = 10;

export const EXPORT_MAX_DATE_RANGE_DAYS = 90;

export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
export const SEARCH_MAX_RESULTS = MAX_LIMIT;

export const ORDER_LINK_EXPIRY_HOURS = 48;
export const ORDER_LINK_TOKEN_LENGTH = 32;

export const DELIVERY_REVIEW_WINDOW_DAYS = 3;

export const AUTO_COMPLETE_GRACE_PERIOD_HOURS = 48;

export const POST_COMPLETION_DISPUTE_WINDOW_HOURS = 72;

export const ESCROW_RELEASE_HOLD_HOURS = POST_COMPLETION_DISPUTE_WINDOW_HOURS;

export const MAX_ESCROW_BALANCE = 500_000_000;

export const INVOICE_COMPANY_NAME = process.env.INVOICE_COMPANY_NAME || 'PT Kahade Digital Indonesia';
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
];
