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
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
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
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var UploadService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.UploadService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const client_s3_1 = require("@aws-sdk/client-s3");
const crypto_1 = require("crypto");
const s3_request_presigner_1 = require("@aws-sdk/s3-request-presigner");
const nanoid_1 = require("nanoid");
const presigned_url_dto_1 = require("./dto/presigned-url.dto");
const redis_service_1 = require("../../redis/redis.service");
const ErrorCodes = __importStar(require("../../common/constants/error-codes"));
const nanoid = (0, nanoid_1.customAlphabet)('1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', 10);
const ALLOWED_CONTENT_TYPES = {
    [presigned_url_dto_1.UploadPurpose.KYC_KTP]: ['image/jpeg', 'image/png', 'image/webp'],
    [presigned_url_dto_1.UploadPurpose.KYC_SELFIE]: ['image/jpeg', 'image/png', 'image/webp'],
    [presigned_url_dto_1.UploadPurpose.AVATAR]: ['image/jpeg', 'image/png', 'image/webp'],
    [presigned_url_dto_1.UploadPurpose.CHAT_ATTACHMENT]: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
    [presigned_url_dto_1.UploadPurpose.DISPUTE_EVIDENCE]: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
    [presigned_url_dto_1.UploadPurpose.REPORT_EVIDENCE]: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
    [presigned_url_dto_1.UploadPurpose.DELIVERY_PROOF]: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
};
const MIN_FILE_SIZE = 1024;
const MAX_FILE_SIZE = {
    [presigned_url_dto_1.UploadPurpose.KYC_KTP]: 5 * 1024 * 1024,
    [presigned_url_dto_1.UploadPurpose.KYC_SELFIE]: 5 * 1024 * 1024,
    [presigned_url_dto_1.UploadPurpose.AVATAR]: 2 * 1024 * 1024,
    [presigned_url_dto_1.UploadPurpose.CHAT_ATTACHMENT]: 10 * 1024 * 1024,
    [presigned_url_dto_1.UploadPurpose.DISPUTE_EVIDENCE]: 10 * 1024 * 1024,
    [presigned_url_dto_1.UploadPurpose.REPORT_EVIDENCE]: 10 * 1024 * 1024,
    [presigned_url_dto_1.UploadPurpose.DELIVERY_PROOF]: 10 * 1024 * 1024,
};
const CONFIRMED_KEY_TTL_SECONDS = 86_400;
const MAGIC_BYTES = [
    { mime: 'image/jpeg', runs: [{ offset: 0, bytes: [0xFF, 0xD8, 0xFF] }] },
    { mime: 'image/png', runs: [{ offset: 0, bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] }] },
    {
        mime: 'image/webp',
        runs: [
            { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
            { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
        ],
    },
    { mime: 'application/pdf', runs: [{ offset: 0, bytes: [0x25, 0x50, 0x44, 0x46] }] },
    { mime: 'image/heic', runs: [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63] }] },
    { mime: 'image/heic', runs: [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x78] }] },
    { mime: 'image/heif', runs: [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70, 0x6D, 0x69, 0x66, 0x31] }] },
    { mime: 'image/heif', runs: [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70, 0x6D, 0x73, 0x66, 0x31] }] },
    { mime: 'image/avif', runs: [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66] }] },
    { mime: 'image/avif', runs: [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x73] }] },
];
const MIME_HEADER_BYTES = 32;
function detectMimeFromBytes(header) {
    for (const sig of MAGIC_BYTES) {
        const allRunsMatch = sig.runs.every((run) => {
            if (header.length < run.offset + run.bytes.length)
                return false;
            for (let i = 0; i < run.bytes.length; i++) {
                if (header[run.offset + i] !== run.bytes[i])
                    return false;
            }
            return true;
        });
        if (allRunsMatch)
            return sig.mime;
    }
    return null;
}
function sanitizeStoredFileName(rawFileName) {
    let s = (rawFileName || '').replace(/[^a-zA-Z0-9._-]/g, '_');
    s = s.replace(/^\.+/, '');
    s = s.replace(/_+/g, '_');
    if (s.length > 120)
        s = s.slice(0, 120);
    if (!s || s === '.' || s === '_')
        s = 'file';
    return s;
}
const FILE_KEY_PATTERN = /^uploads\/[a-z-]+\/[a-zA-Z0-9_-]+\/[\w.-]+$/;
function isSafeFileKey(fileKey) {
    if (typeof fileKey !== 'string')
        return false;
    if (fileKey.length === 0 || fileKey.length > 512)
        return false;
    if (fileKey.includes('..') || fileKey.includes('//') || fileKey.includes('\\') || fileKey.includes('%'))
        return false;
    return FILE_KEY_PATTERN.test(fileKey);
}
const PURPOSE_VISIBILITY = {
    [presigned_url_dto_1.UploadPurpose.KYC_KTP]: 'private',
    [presigned_url_dto_1.UploadPurpose.KYC_SELFIE]: 'private',
    [presigned_url_dto_1.UploadPurpose.AVATAR]: 'public',
    [presigned_url_dto_1.UploadPurpose.CHAT_ATTACHMENT]: 'private',
    [presigned_url_dto_1.UploadPurpose.DISPUTE_EVIDENCE]: 'private',
    [presigned_url_dto_1.UploadPurpose.REPORT_EVIDENCE]: 'private',
    [presigned_url_dto_1.UploadPurpose.DELIVERY_PROOF]: 'private',
};
const PURPOSE_FOLDER_MAP_INTERNAL = {
    [presigned_url_dto_1.UploadPurpose.KYC_KTP]: 'kyc-ktp',
    [presigned_url_dto_1.UploadPurpose.KYC_SELFIE]: 'kyc-selfie',
    [presigned_url_dto_1.UploadPurpose.AVATAR]: 'avatars',
    [presigned_url_dto_1.UploadPurpose.CHAT_ATTACHMENT]: 'chat-attachments',
    [presigned_url_dto_1.UploadPurpose.DISPUTE_EVIDENCE]: 'dispute-evidence',
    [presigned_url_dto_1.UploadPurpose.REPORT_EVIDENCE]: 'report-evidence',
    [presigned_url_dto_1.UploadPurpose.DELIVERY_PROOF]: 'delivery-proof',
};
const PURPOSE_BY_FOLDER = Object.fromEntries(Object.keys(PURPOSE_FOLDER_MAP_INTERNAL)
    .map((p) => [PURPOSE_FOLDER_MAP_INTERNAL[p], p]));
