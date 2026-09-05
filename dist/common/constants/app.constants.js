"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SEARCH_MAX_RESULTS = exports.MAX_LIMIT = exports.DEFAULT_LIMIT = exports.DEFAULT_PAGE = exports.EXPORT_MAX_DATE_RANGE_DAYS = exports.UPLOAD_MAX_EVIDENCE_MB = exports.UPLOAD_MAX_KYC_MB = exports.UPLOAD_MAX_CHAT_MB = exports.UPLOAD_MAX_AVATAR_MB = exports.SUBSCRIPTION_ANNUAL_PRICE = exports.SUBSCRIPTION_MONTHLY_PRICE = exports.FEE_MAX_SEN = exports.FEE_MIN_SEN = exports.KAHADE_PLUS_FEE_RATE = exports.KAHADE_FEE_RATE = exports.WALLET_DAILY_TRANSFER_LIMIT = exports.WALLET_MAX_TRANSFER_PER_TX = exports.WALLET_MIN_TRANSFER = exports.WALLET_MAX_WITHDRAW_PER_TX = exports.WALLET_MIN_WITHDRAW = exports.WALLET_DAILY_WITHDRAW_LIMIT = exports.WALLET_DAILY_TOPUP_LIMIT = exports.TYPING_SERVER_AUTO_STOP_MS = exports.CHAT_MESSAGE_MAX_LENGTH = exports.DISPUTE_SLA_HOURS = exports.MAX_BANK_ACCOUNTS = exports.WALLET_KYC_FREE_LIMIT = exports.KYC_THRESHOLD = exports.PAYMENT_DEADLINE_DAYS = exports.CONFIRMATION_DEADLINE_DAYS_MAP = exports.CONFIRMATION_DEADLINE_DAYS = exports.DELIVERY_DEADLINE_DAYS_MAX = exports.DELIVERY_DEADLINE_DAYS_MIN = exports.ORDER_MAX_VALUE = exports.ORDER_MIN_VALUE = exports.JWT_TEMP_EXPIRES_IN = exports.JWT_REFRESH_EXPIRES_IN = exports.JWT_ADMIN_EXPIRES_IN = exports.JWT_USER_EXPIRES_IN = exports.BCRYPT_ROUNDS_ADMIN = exports.BCRYPT_ROUNDS = exports.PASSWORD_MIN_LENGTH = exports.ACCOUNT_LOCK_DURATION_MINUTES = exports.ACCOUNT_LOCK_MAX_ATTEMPTS = exports.RATING_EDIT_WINDOW_DAYS = exports.RATING_WINDOW_DAYS = exports.OTP_LENGTH = exports.OTP_EXPIRES_MINUTES = exports.OTP_MAX_ATTEMPTS = exports.IDEMPOTENCY_TTL = void 0;
exports.RESERVED_USERNAMES = exports.DISPUTE_CALL_MAX_DURATION_SECONDS = exports.DISPUTE_CALL_REQUEST_EXPIRY_SECONDS = exports.MAX_REFERRALS = exports.INVOICE_COMPANY_ADDRESS = exports.INVOICE_COMPANY_NAME = exports.MAX_ESCROW_BALANCE = exports.ESCROW_RELEASE_HOLD_HOURS = exports.POST_COMPLETION_DISPUTE_WINDOW_HOURS = exports.AUTO_COMPLETE_GRACE_PERIOD_HOURS = exports.DELIVERY_REVIEW_WINDOW_DAYS = exports.ORDER_LINK_TOKEN_LENGTH = exports.ORDER_LINK_EXPIRY_HOURS = void 0;
const _parsedIdempotencyTtl = parseInt(process.env.IDEMPOTENCY_TTL_SECONDS || '86400', 10);
exports.IDEMPOTENCY_TTL = Number.isFinite(_parsedIdempotencyTtl) && _parsedIdempotencyTtl > 0 ? _parsedIdempotencyTtl : 86400;
exports.OTP_MAX_ATTEMPTS = 5;
exports.OTP_EXPIRES_MINUTES = 5;
exports.OTP_LENGTH = 6;
exports.RATING_WINDOW_DAYS = 7;
exports.RATING_EDIT_WINDOW_DAYS = 7;
exports.ACCOUNT_LOCK_MAX_ATTEMPTS = 5;
exports.ACCOUNT_LOCK_DURATION_MINUTES = 30;
exports.PASSWORD_MIN_LENGTH = 12;
const MIN_BCRYPT_ROUNDS = 12;
const parsedBcryptRounds = parseInt(process.env.BCRYPT_ROUNDS || '12', 10);
const parsedBcryptRoundsAdmin = parseInt(process.env.BCRYPT_ROUNDS_ADMIN || '14', 10);
exports.BCRYPT_ROUNDS = Math.max(MIN_BCRYPT_ROUNDS, Number.isFinite(parsedBcryptRounds) ? parsedBcryptRounds : 12);
exports.BCRYPT_ROUNDS_ADMIN = Math.max(MIN_BCRYPT_ROUNDS, Number.isFinite(parsedBcryptRoundsAdmin) ? parsedBcryptRoundsAdmin : 14);
exports.JWT_USER_EXPIRES_IN = '15m';
exports.JWT_ADMIN_EXPIRES_IN = '30m';
exports.JWT_REFRESH_EXPIRES_IN = '7d';
exports.JWT_TEMP_EXPIRES_IN = '5m';
exports.ORDER_MIN_VALUE = 10000;
exports.ORDER_MAX_VALUE = 1000000000;
exports.DELIVERY_DEADLINE_DAYS_MIN = 1;
exports.DELIVERY_DEADLINE_DAYS_MAX = 14;
exports.CONFIRMATION_DEADLINE_DAYS = 1;
exports.CONFIRMATION_DEADLINE_DAYS_MAP = {
    PRODUCT: 1,
    SERVICE: 2,
    DIGITAL: 1,
};
exports.PAYMENT_DEADLINE_DAYS = 2;
exports.KYC_THRESHOLD = 2_000_000;
exports.WALLET_KYC_FREE_LIMIT = exports.KYC_THRESHOLD;
exports.MAX_BANK_ACCOUNTS = 5;
exports.DISPUTE_SLA_HOURS = 72;
exports.CHAT_MESSAGE_MAX_LENGTH = 2000;
exports.TYPING_SERVER_AUTO_STOP_MS = 4000;
exports.WALLET_DAILY_TOPUP_LIMIT = 50000000;
exports.WALLET_DAILY_WITHDRAW_LIMIT = 50000000;
exports.WALLET_MIN_WITHDRAW = 50000;
exports.WALLET_MAX_WITHDRAW_PER_TX = 25000000;
exports.WALLET_MIN_TRANSFER = 1000;
exports.WALLET_MAX_TRANSFER_PER_TX = 25000000;
exports.WALLET_DAILY_TRANSFER_LIMIT = 50000000;
exports.KAHADE_FEE_RATE = 2.5;
exports.KAHADE_PLUS_FEE_RATE = 0.5;
exports.FEE_MIN_SEN = 500_000;
exports.FEE_MAX_SEN = 25_000_000;
exports.SUBSCRIPTION_MONTHLY_PRICE = 29000;
exports.SUBSCRIPTION_ANNUAL_PRICE = 299000;
exports.UPLOAD_MAX_AVATAR_MB = 2;
exports.UPLOAD_MAX_CHAT_MB = 10;
exports.UPLOAD_MAX_KYC_MB = 5;
exports.UPLOAD_MAX_EVIDENCE_MB = 10;
exports.EXPORT_MAX_DATE_RANGE_DAYS = 90;
exports.DEFAULT_PAGE = 1;
exports.DEFAULT_LIMIT = 20;
exports.MAX_LIMIT = 100;
exports.SEARCH_MAX_RESULTS = exports.MAX_LIMIT;
exports.ORDER_LINK_EXPIRY_HOURS = 48;
exports.ORDER_LINK_TOKEN_LENGTH = 32;
exports.DELIVERY_REVIEW_WINDOW_DAYS = 3;
exports.AUTO_COMPLETE_GRACE_PERIOD_HOURS = 48;
exports.POST_COMPLETION_DISPUTE_WINDOW_HOURS = 72;
exports.ESCROW_RELEASE_HOLD_HOURS = exports.POST_COMPLETION_DISPUTE_WINDOW_HOURS;
exports.MAX_ESCROW_BALANCE = 500_000_000;
exports.INVOICE_COMPANY_NAME = process.env.INVOICE_COMPANY_NAME || 'PT Kahade Digital Indonesia';
exports.INVOICE_COMPANY_ADDRESS = process.env.INVOICE_COMPANY_ADDRESS || 'Jl. Jenderal Sudirman Kav. 52-53, Senayan, Kebayoran Baru, Jakarta Selatan 12190, Indonesia';
exports.MAX_REFERRALS = 100;
exports.DISPUTE_CALL_REQUEST_EXPIRY_SECONDS = 600;
exports.DISPUTE_CALL_MAX_DURATION_SECONDS = 900;
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
exports.RESERVED_USERNAMES = [
    'kahade',
    ...RESERVED_USERNAMES_EN,
    ...RESERVED_USERNAMES_ID,
];
