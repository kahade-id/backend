import {
  createCipheriv, createDecipheriv, createHmac, createHash,
  randomBytes, scrypt as scryptCb, ScryptOptions,
} from 'crypto';
import { promisify } from 'util';
import * as bcrypt from 'bcrypt';
import * as argon2 from 'argon2';

const scryptAsync = promisify(scryptCb) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options?: ScryptOptions,
) => Promise<Buffer>;
const AES_ALGORITHM = 'aes-256-gcm';
const KEY_VERSION_PREFIX = 'v1';
const MIN_BCRYPT_ROUNDS = 12;
const DEFAULT_BCRYPT_ROUNDS = 12;

/**
 * [CRY-025] All encryption keys are currently managed via environment variables.
 * For production deployments, integrating with a cloud KMS (AWS KMS, GCP KMS,
 * HashiCorp Vault) is recommended for key management, rotation, and audit logging.
 * This is tracked as future infrastructure work.
 */
let _aesSecretKey = '';
let _previousAesSecretKey = '';
let _hmacSecretKey = '';
let _kycNikEncryptionKey = '';
let _kycKtpEncryptionKey = '';
let _kycSelfieEncryptionKey = '';
let _cryptoInitialized = false;
let _bcryptRounds = DEFAULT_BCRYPT_ROUNDS;

export function initializeCrypto(config: {
  aesSecretKey: string;
  aesKdfSalt?: string;
  hmacSecretKey: string;
  previousAesSecretKey?: string;
  kycNikEncryptionKey?: string;
  kycKtpEncryptionKey?: string;
  kycSelfieEncryptionKey?: string;
  bcryptRounds?: number;
}): void {
  _aesSecretKey = config.aesSecretKey;
  _previousAesSecretKey = config.previousAesSecretKey || '';
  _hmacSecretKey = config.hmacSecretKey;
  _kycNikEncryptionKey = config.kycNikEncryptionKey || config.aesSecretKey;
  _kycKtpEncryptionKey = config.kycKtpEncryptionKey || config.aesSecretKey;
  _kycSelfieEncryptionKey = config.kycSelfieEncryptionKey || config.aesSecretKey;
  if (process.env.NODE_ENV === 'production') {
    const kycKeys = [_kycNikEncryptionKey, _kycKtpEncryptionKey, _kycSelfieEncryptionKey];
    if (!config.kycNikEncryptionKey || !config.kycKtpEncryptionKey || !config.kycSelfieEncryptionKey) {
      throw new Error('KYC_NIK_ENCRYPTION_KEY, KYC_KTP_ENCRYPTION_KEY, and KYC_SELFIE_ENCRYPTION_KEY must all be set in production');
    }
    if (new Set(kycKeys).size !== 3) {
      throw new Error('KYC encryption keys must be distinct from each other');
    }
  }
  if (config.bcryptRounds !== undefined && Number.isFinite(config.bcryptRounds)) {
    _bcryptRounds = Math.max(MIN_BCRYPT_ROUNDS, config.bcryptRounds);
  }
  _cryptoInitialized = true;
}

export function isCryptoInitialized(): boolean {
  return _cryptoInitialized;
}

export function getBcryptRounds(): number {
  return _bcryptRounds;
}

