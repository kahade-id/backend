"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.initializeCrypto = initializeCrypto;
exports.isCryptoInitialized = isCryptoInitialized;
exports.getBcryptRounds = getBcryptRounds;
exports.encryptAES = encryptAES;
exports.encryptKycNik = encryptKycNik;
exports.encryptKycKtp = encryptKycKtp;
exports.encryptKycSelfie = encryptKycSelfie;
exports.decryptAES = decryptAES;
exports.hmacSHA256 = hmacSHA256;
exports.hmacPinDigest = hmacPinDigest;
exports.bcryptHash = bcryptHash;
exports.bcryptCompare = bcryptCompare;
exports.sha256 = sha256;
exports.argon2HashNik = argon2HashNik;
const crypto_1 = require("crypto");
const util_1 = require("util");
const bcrypt = __importStar(require("bcrypt"));
const argon2 = __importStar(require("argon2"));
const scryptAsync = (0, util_1.promisify)(crypto_1.scrypt);
const AES_ALGORITHM = 'aes-256-gcm';
const KEY_VERSION_PREFIX = 'v1';
const MIN_BCRYPT_ROUNDS = 12;
const DEFAULT_BCRYPT_ROUNDS = 12;
let _aesSecretKey = '';
let _previousAesSecretKey = '';
let _hmacSecretKey = '';
let _kycNikEncryptionKey = '';
let _kycKtpEncryptionKey = '';
let _kycSelfieEncryptionKey = '';
let _cryptoInitialized = false;
let _bcryptRounds = DEFAULT_BCRYPT_ROUNDS;
function initializeCrypto(config) {
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
function isCryptoInitialized() {
    return _cryptoInitialized;
}
function getBcryptRounds() {
    return _bcryptRounds;
}
async function deriveKeyAsync(secret, salt) {
    if (!_cryptoInitialized) {
        throw new Error('Crypto module not initialized — call initializeCrypto() before using encrypt/decrypt functions');
    }
    if (!secret) {
        throw new Error('AES secret key is empty — call initializeCrypto() with a non-empty aesSecretKey');
    }
    const key = await scryptAsync(secret, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return key;
}
async function encryptAES(plaintext) {
    const salt = (0, crypto_1.randomBytes)(16);
    const key = await deriveKeyAsync(_aesSecretKey, salt);
    const iv = (0, crypto_1.randomBytes)(12);
    const cipher = (0, crypto_1.createCipheriv)(AES_ALGORITHM, key, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    const authTag = cipher.getAuthTag();
    return `${KEY_VERSION_PREFIX}:${salt.toString('base64')}:${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted}`;
}
async function encryptAESWithKey(plaintext, secretKey, keyId) {
    const effectiveKey = secretKey || _aesSecretKey;
    const salt = (0, crypto_1.randomBytes)(16);
    const key = await deriveKeyAsync(effectiveKey, salt);
    const iv = (0, crypto_1.randomBytes)(12);
    const cipher = (0, crypto_1.createCipheriv)(AES_ALGORITHM, key, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    const authTag = cipher.getAuthTag();
    const prefix = keyId ? `${KEY_VERSION_PREFIX}:${keyId}` : KEY_VERSION_PREFIX;
    return `${prefix}:${salt.toString('base64')}:${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted}`;
}
async function encryptKycNik(plaintext) {
    return encryptAESWithKey(plaintext, _kycNikEncryptionKey, 'nik');
}
async function encryptKycKtp(plaintext) {
    return encryptAESWithKey(plaintext, _kycKtpEncryptionKey, 'ktp');
}
async function encryptKycSelfie(plaintext) {
    return encryptAESWithKey(plaintext, _kycSelfieEncryptionKey, 'selfie');
}
const KYC_KEY_MAP = {
    'nik': () => _kycNikEncryptionKey,
    'ktp': () => _kycKtpEncryptionKey,
    'selfie': () => _kycSelfieEncryptionKey,
};
async function decryptAES(ciphertext) {
    const parts = ciphertext.split(':');
    if (parts.length >= 5 && parts[0] === KEY_VERSION_PREFIX) {
        let keyIdHint;
        let saltB64, ivB64, authTagB64, encrypted;
        if (parts.length === 6 && parts[1] in KYC_KEY_MAP) {
            keyIdHint = parts[1];
            saltB64 = parts[2];
            ivB64 = parts[3];
            authTagB64 = parts[4];
            encrypted = parts[5];
        }
        else if (parts.length === 5) {
            saltB64 = parts[1];
            ivB64 = parts[2];
            authTagB64 = parts[3];
            encrypted = parts[4];
        }
        else {
            throw new Error('Invalid v1 ciphertext format');
        }
        const salt = Buffer.from(saltB64, 'base64');
        const iv = Buffer.from(ivB64, 'base64');
        const authTag = Buffer.from(authTagB64, 'base64');
        if (salt.length !== 16)
            throw new Error(`Invalid salt length: expected 16 bytes, got ${salt.length}`);
        if (iv.length !== 12)
            throw new Error(`Invalid IV length: expected 12 bytes, got ${iv.length}`);
        if (authTag.length !== 16)
            throw new Error(`Invalid auth tag length: expected 16 bytes, got ${authTag.length}`);
        let secretsToTry;
        if (keyIdHint && KYC_KEY_MAP[keyIdHint]) {
            const primaryKey = KYC_KEY_MAP[keyIdHint]();
            secretsToTry = primaryKey ? [primaryKey] : [];
            if (_aesSecretKey && !secretsToTry.includes(_aesSecretKey))
                secretsToTry.push(_aesSecretKey);
            if (_previousAesSecretKey && !secretsToTry.includes(_previousAesSecretKey))
                secretsToTry.push(_previousAesSecretKey);
        }
        else {
            secretsToTry = [_aesSecretKey];
            if (_previousAesSecretKey)
                secretsToTry.push(_previousAesSecretKey);
            if (_kycNikEncryptionKey && _kycNikEncryptionKey !== _aesSecretKey)
                secretsToTry.push(_kycNikEncryptionKey);
            if (_kycKtpEncryptionKey && _kycKtpEncryptionKey !== _aesSecretKey)
                secretsToTry.push(_kycKtpEncryptionKey);
            if (_kycSelfieEncryptionKey && _kycSelfieEncryptionKey !== _aesSecretKey)
                secretsToTry.push(_kycSelfieEncryptionKey);
        }
        for (const secret of secretsToTry) {
            try {
                const key = await deriveKeyAsync(secret, salt);
                const decipher = (0, crypto_1.createDecipheriv)(AES_ALGORITHM, key, iv);
                decipher.setAuthTag(authTag);
                let decrypted = decipher.update(encrypted, 'base64', 'utf8');
                decrypted += decipher.final('utf8');
                return decrypted;
            }
            catch {
                continue;
            }
        }
        throw new Error('Decryption failed (v1): unable to decrypt with any known key');
    }
    if (parts.length === 3) {
        const iv = Buffer.from(parts[0], 'base64');
        const authTag = Buffer.from(parts[1], 'base64');
        const encrypted = parts[2];
        if (iv.length !== 12)
            throw new Error(`Invalid IV length: expected 12 bytes, got ${iv.length}`);
        if (authTag.length !== 16)
            throw new Error(`Invalid auth tag length: expected 16 bytes, got ${authTag.length}`);
        const secretsToTry = [_aesSecretKey];
        if (_previousAesSecretKey)
            secretsToTry.push(_previousAesSecretKey);
        for (const secret of secretsToTry) {
            try {
                const rawKey = Buffer.from(secret, 'hex');
                if (rawKey.length === 32) {
                    const decipher = (0, crypto_1.createDecipheriv)(AES_ALGORITHM, rawKey, iv);
                    decipher.setAuthTag(authTag);
                    let decrypted = decipher.update(encrypted, 'base64', 'utf8');
                    decrypted += decipher.final('utf8');
                    return decrypted;
                }
            }
            catch {
            }
            try {
                const legacySalt = Buffer.from(secret.slice(0, 16), 'utf8');
                const key = await deriveKeyAsync(secret, legacySalt);
                const decipher = (0, crypto_1.createDecipheriv)(AES_ALGORITHM, key, iv);
                decipher.setAuthTag(authTag);
                let decrypted = decipher.update(encrypted, 'base64', 'utf8');
                decrypted += decipher.final('utf8');
                return decrypted;
            }
            catch {
                continue;
            }
        }
        throw new Error('Decryption failed: unable to decrypt with any known key');
    }
    throw new Error('Invalid ciphertext format: expected v1:salt:iv:authTag:ciphertext or legacy iv:authTag:ciphertext');
}
function hmacSHA256(value) {
    if (!_cryptoInitialized) {
        throw new Error('Crypto module not initialized — call initializeCrypto() before using HMAC functions');
    }
    if (!_hmacSecretKey) {
        throw new Error('HMAC secret key is empty — call initializeCrypto() with a non-empty hmacSecretKey');
    }
    return (0, crypto_1.createHmac)('sha256', _hmacSecretKey).update(value).digest('hex');
}
function hmacPinDigest(pepper, pin) {
    return (0, crypto_1.createHmac)('sha256', pepper).update(pin).digest('base64');
}
async function bcryptHash(value, rounds) {
    const effectiveRounds = rounds ?? _bcryptRounds;
    return bcrypt.hash(value, Math.max(MIN_BCRYPT_ROUNDS, effectiveRounds));
}
async function bcryptCompare(value, hash) {
    return bcrypt.compare(value, hash);
}
function sha256(value) {
    return (0, crypto_1.createHash)('sha256').update(value).digest('hex');
}
let _nikHashSalt = null;
function getNikHashSalt() {
    if (_nikHashSalt)
        return _nikHashSalt;
    if (!_hmacSecretKey) {
        throw new Error('HMAC secret key is required for NIK hashing — call initializeCrypto() first');
    }
    _nikHashSalt = (0, crypto_1.createHash)('sha256').update(_hmacSecretKey + ':nik-argon2-salt').digest().subarray(0, 16);
    return _nikHashSalt;
}
async function argon2HashNik(value) {
    const salt = getNikHashSalt();
    const raw = await argon2.hash(value, {
        type: argon2.argon2id,
        memoryCost: 65536,
        timeCost: 3,
        parallelism: 1,
        salt,
        raw: true,
    });
    return raw.toString('hex');
}