const PRIVATE_FOLDER_PREFIXES = Object.keys(PURPOSE_VISIBILITY)
    .filter((p) => PURPOSE_VISIBILITY[p] === 'private')
    .map((p) => `uploads/${PURPOSE_FOLDER_MAP_INTERNAL[p]}/`);
function isPrivatePath(fileKey) {
    return PRIVATE_FOLDER_PREFIXES.some(prefix => fileKey.startsWith(prefix))
        || fileKey.startsWith('uploads/account-exports/');
}
let UploadService = UploadService_1 = class UploadService {
    constructor(configService, redis) {
        this.configService = configService;
        this.redis = redis;
        this.logger = new common_1.Logger(UploadService_1.name);
        this._s3Client = null;
    }
    getS3Client() {
        if (this._s3Client)
            return this._s3Client;
        const accessKeyId = this.configService.get('r2.accessKeyId');
        const secretAccessKey = this.configService.get('r2.secretAccessKey');
        if (!accessKeyId || !secretAccessKey) {
            throw new Error('R2 credentials (R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY) are not configured. File upload is unavailable.');
        }
        const endpointUrl = this.configService.get('r2.endpointUrl');
        if (!endpointUrl) {
            throw new Error('R2 endpoint URL is not configured (R2_ACCOUNT_ID missing). File upload is unavailable.');
        }
        this._s3Client = new client_s3_1.S3Client({
            region: 'auto',
            endpoint: endpointUrl,
            credentials: { accessKeyId, secretAccessKey },
            forcePathStyle: true,
        });
        return this._s3Client;
    }
    getPrivateBucket() {
        const bucket = this.configService.get('r2.bucketPrivate');
        if (!bucket)
            throw new Error('R2 private bucket name is not configured (r2.bucketPrivate)');
        return bucket;
    }
    getPublicBucket() {
        const bucket = this.configService.get('r2.bucketPublic');
        if (!bucket)
            throw new Error('R2 public bucket name is not configured (r2.bucketPublic)');
        return bucket;
    }
    getBucketForKey(fileKey) {
        return isPrivatePath(fileKey) ? this.getPrivateBucket() : this.getPublicBucket();
    }
    async generatePresignedUrl(userId, purpose, fileName, contentType, fileSize) {
        const allowedTypes = ALLOWED_CONTENT_TYPES[purpose];
        if (!allowedTypes.includes(contentType)) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.MIME_TYPE_MISMATCH,
                message: `Content type ${contentType} is not allowed for ${purpose}. Allowed: ${allowedTypes.join(', ')}`,
            });
        }
        const maxSize = MAX_FILE_SIZE[purpose];
        if (fileSize < MIN_FILE_SIZE || fileSize > maxSize) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.VALIDATION_ERROR,
                message: `File size must be between ${MIN_FILE_SIZE} bytes and ${maxSize} bytes for ${purpose}`,
            });
        }
        const sanitizedFileName = sanitizeStoredFileName(fileName);
        const timestamp = Date.now();
        const randomSuffix = nanoid();
        const folder = UploadService_1.PURPOSE_FOLDER_MAP[purpose];
        const fileKey = `uploads/${folder}/${userId}/${timestamp}-${randomSuffix}-${sanitizedFileName}`;
        const bucket = this.getBucket(purpose);
        const EXPIRY_BY_PURPOSE = {
            [presigned_url_dto_1.UploadPurpose.KYC_KTP]: 600,
            [presigned_url_dto_1.UploadPurpose.KYC_SELFIE]: 600,
            [presigned_url_dto_1.UploadPurpose.AVATAR]: 300,
            [presigned_url_dto_1.UploadPurpose.CHAT_ATTACHMENT]: 900,
            [presigned_url_dto_1.UploadPurpose.DISPUTE_EVIDENCE]: 1800,
            [presigned_url_dto_1.UploadPurpose.REPORT_EVIDENCE]: 1800,
            [presigned_url_dto_1.UploadPurpose.DELIVERY_PROOF]: 1200,
        };
        const expiresIn = EXPIRY_BY_PURPOSE[purpose] ?? this.configService.get('r2.presignExpires') ?? 900;
        let uploadUrl;
        try {
            const command = new client_s3_1.PutObjectCommand({
                Bucket: bucket,
                Key: fileKey,
                ContentType: contentType,
                ContentLength: fileSize,
            });
            uploadUrl = await (0, s3_request_presigner_1.getSignedUrl)(this.getS3Client(), command, {
                expiresIn,
                signableHeaders: new Set(['content-type', 'content-length']),
            });
        }
        catch (error) {
            this.logger.error(`Failed to generate presigned URL for key=${fileKey}`, error instanceof Error ? error.stack : error);
            throw error;
        }
        return {
            uploadUrl,
            fileKey,
            expiresIn,
            minFileSize: MIN_FILE_SIZE,
            maxFileSize: maxSize,
        };
    }
    async confirmUpload(userId, fileKey, sha256) {
        let decodedKey;
        try {
            decodedKey = decodeURIComponent(fileKey);
        }
        catch {
            throw new common_1.BadRequestException({
                code: ErrorCodes.INVALID_FILE_TYPE,
                message: 'Invalid file key encoding',
            });
        }
        if (!isSafeFileKey(decodedKey)) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.INVALID_FILE_TYPE,
                message: 'Invalid file key format',
            });
        }
        const segments = decodedKey.split('/');
        if (segments.length !== 4 || segments[2] !== userId) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.INVALID_FILE_TYPE,
                message: 'File key does not belong to this user',
            });
        }
        const folderName = segments[1];
        const detectedPurpose = PURPOSE_BY_FOLDER[folderName];
        if (!detectedPurpose) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.INVALID_FILE_TYPE,
                message: 'Invalid file key format',
            });
        }
        const redisKey = `confirmed_upload:${userId}:${decodedKey}`;
        const isNew = await this.redis.setNx(redisKey, '1', CONFIRMED_KEY_TTL_SECONDS);
        if (!isNew) {
            throw new common_1.ConflictException({
                code: ErrorCodes.UPLOAD_ALREADY_CONFIRMED,
                message: 'This file has already been confirmed. Use a fresh upload for a new submission.',
            });
        }
        const bucket = this.getBucketForKey(decodedKey);
        let contentLength;
        let storedContentType;
        try {
            const command = new client_s3_1.HeadObjectCommand({ Bucket: bucket, Key: decodedKey });
            const head = await this.getS3Client().send(command);
            contentLength = head.ContentLength;
            storedContentType = head.ContentType;
        }
        catch (error) {
            await this.redis.del(redisKey);
            this.logger.error(`R2 HeadObject failed for key=${decodedKey} bucket=${bucket}`, error instanceof Error ? error.stack : error);
            throw new common_1.NotFoundException({
                code: ErrorCodes.FILE_NOT_FOUND_OR_EXPIRED,
                message: 'File not found in storage. It may not have been uploaded or has expired.',
            });
        }
        if (detectedPurpose) {
            const allowedTypes = ALLOWED_CONTENT_TYPES[detectedPurpose];
            if (storedContentType && !allowedTypes.includes(storedContentType)) {
                await this.redis.del(redisKey);
                throw new common_1.BadRequestException({
                    code: ErrorCodes.MIME_TYPE_MISMATCH,
                    message: `Stored content type ${storedContentType} is not allowed for this upload slot`,
                });
            }
            if (contentLength !== undefined && contentLength < MIN_FILE_SIZE) {
                await this.redis.del(redisKey);
                throw new common_1.BadRequestException({
                    code: ErrorCodes.INVALID_FILE_TYPE,
                    message: `File is too small (${contentLength} bytes). Minimum size is ${MIN_FILE_SIZE} bytes`,
                });
            }
            const maxSize = MAX_FILE_SIZE[detectedPurpose];
            if (contentLength !== undefined && contentLength > maxSize) {
                await this.redis.del(redisKey);
                throw new common_1.BadRequestException({
                    code: ErrorCodes.FILE_TOO_LARGE,
                    message: `File exceeds maximum allowed size of ${Math.round(maxSize / 1024 / 1024)} MB for this upload type`,
                });
            }
            try {
                const getCmd = new client_s3_1.GetObjectCommand({ Bucket: bucket, Key: decodedKey, Range: `bytes=0-${MIME_HEADER_BYTES - 1}` });
                const getResp = await this.getS3Client().send(getCmd);
                const chunks = [];
                const body = getResp.Body;
                for await (const chunk of body) {
                    chunks.push(chunk);
                }
                const header = Buffer.concat(chunks);
                const detectedMime = detectMimeFromBytes(header);
                if (!detectedMime) {
                    await this.redis.del(redisKey);
                    throw new common_1.BadRequestException({
                        code: ErrorCodes.MIME_TYPE_MISMATCH,
                        message: 'Unable to identify file type from content. Upload rejected.',
                    });
                }
                if (storedContentType && detectedMime !== storedContentType) {
                    await this.redis.del(redisKey);
                    throw new common_1.BadRequestException({
                        code: ErrorCodes.MIME_TYPE_MISMATCH,
                        message: `File content (${detectedMime}) does not match declared type (${storedContentType})`,
                    });
                }
                if (!allowedTypes.includes(detectedMime)) {
                    await this.redis.del(redisKey);
                    throw new common_1.BadRequestException({
                        code: ErrorCodes.MIME_TYPE_MISMATCH,
                        message: `Actual file type ${detectedMime} is not allowed for this upload slot`,
                    });
                }
            }
            catch (error) {
                if (error instanceof common_1.BadRequestException)
                    throw error;
                this.logger.error(`Magic-byte check failed for key=${decodedKey}: ${error.message}`);
                await this.redis.del(redisKey);
                throw new common_1.BadRequestException({
                    code: ErrorCodes.MIME_TYPE_MISMATCH,
                    message: 'Unable to verify file content integrity. Please re-upload.',
                });
            }
        }
        const result = {
            fileKey: decodedKey,
            confirmed: true,
        };
        if (sha256) {
            let computed;
            try {
                const getCmd = new client_s3_1.GetObjectCommand({ Bucket: bucket, Key: decodedKey });
                const getResp = await this.getS3Client().send(getCmd);
                const hash = (0, crypto_1.createHash)('sha256');
                for await (const chunk of getResp.Body) {
                    hash.update(chunk);
                }
                computed = hash.digest('hex');
            }
            catch (error) {
                this.logger.error(`SHA-256 verification read failed for key=${decodedKey}: ${error.message}`);
                await this.redis.del(redisKey);
                throw new common_1.BadRequestException({
                    code: ErrorCodes.UPLOAD_FAILED,
                    message: 'Unable to verify uploaded file integrity. Please re-upload.',
                });
            }
            if (computed !== sha256.toLowerCase()) {
                this.logger.warn(`SHA-256 mismatch for key=${decodedKey} (expected client hash did not match stored object)`);
                await this.redis.del(redisKey);
                throw new common_1.BadRequestException({
                    code: ErrorCodes.VALIDATION_ERROR,
                    message: 'Uploaded file checksum does not match the provided sha256 value. Please re-upload.',
                });
            }
            result.sha256 = computed;
            result.verified = true;
        }
        return result;
    }
    isConfirmedUploadKey(userId, fileKey) {
        if (!isSafeFileKey(fileKey))
            return Promise.resolve(false);
        const segments = fileKey.split('/');
        if (segments.length !== 4 || segments[2] !== userId || !PURPOSE_BY_FOLDER[segments[1]]) {
            return Promise.resolve(false);
        }
        const redisKey = `confirmed_upload:${userId}:${fileKey}`;
        return this.redis.get(redisKey).then((val) => val !== null);
    }
    async verifyEvidenceFileKeys(userId, fileKeys, evidenceType = 'dispute-evidence') {
        const prefix = `uploads/${evidenceType}/${userId}/`;
        const bucket = this.getPrivateBucket();
        const purpose = evidenceType === 'dispute-evidence' ? presigned_url_dto_1.UploadPurpose.DISPUTE_EVIDENCE : presigned_url_dto_1.UploadPurpose.REPORT_EVIDENCE;
        const maxSize = MAX_FILE_SIZE[purpose];
        for (const key of fileKeys) {
            if (!isSafeFileKey(key) || !key.startsWith(prefix) || key.split('/').length !== 4) {
                throw new common_1.BadRequestException({
                    code: ErrorCodes.FILE_ACCESS_DENIED,
                    message: 'One or more files were not uploaded by you or are not valid evidence files',
                });
            }
            const isConfirmed = await this.isConfirmedUploadKey(userId, key);
            if (!isConfirmed) {
                throw new common_1.BadRequestException({
                    code: ErrorCodes.UPLOAD_NOT_CONFIRMED,
                    message: `File must be confirmed via /upload/confirm before use: ${key}`,
                });
            }
            let contentLength;
            try {
                const command = new client_s3_1.HeadObjectCommand({ Bucket: bucket, Key: key });
                const head = await this.getS3Client().send(command);
                contentLength = head.ContentLength;
            }
            catch {
                throw new common_1.NotFoundException({
                    code: ErrorCodes.FILE_NOT_FOUND_OR_EXPIRED,
                    message: `Evidence file not found in storage: ${key}`,
                });
            }
            if (contentLength !== undefined && contentLength > maxSize) {
                throw new common_1.BadRequestException({
                    code: ErrorCodes.FILE_TOO_LARGE,
                    message: `Evidence file exceeds maximum allowed size of ${Math.round(maxSize / 1024 / 1024)} MB`,
                });
            }
            const consumeKey = `confirmed_upload:${userId}:${key}`;
            const consumed = await this.redis.consumeOnce(consumeKey, { throwOnError: true });
            if (!consumed) {
                throw new common_1.BadRequestException({
                    code: ErrorCodes.UPLOAD_NOT_CONFIRMED,
                    message: `File confirmation has already been consumed: ${key}`,
                });
            }
        }
    }
    async verifyEvidenceFileKeysBatch(userId, fileKeys, fileTypes, evidenceType = 'dispute-evidence') {
        const prefix = `uploads/${evidenceType}/${userId}/`;
        const bucket = this.getPrivateBucket();
        const purpose = evidenceType === 'dispute-evidence' ? presigned_url_dto_1.UploadPurpose.DISPUTE_EVIDENCE : presigned_url_dto_1.UploadPurpose.REPORT_EVIDENCE;
        const maxSize = MAX_FILE_SIZE[purpose];
        const allowedTypes = ALLOWED_CONTENT_TYPES[purpose];
        const results = await Promise.all(fileKeys.map(async (key, idx) => {
            const fileType = fileTypes[idx] || 'application/octet-stream';
            try {
                if (!isSafeFileKey(key) || !key.startsWith(prefix) || key.split('/').length !== 4) {
                    return { fileKey: key, fileType, status: 'error', error: 'File was not uploaded by you or is not a valid evidence file' };
                }
                if (!allowedTypes.includes(fileType)) {
                    return { fileKey: key, fileType, status: 'error', error: `File type not allowed: ${fileType}` };
                }
                const isConfirmed = await this.isConfirmedUploadKey(userId, key);
                if (!isConfirmed) {
                    return { fileKey: key, fileType, status: 'error', error: 'File must be confirmed via /upload/confirm before use' };
                }
                let contentLength;
                try {
                    const command = new client_s3_1.HeadObjectCommand({ Bucket: bucket, Key: key });
                    const head = await this.getS3Client().send(command);
                    contentLength = head.ContentLength;
                    if (head.ContentType && head.ContentType !== fileType) {
                        return { fileKey: key, fileType, status: 'error', error: 'Declared file type does not match the stored object type' };
                    }
                }
                catch {
                    return { fileKey: key, fileType, status: 'error', error: 'Evidence file not found in storage' };
                }
                if (contentLength !== undefined && contentLength > maxSize) {
                    return { fileKey: key, fileType, status: 'error', error: `File exceeds maximum allowed size of ${Math.round(maxSize / 1024 / 1024)} MB` };
                }
                const consumeKey = `confirmed_upload:${userId}:${key}`;
                const consumed = await this.redis.consumeOnce(consumeKey, { throwOnError: true });
                if (!consumed) {
                    return { fileKey: key, fileType, status: 'error', error: 'File confirmation has already been consumed' };
                }
                return { fileKey: key, fileType, status: 'ok' };
            }
            catch {
                return { fileKey: key, fileType, status: 'error', error: 'Unexpected validation error' };
            }
        }));
        return results;
    }
    async verifyUserFileKeys(userId, fileKeys, purpose) {
        const folder = UploadService_1.PURPOSE_FOLDER_MAP[purpose];
        const prefix = `uploads/${folder}/${userId}/`;
        const allowedTypes = ALLOWED_CONTENT_TYPES[purpose];
        const maxSize = MAX_FILE_SIZE[purpose];
        if (!Array.isArray(fileKeys) || fileKeys.length > 5) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Too many attachment files' });
        }
        if (new Set(fileKeys).size !== fileKeys.length) {
            throw new common_1.BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Duplicate attachment file keys are not allowed' });
        }
        for (const fileKey of fileKeys) {
            if (!isSafeFileKey(fileKey) || !fileKey.startsWith(prefix) || fileKey.split('/').length !== 4) {
                throw new common_1.BadRequestException({ code: ErrorCodes.FILE_ACCESS_DENIED, message: 'Attachment file key is not owned by this user or has the wrong purpose' });
            }
            if (!(await this.isConfirmedUploadKey(userId, fileKey))) {
                throw new common_1.BadRequestException({ code: ErrorCodes.UPLOAD_NOT_CONFIRMED, message: 'Attachment must be confirmed before it can be attached' });
            }
            let head;
            try {
                head = await this.getS3Client().send(new client_s3_1.HeadObjectCommand({ Bucket: this.getPrivateBucket(), Key: fileKey }));
            }
            catch {
                throw new common_1.NotFoundException({ code: ErrorCodes.FILE_NOT_FOUND_OR_EXPIRED, message: 'Attachment file was not found in storage' });
            }
            if (head.ContentLength === undefined || head.ContentLength < MIN_FILE_SIZE || head.ContentLength > maxSize) {
                throw new common_1.BadRequestException({ code: ErrorCodes.FILE_TOO_LARGE, message: 'Attachment file size is outside the allowed range' });
            }
            if (!head.ContentType || !allowedTypes.includes(head.ContentType)) {
                throw new common_1.BadRequestException({ code: ErrorCodes.MIME_TYPE_MISMATCH, message: 'Attachment content type is not allowed' });
            }
        }
        for (const fileKey of fileKeys) {
            const consumed = await this.redis.consumeOnce(`confirmed_upload:${userId}:${fileKey}`, { throwOnError: true });
            if (!consumed) {
                throw new common_1.ConflictException({ code: ErrorCodes.UPLOAD_NOT_CONFIRMED, message: 'Attachment confirmation has already been consumed' });
            }
        }
    }
    async getFileSize(fileKey) {
        if (!isSafeFileKey(fileKey) || !this.isKnownStorageKey(fileKey))
            throw new common_1.BadRequestException({ code: ErrorCodes.INVALID_FILE_TYPE, message: 'Invalid file key format' });
        const bucket = this.getBucketForKey(fileKey);
        const command = new client_s3_1.HeadObjectCommand({ Bucket: bucket, Key: fileKey });
        const head = await this.getS3Client().send(command);
        return head.ContentLength ?? 0;
    }
    async generateDownloadUrl(fileKey, expiresIn = 300) {
        if (!isSafeFileKey(fileKey) || !this.isKnownStorageKey(fileKey))
            throw new common_1.BadRequestException({ code: ErrorCodes.INVALID_FILE_TYPE, message: 'Invalid file key format' });
        const bucket = this.getBucketForKey(fileKey);
        const safeExpiresIn = Math.min(Math.max(Math.floor(expiresIn), 60), 3600);
        const rawFileName = fileKey.split('/').pop() || 'download';
        const sanitizedFileName = sanitizeStoredFileName(rawFileName);
        const command = new client_s3_1.GetObjectCommand({
            Bucket: bucket,
            Key: fileKey,
            ResponseContentDisposition: `attachment; filename="${sanitizedFileName}"`,
        });
        return (0, s3_request_presigner_1.getSignedUrl)(this.getS3Client(), command, { expiresIn: safeExpiresIn });
    }
    async uploadPrivateAccountExport(userId, content) {
        const fileKey = `uploads/account-exports/${userId}/${nanoid()}.json`;
        if (!isSafeFileKey(fileKey)) {
            throw new Error('Generated account export key failed storage safety validation');
        }
        const bucket = this.getPrivateBucket();
        await this.getS3Client().send(new client_s3_1.PutObjectCommand({
            Bucket: bucket,
            Key: fileKey,
            Body: content,
            ContentType: 'application/json; charset=utf-8',
            ContentDisposition: 'attachment; filename="kahade-account-export.json"',
            Metadata: { owner: userId, purpose: 'account-export' },
        }));
        const configuredExpiry = this.configService.get('r2.presignExpires') ?? 900;
        const expiresIn = Math.min(Math.max(Math.floor(configuredExpiry), 60), 3600);
        return {
            downloadUrl: await this.generateDownloadUrl(fileKey, expiresIn),
            expiresAt: new Date(Date.now() + expiresIn * 1000),
        };
    }
    async uploadDirect(userId, purpose, fileName, contentType, fileBuffer) {
        const allowedTypes = ALLOWED_CONTENT_TYPES[purpose];
        if (!allowedTypes.includes(contentType)) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.MIME_TYPE_MISMATCH,
                message: `Content type ${contentType} is not allowed for ${purpose}. Allowed: ${allowedTypes.join(', ')}`,
            });
        }
        if (fileBuffer.length < MIN_FILE_SIZE) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.INVALID_FILE_TYPE,
                message: `File is too small (${fileBuffer.length} bytes). Minimum size is ${MIN_FILE_SIZE} bytes`,
            });
        }
        const maxSize = MAX_FILE_SIZE[purpose];
        if (fileBuffer.length > maxSize) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.FILE_TOO_LARGE,
                message: `File exceeds maximum allowed size of ${Math.round(maxSize / 1024 / 1024)} MB`,
            });
        }
        const header = fileBuffer.subarray(0, MIME_HEADER_BYTES);
        const detectedMime = detectMimeFromBytes(header);
        if (!detectedMime) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.MIME_TYPE_MISMATCH,
                message: 'Unable to identify file type from content. The file may be corrupted or unsupported.',
            });
        }
        if (detectedMime !== contentType) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.MIME_TYPE_MISMATCH,
                message: `File content (${detectedMime}) does not match declared type (${contentType})`,
            });
        }
        const sanitizedFileName = sanitizeStoredFileName(fileName);
        const timestamp = Date.now();
        const randomSuffix = nanoid();
        const folder = UploadService_1.PURPOSE_FOLDER_MAP[purpose];
        const fileKey = `uploads/${folder}/${userId}/${timestamp}-${randomSuffix}-${sanitizedFileName}`;
        const bucket = this.getBucket(purpose);
        try {
            const command = new client_s3_1.PutObjectCommand({
                Bucket: bucket,
                Key: fileKey,
                ContentType: contentType,
                Body: fileBuffer,
            });
            await this.getS3Client().send(command);
        }
        catch (error) {
            this.logger.error(`Direct upload to R2 failed for key=${fileKey}`, error instanceof Error ? error.stack : error);
            throw new common_1.BadRequestException({
                code: ErrorCodes.UPLOAD_FAILED,
                message: 'Failed to upload file to storage. Please try again.',
            });
        }
        const redisKey = `confirmed_upload:${userId}:${fileKey}`;
        await this.redis.setNx(redisKey, '1', CONFIRMED_KEY_TTL_SECONDS);
        let fileUrl;
        if (isPrivatePath(fileKey)) {
            fileUrl = fileKey;
        }
        else {
            const publicUrl = this.configService.get('r2.publicUrl');
            fileUrl = publicUrl ? `${publicUrl.replace(/\/+$/, '')}/${fileKey}` : fileKey;
        }
        return { fileKey, fileUrl };
    }
    async cleanupFileKeys(userId, fileKeys) {
        let deleted = 0;
        const errors = [];
        for (const fileKey of fileKeys) {
            if (!isSafeFileKey(fileKey)) {
                errors.push({ fileKey: String(fileKey).slice(0, 128), reason: 'invalid file key' });
                continue;
            }
            const segments = fileKey.split('/');
            if (segments.length !== 4 || segments[2] !== userId) {
                errors.push({ fileKey, reason: 'not owned by user' });
                continue;
            }
            const bucket = this.getBucketForKey(fileKey);
            try {
                const command = new client_s3_1.DeleteObjectCommand({ Bucket: bucket, Key: fileKey });
                await this.getS3Client().send(command);
                const redisKey = `confirmed_upload:${userId}:${fileKey}`;
                await this.redis.del(redisKey);
                deleted++;
            }
            catch (error) {
                this.logger.warn(`Failed to delete file key=${fileKey}`, error instanceof Error ? error.message : error);
                errors.push({ fileKey, reason: 'storage deletion failed' });
            }
        }
        return { deleted, errors };
    }
    isKnownStorageKey(fileKey) {
        const parts = fileKey.split('/');
        return parts.length === 4 && (Boolean(PURPOSE_BY_FOLDER[parts[1]]) || parts[1] === 'account-exports');
    }
    getBucket(purpose) {
        const folder = UploadService_1.PURPOSE_FOLDER_MAP[purpose];
        const syntheticKey = `uploads/${folder}/`;
        return this.getBucketForKey(syntheticKey);
    }
};
exports.UploadService = UploadService;
UploadService.PURPOSE_FOLDER_MAP = PURPOSE_FOLDER_MAP_INTERNAL;
exports.UploadService = UploadService = UploadService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [config_1.ConfigService,
        redis_service_1.RedisService])
], UploadService);