async function deriveKeyAsync(secret: string, salt: Buffer): Promise<Buffer> {
  if (!_cryptoInitialized) {
    throw new Error('Crypto module not initialized — call initializeCrypto() before using encrypt/decrypt functions');
  }
  if (!secret) {
    throw new Error('AES secret key is empty — call initializeCrypto() with a non-empty aesSecretKey');
  }
  const key = await scryptAsync(secret, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return key as Buffer;
}

export async function encryptAES(plaintext: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await deriveKeyAsync(_aesSecretKey, salt);
  const iv = randomBytes(12);
  const cipher = createCipheriv(AES_ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'base64');
  encrypted += cipher.final('base64');

  const authTag = cipher.getAuthTag();
  return `${KEY_VERSION_PREFIX}:${salt.toString('base64')}:${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted}`;
}

async function encryptAESWithKey(plaintext: string, secretKey: string, keyId?: string): Promise<string> {
  const effectiveKey = secretKey || _aesSecretKey;
  const salt = randomBytes(16);
  const key = await deriveKeyAsync(effectiveKey, salt);
  const iv = randomBytes(12);
  const cipher = createCipheriv(AES_ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'base64');
  encrypted += cipher.final('base64');

  const authTag = cipher.getAuthTag();
  const prefix = keyId ? `${KEY_VERSION_PREFIX}:${keyId}` : KEY_VERSION_PREFIX;
  return `${prefix}:${salt.toString('base64')}:${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted}`;
}

export async function encryptKycNik(plaintext: string): Promise<string> {
  return encryptAESWithKey(plaintext, _kycNikEncryptionKey, 'nik');
}

export async function encryptKycKtp(plaintext: string): Promise<string> {
  return encryptAESWithKey(plaintext, _kycKtpEncryptionKey, 'ktp');
}

export async function encryptKycSelfie(plaintext: string): Promise<string> {
  return encryptAESWithKey(plaintext, _kycSelfieEncryptionKey, 'selfie');
}

const KYC_KEY_MAP: Record<string, () => string> = {
  'nik': () => _kycNikEncryptionKey,
  'ktp': () => _kycKtpEncryptionKey,
  'selfie': () => _kycSelfieEncryptionKey,
};

export async function decryptAES(ciphertext: string): Promise<string> {
  const parts = ciphertext.split(':');

  if (parts.length >= 5 && parts[0] === KEY_VERSION_PREFIX) {
    let keyIdHint: string | undefined;
    let saltB64: string, ivB64: string, authTagB64: string, encrypted: string;

    if (parts.length === 6 && parts[1] in KYC_KEY_MAP) {
      keyIdHint = parts[1];
      saltB64 = parts[2];
      ivB64 = parts[3];
      authTagB64 = parts[4];
      encrypted = parts[5];
    } else if (parts.length === 5) {
      saltB64 = parts[1];
      ivB64 = parts[2];
      authTagB64 = parts[3];
      encrypted = parts[4];
    } else {
      throw new Error('Invalid v1 ciphertext format');
    }

    const salt = Buffer.from(saltB64, 'base64');
    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(authTagB64, 'base64');

    if (salt.length !== 16) throw new Error(`Invalid salt length: expected 16 bytes, got ${salt.length}`);
    if (iv.length !== 12) throw new Error(`Invalid IV length: expected 12 bytes, got ${iv.length}`);
    if (authTag.length !== 16) throw new Error(`Invalid auth tag length: expected 16 bytes, got ${authTag.length}`);

    let secretsToTry: string[];
    if (keyIdHint && KYC_KEY_MAP[keyIdHint]) {
      const primaryKey = KYC_KEY_MAP[keyIdHint]();
      secretsToTry = primaryKey ? [primaryKey] : [];
      if (_aesSecretKey && !secretsToTry.includes(_aesSecretKey)) secretsToTry.push(_aesSecretKey);
      if (_previousAesSecretKey && !secretsToTry.includes(_previousAesSecretKey)) secretsToTry.push(_previousAesSecretKey);
    } else {
      secretsToTry = [_aesSecretKey];
      if (_previousAesSecretKey) secretsToTry.push(_previousAesSecretKey);
      if (_kycNikEncryptionKey && _kycNikEncryptionKey !== _aesSecretKey) secretsToTry.push(_kycNikEncryptionKey);
      if (_kycKtpEncryptionKey && _kycKtpEncryptionKey !== _aesSecretKey) secretsToTry.push(_kycKtpEncryptionKey);
      if (_kycSelfieEncryptionKey && _kycSelfieEncryptionKey !== _aesSecretKey) secretsToTry.push(_kycSelfieEncryptionKey);
    }

    for (const secret of secretsToTry) {
      try {
        const key = await deriveKeyAsync(secret, salt);
        const decipher = createDecipheriv(AES_ALGORITHM, key, iv);
        decipher.setAuthTag(authTag);

        let decrypted = decipher.update(encrypted, 'base64', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
      } catch {
        continue;
      }
    }
    throw new Error('Decryption failed (v1): unable to decrypt with any known key');
  }

  if (parts.length === 3) {
    const iv = Buffer.from(parts[0], 'base64');
    const authTag = Buffer.from(parts[1], 'base64');
    const encrypted = parts[2];

    if (iv.length !== 12) throw new Error(`Invalid IV length: expected 12 bytes, got ${iv.length}`);
    if (authTag.length !== 16) throw new Error(`Invalid auth tag length: expected 16 bytes, got ${authTag.length}`);

    const secretsToTry = [_aesSecretKey];
    if (_previousAesSecretKey) secretsToTry.push(_previousAesSecretKey);

    for (const secret of secretsToTry) {
      try {
        const rawKey = Buffer.from(secret, 'hex');
        if (rawKey.length === 32) {
          const decipher = createDecipheriv(AES_ALGORITHM, rawKey, iv);
          decipher.setAuthTag(authTag);
          let decrypted = decipher.update(encrypted, 'base64', 'utf8');
          decrypted += decipher.final('utf8');
          return decrypted;
        }
      } catch {
        // Key rotation fallback: primary key didn't match, try next
      }

      try {
        const legacySalt = Buffer.from(secret.slice(0, 16), 'utf8');
        const key = await deriveKeyAsync(secret, legacySalt);
        const decipher = createDecipheriv(AES_ALGORITHM, key, iv);
        decipher.setAuthTag(authTag);

        let decrypted = decipher.update(encrypted, 'base64', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
      } catch {
        continue;
      }
    }
    throw new Error('Decryption failed: unable to decrypt with any known key');
  }

  throw new Error('Invalid ciphertext format: expected v1:salt:iv:authTag:ciphertext or legacy iv:authTag:ciphertext');
}

/**
 * [CRY-001] HMAC-SHA256 keyed hash for data integrity (NIK dedup, bank account dedup).
 * This is NOT a request signing/verification function. The codebase uses JWT bearer
 * tokens for request authentication — no HMAC request verification middleware exists.
 * Previously referenced "dead HMAC verification code" has been confirmed removed;
 * all remaining usages of this function are active (kyc.service, bank-accounts.service).
 */
export function hmacSHA256(value: string): string {
  if (!_cryptoInitialized) {
    throw new Error('Crypto module not initialized — call initializeCrypto() before using HMAC functions');
  }
  if (!_hmacSecretKey) {
    throw new Error('HMAC secret key is empty — call initializeCrypto() with a non-empty hmacSecretKey');
  }
  return createHmac('sha256', _hmacSecretKey).update(value).digest('hex');
}

export function hmacPinDigest(pepper: string, pin: string): string {
  return createHmac('sha256', pepper).update(pin).digest('base64');
}

export async function bcryptHash(value: string, rounds?: number): Promise<string> {
  const effectiveRounds = rounds ?? _bcryptRounds;
  return bcrypt.hash(value, Math.max(MIN_BCRYPT_ROUNDS, effectiveRounds));
}

export async function bcryptCompare(value: string, hash: string): Promise<boolean> {
  return bcrypt.compare(value, hash);
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

let _nikHashSalt: Buffer | null = null;

function getNikHashSalt(): Buffer {
  if (_nikHashSalt) return _nikHashSalt;
  if (!_hmacSecretKey) {
    throw new Error('HMAC secret key is required for NIK hashing — call initializeCrypto() first');
  }
  _nikHashSalt = createHash('sha256').update(_hmacSecretKey + ':nik-argon2-salt').digest().subarray(0, 16);
  return _nikHashSalt;
}

export async function argon2HashNik(value: string): Promise<string> {
  const salt = getNikHashSalt();
  const raw = await argon2.hash(value, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
    salt,
    raw: true,
  });
  return (raw as Buffer).toString('hex');
}
