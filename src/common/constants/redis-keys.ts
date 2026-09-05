export const IDEMPOTENCY_CACHE_KEY = (key: string): string => `idempotency:${key}`;

export const USER_SESSION = (sessionId: string): string => `session:${sessionId}`;
export const USER_SESSIONS = (userId: string): string => `sessions:${userId}`;

export const RATE_LIMIT = (key: string): string => `rate_limit:${key}`;

export const OTP_COOLDOWN = (identifier: string, type: string): string =>
  `otp_cooldown:${identifier}:${type}`;
export const OTP_PHONE_RATE = (phone: string, type: string): string =>
  `otp_phone_rate:${phone}:${type}`;

export const TOKEN_BLACKLIST = (jti: string): string => `token_blacklist:${jti}`;
export const ADMIN_TOKEN_BLACKLIST = (jti: string): string => `token_blacklist:admin:${jti}`;

export const UPLOAD_CONFIRMATION = (fileKey: string): string => `upload:${fileKey}`;

export const WALLET_LOCK = (walletId: string): string => `wallet_lock:${walletId}`;

export const ORDER_LOCK = (orderId: string): string => `order_lock:${orderId}`;
export const ORDER_SERIAL = (date: string): string => `order_serial:${date}`;
export const ORDER_LINK_SERIAL = (date: string): string => `order_link_serial:${date}`;

export const WITHDRAW_OTP = (txId: string): string => `withdraw_otp:${txId}`;

export const CACHE_KEY = (key: string): string => `cache:${key}`;
export const PHONE_VERIFIED_GUARD = (userId: string): string => `guard:phone_verified:${userId}`;

export const ADMIN_SESSION = (adminId: string): string => `admin_session:${adminId}`;
export const ADMIN_REFRESH_BLACKLIST = (jti: string): string => `admin_refresh_blacklist:${jti}`;

export const SESSION_REVOKED_KEY = (sessionId: string): string => `session_revoked:${sessionId}`;

export const ADMIN_SYSTEM_CONFIGS = `admin:system:configs`;
export const ADMIN_VOUCHERS_LIST = (isActive: string | undefined, limit: number): string =>
  `admin:vouchers:list:${isActive ?? 'all'}:${limit}`;

export const FEE_CONFIG_CACHE = `fee:config`;

export const SUBSCRIPTION_PLANS_CACHE = `public:subscription:plans`;
export const ACTIVE_VOUCHERS_LIST = (
  applicableTo: string | undefined,
  limit: number,
  audience = 'all',
): string => `public:vouchers:active:${applicableTo ?? 'all'}:${audience}:${limit}`;

export const WEBHOOK_PROCESSING = (transactionId: string, status: string): string =>
  `webhook_processing:${transactionId}:${status}`;
export const WEBHOOK_PROCESSED = (transactionId: string, status: string): string =>
  `webhook_processed:${transactionId}:${status}`;

export const TOTP_USED_CODE = (userId: string): string => `totp_used:${userId}`;

export const ADMIN_2FA_ATTEMPT_KEY = (tempTokenJti: string): string =>
  `admin_2fa_attempts:${tempTokenJti}`;

export const OTP_EMAIL_RATE = (email: string, type: string): string =>
  `otp_email_rate:${email}:${type}`;

export const BACKUP_CODE_USED = (twoFactorAuthId: string, codeHash: string): string =>
  `backup_code_used:${twoFactorAuthId}:${codeHash}`;

export const WALLET_PIN_ATTEMPTS = (userId: string): string => `wallet_pin_attempts:${userId}`;

export const WALLET_PIN_IP_ATTEMPTS = (ip: string): string => `wallet_pin_ip_attempts:${ip}`;

export const WITHDRAW_OTP_COOLDOWN = (userId: string): string => `withdraw_otp_cooldown:${userId}`;

export const EXTENSION_REQUEST_LOCK = (orderId: string): string =>
  `extension_request_lock:${orderId}`;

export const ORDER_AVG_DURATIONS_CACHE = `orders:average_durations`;

export const OTP_IP_RATE = (ip: string): string => `otp_ip_rate:${ip}`;

export const LOGIN_IP_RATE = (ip: string): string => `login_ip_rate:${ip}`;

export const TRANSFER_LOCK = (userId: string): string => `transfer_lock:${userId}`;
export const DAILY_TRANSFER_AMOUNT = (userId: string, date: string): string =>
  `daily_transfer:${userId}:${date}`;
