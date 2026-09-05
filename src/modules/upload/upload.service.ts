import { Injectable, BadRequestException, NotFoundException, Logger, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, PutObjectCommand, HeadObjectCommand, HeadObjectCommandOutput, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'crypto';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { customAlphabet } from 'nanoid';
import { UploadPurpose } from './dto/presigned-url.dto';
import { RedisService } from '../../redis/redis.service';
import * as ErrorCodes from '../../common/constants/error-codes';

const nanoid = customAlphabet('1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', 10);

// NOTE (audit): image/heic, image/heif and image/avif are recognised by
// `detectMimeFromBytes` but are intentionally NOT allowed here. The effect is
// that an iPhone HEIC upload is rejected with a clear MIME_TYPE_MISMATCH rather
// than a vague "unable to identify file type". Admitting them would require
// server-side transcoding first: browsers do not render HEIC, so the admin KYC
// review screen and the dispute-evidence viewer would show broken images.
// See OPEN QUESTION in the audit report.
const ALLOWED_CONTENT_TYPES: Record<UploadPurpose, string[]> = {
  [UploadPurpose.KYC_KTP]: ['image/jpeg', 'image/png', 'image/webp'],
  [UploadPurpose.KYC_SELFIE]: ['image/jpeg', 'image/png', 'image/webp'],
  [UploadPurpose.AVATAR]: ['image/jpeg', 'image/png', 'image/webp'],
  [UploadPurpose.CHAT_ATTACHMENT]: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
  [UploadPurpose.DISPUTE_EVIDENCE]: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
  [UploadPurpose.REPORT_EVIDENCE]: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
  [UploadPurpose.DELIVERY_PROOF]: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
};

const MIN_FILE_SIZE = 1024;

const MAX_FILE_SIZE: Record<UploadPurpose, number> = {
  [UploadPurpose.KYC_KTP]: 5 * 1024 * 1024,
  [UploadPurpose.KYC_SELFIE]: 5 * 1024 * 1024,
  [UploadPurpose.AVATAR]: 2 * 1024 * 1024,
  [UploadPurpose.CHAT_ATTACHMENT]: 10 * 1024 * 1024,
  [UploadPurpose.DISPUTE_EVIDENCE]: 10 * 1024 * 1024,
  [UploadPurpose.REPORT_EVIDENCE]: 10 * 1024 * 1024,
  [UploadPurpose.DELIVERY_PROOF]: 10 * 1024 * 1024,
};

const CONFIRMED_KEY_TTL_SECONDS = 86_400;

// B-36 (audit-fix): expand magic-byte coverage to include HEIC/AVIF (modern
// iPhone/Android camera default), and bump the inspection window so the
// ftyp-prefixed signatures can be matched. We deliberately do NOT add SVG --
// SVG is XML and can carry script payloads, and re-encoding it server-side
// is not in scope for this fix; SVG remains rejected by `detectMimeFromBytes`
// returning null.
// Each entry may declare MULTIPLE anchored byte-runs; every run must match.
// This matters for container formats (RIFF/WEBP, ISO-BMFF) where checking only
// the inner brand at a non-zero offset would let an attacker prepend arbitrary
// bytes (e.g. an HTML/JS polyglot) and still be classified as an image.
const MAGIC_BYTES: { mime: string; runs: { offset: number; bytes: number[] }[] }[] = [
  { mime: 'image/jpeg', runs: [{ offset: 0, bytes: [0xFF, 0xD8, 0xFF] }] },
  { mime: 'image/png', runs: [{ offset: 0, bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] }] },
  // B-38 (audit-fix): WEBP is a RIFF container — the 'RIFF' tag at offset 0 was
  // NOT being checked, so any file with 'WEBP' at bytes 8..11 (arbitrary first
  // 8 bytes) passed as image/webp. Anchor both runs.
  {
    mime: 'image/webp',
    runs: [
      { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] }, // 'RIFF'
      { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] }, // 'WEBP'
    ],
  },
  { mime: 'application/pdf', runs: [{ offset: 0, bytes: [0x25, 0x50, 0x44, 0x46] }] },
  // ISO BMFF "ftyp" container variants: HEIC, HEIF, AVIF.
  // Bytes 4..7 == 'ftyp', bytes 8..11 carry the brand.
  { mime: 'image/heic', runs: [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63] }] }, // ftypheic
  { mime: 'image/heic', runs: [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x78] }] }, // ftypheix
  { mime: 'image/heif', runs: [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70, 0x6D, 0x69, 0x66, 0x31] }] }, // ftypmif1
  { mime: 'image/heif', runs: [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70, 0x6D, 0x73, 0x66, 0x31] }] }, // ftypmsf1
  { mime: 'image/avif', runs: [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66] }] }, // ftypavif
  { mime: 'image/avif', runs: [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x73] }] }, // ftypavis
];

const MIME_HEADER_BYTES = 32;

function detectMimeFromBytes(header: Buffer): string | null {
  for (const sig of MAGIC_BYTES) {
    const allRunsMatch = sig.runs.every((run) => {
      if (header.length < run.offset + run.bytes.length) return false;
      for (let i = 0; i < run.bytes.length; i++) {
        if (header[run.offset + i] !== run.bytes[i]) return false;
      }
      return true;
    });
    if (allRunsMatch) return sig.mime;
  }
  return null;
}

// B-37 (audit-fix): centralised filename sanitiser used by every code path
// that builds an R2 object-key from a user-supplied filename. Rules:
//   - allow only [a-zA-Z0-9._-]
//   - replace everything else with `_`
//   - strip leading dots (so we don't create ".env"-shaped keys)
//   - collapse runs of `_` and trim the length
//   - if the result is empty (e.g. caller passed "...") fall back to "file"
function sanitizeStoredFileName(rawFileName: string): string {
  let s = (rawFileName || '').replace(/[^a-zA-Z0-9._-]/g, '_');
  s = s.replace(/^\.+/, '');
  s = s.replace(/_+/g, '_');
  if (s.length > 120) s = s.slice(0, 120);
  if (!s || s === '.' || s === '_') s = 'file';
  return s;
}

const FILE_KEY_PATTERN = /^uploads\/[a-z-]+\/[a-zA-Z0-9_-]+\/[\w.-]+$/;

// B-39 (audit-fix): single guard that EVERY code path turning a client-supplied
// file key into an S3 operation must run. Previously only `confirmUpload()`
// performed the traversal + shape check; `cleanupFileKeys()` and
// `verifyEvidenceFileKeys*()` only asserted `segments[2] === userId`, so a key
// such as `uploads/dispute-evidence/<myId>/../../kyc-ktp/<victimId>/ktp.jpg`
// passed their ownership test and was handed straight to R2.
function isSafeFileKey(fileKey: unknown): fileKey is string {
  if (typeof fileKey !== 'string') return false;
  if (fileKey.length === 0 || fileKey.length > 512) return false;
  if (fileKey.includes('..') || fileKey.includes('//') || fileKey.includes('\\') || fileKey.includes('%')) return false;
  return FILE_KEY_PATTERN.test(fileKey);
}

// Type-safe visibility declaration: any new UploadPurpose forces a TS error here
// (Record<UploadPurpose,...> is exhaustive). Public-by-default is no longer possible.
const PURPOSE_VISIBILITY: Record<UploadPurpose, 'private' | 'public'> = {
  [UploadPurpose.KYC_KTP]: 'private',
  [UploadPurpose.KYC_SELFIE]: 'private',
  [UploadPurpose.AVATAR]: 'public',
  [UploadPurpose.CHAT_ATTACHMENT]: 'private',
  [UploadPurpose.DISPUTE_EVIDENCE]: 'private',
  [UploadPurpose.REPORT_EVIDENCE]: 'private',
  [UploadPurpose.DELIVERY_PROOF]: 'private',
};

const PURPOSE_FOLDER_MAP_INTERNAL: Record<UploadPurpose, string> = {
  [UploadPurpose.KYC_KTP]: 'kyc-ktp',
  [UploadPurpose.KYC_SELFIE]: 'kyc-selfie',
  [UploadPurpose.AVATAR]: 'avatars',
  [UploadPurpose.CHAT_ATTACHMENT]: 'chat-attachments',
  [UploadPurpose.DISPUTE_EVIDENCE]: 'dispute-evidence',
  [UploadPurpose.REPORT_EVIDENCE]: 'report-evidence',
  [UploadPurpose.DELIVERY_PROOF]: 'delivery-proof',
};

// Reverse of PURPOSE_FOLDER_MAP_INTERNAL, derived rather than hand-written so a new
// UploadPurpose cannot be added to one map and forgotten in the other. Values are
// `UploadPurpose | undefined` because the folder segment comes from a client-supplied
// file key, so an unknown folder must be representable and rejected by the caller.
const PURPOSE_BY_FOLDER: Record<string, UploadPurpose | undefined> = Object.fromEntries(
  (Object.keys(PURPOSE_FOLDER_MAP_INTERNAL) as UploadPurpose[])
    .map((p) => [PURPOSE_FOLDER_MAP_INTERNAL[p], p]),
);

// Derived from the typed visibility map — the source of truth is PURPOSE_VISIBILITY.
const PRIVATE_FOLDER_PREFIXES: string[] = (Object.keys(PURPOSE_VISIBILITY) as UploadPurpose[])
  .filter((p) => PURPOSE_VISIBILITY[p] === 'private')
  .map((p) => `uploads/${PURPOSE_FOLDER_MAP_INTERNAL[p]}/`);

function isPrivatePath(fileKey: string): boolean {
  return PRIVATE_FOLDER_PREFIXES.some(prefix => fileKey.startsWith(prefix))
    || fileKey.startsWith('uploads/account-exports/');
}

@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);
  private _s3Client: S3Client | null = null;

  constructor(
    private configService: ConfigService,
    private redis: RedisService,
  ) {}

  private getS3Client(): S3Client {
    if (this._s3Client) return this._s3Client;

    const accessKeyId = this.configService.get<string>('r2.accessKeyId');
    const secretAccessKey = this.configService.get<string>('r2.secretAccessKey');

    if (!accessKeyId || !secretAccessKey) {
      throw new Error(
        'R2 credentials (R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY) are not configured. File upload is unavailable.',
      );
    }

    const endpointUrl = this.configService.get<string>('r2.endpointUrl');
    if (!endpointUrl) {
      throw new Error(
        'R2 endpoint URL is not configured (R2_ACCOUNT_ID missing). File upload is unavailable.',
      );
    }

    this._s3Client = new S3Client({
      region: 'auto',
      endpoint: endpointUrl,
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: true,
    });

    return this._s3Client;
  }

  private getPrivateBucket(): string {
    const bucket = this.configService.get<string>('r2.bucketPrivate');
    if (!bucket) throw new Error('R2 private bucket name is not configured (r2.bucketPrivate)');
    return bucket;
  }

  private getPublicBucket(): string {
    const bucket = this.configService.get<string>('r2.bucketPublic');
    if (!bucket) throw new Error('R2 public bucket name is not configured (r2.bucketPublic)');
    return bucket;
  }

  private getBucketForKey(fileKey: string): string {
    return isPrivatePath(fileKey) ? this.getPrivateBucket() : this.getPublicBucket();
  }

  async generatePresignedUrl(userId: string, purpose: UploadPurpose, fileName: string, contentType: string, fileSize: number): Promise<{ uploadUrl: string; fileKey: string; expiresIn: number; minFileSize: number; maxFileSize: number }> {
    const allowedTypes = ALLOWED_CONTENT_TYPES[purpose];
    if (!allowedTypes.includes(contentType)) {
      throw new BadRequestException({
        code: ErrorCodes.MIME_TYPE_MISMATCH,
        message: `Content type ${contentType} is not allowed for ${purpose}. Allowed: ${allowedTypes.join(', ')}`,
      });
    }

    const maxSize = MAX_FILE_SIZE[purpose];
    if (fileSize < MIN_FILE_SIZE || fileSize > maxSize) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: `File size must be between ${MIN_FILE_SIZE} bytes and ${maxSize} bytes for ${purpose}`,
      });
    }

    // B-37 (audit-fix): strip leading dots so a user cannot get a stored
    // filename that looks like a hidden file (".env", ".bash_history") and
    // reject empty or all-underscore names. We also collapse runs of "_" to
    // keep the key short.
    const sanitizedFileName = sanitizeStoredFileName(fileName);
    const timestamp = Date.now();
    const randomSuffix = nanoid();
    const folder = UploadService.PURPOSE_FOLDER_MAP[purpose];
    const fileKey = `uploads/${folder}/${userId}/${timestamp}-${randomSuffix}-${sanitizedFileName}`;

    const bucket = this.getBucket(purpose);
    const EXPIRY_BY_PURPOSE: Record<UploadPurpose, number> = {
      [UploadPurpose.KYC_KTP]: 600,
      [UploadPurpose.KYC_SELFIE]: 600,
      [UploadPurpose.AVATAR]: 300,
      [UploadPurpose.CHAT_ATTACHMENT]: 900,
      [UploadPurpose.DISPUTE_EVIDENCE]: 1800,
      [UploadPurpose.REPORT_EVIDENCE]: 1800,
      [UploadPurpose.DELIVERY_PROOF]: 1200,
    };
    const expiresIn = EXPIRY_BY_PURPOSE[purpose] ?? this.configService.get<number>('r2.presignExpires') ?? 900;

    let uploadUrl: string;
    try {
      // Sign Content-Length so S3/R2 enforces the exact byte size at upload time.
      // Without this, a client requesting a presigned URL for 1KB could PUT a 5GB file,
      // bypassing fileSize validation (storage cost / DoS via oversized uploads).
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: fileKey,
        ContentType: contentType,
        ContentLength: fileSize,
      });
      uploadUrl = await getSignedUrl(this.getS3Client(), command, {
        expiresIn,
        signableHeaders: new Set(['content-type', 'content-length']),
      });
    } catch (error) {
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

  async confirmUpload(userId: string, fileKey: string, sha256?: string): Promise<{ fileKey: string; confirmed: boolean; sha256?: string; verified?: boolean }> {
    let decodedKey: string;
    try {
      decodedKey = decodeURIComponent(fileKey);
    } catch {
      // Malformed percent-encoding (e.g. "%zz") makes decodeURIComponent throw a
      // URIError, which escaped as an unhandled 500 instead of a 400.
      throw new BadRequestException({
        code: ErrorCodes.INVALID_FILE_TYPE,
        message: 'Invalid file key encoding',
      });
    }

    if (!isSafeFileKey(decodedKey)) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_FILE_TYPE,
        message: 'Invalid file key format',
      });
    }

    const segments = decodedKey.split('/');
    if (segments.length !== 4 || segments[2] !== userId) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_FILE_TYPE,
        message: 'File key does not belong to this user',
      });
    }

    const folderName = segments[1];
    const detectedPurpose = PURPOSE_BY_FOLDER[folderName];
    // Reject unknown folders outright. Previously an unrecognised folder simply
    // skipped ALL content validation (`if (detectedPurpose)` below) and still
    // returned confirmed:true, marking the key as usable downstream.
    if (!detectedPurpose) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_FILE_TYPE,
        message: 'Invalid file key format',
      });
    }

    const redisKey = `confirmed_upload:${userId}:${decodedKey}`;
    const isNew = await this.redis.setNx(redisKey, '1', CONFIRMED_KEY_TTL_SECONDS);
    if (!isNew) {
      throw new ConflictException({
        code: ErrorCodes.UPLOAD_ALREADY_CONFIRMED,
        message: 'This file has already been confirmed. Use a fresh upload for a new submission.',
      });
    }

    const bucket = this.getBucketForKey(decodedKey);

    let contentLength: number | undefined;
    let storedContentType: string | undefined;
    try {
      const command = new HeadObjectCommand({ Bucket: bucket, Key: decodedKey });
      const head = await this.getS3Client().send(command) as HeadObjectCommandOutput;
      contentLength = head.ContentLength;
      storedContentType = head.ContentType;
    } catch (error) {
      await this.redis.del(redisKey);
      this.logger.error(`R2 HeadObject failed for key=${decodedKey} bucket=${bucket}`, error instanceof Error ? error.stack : error);
      throw new NotFoundException({
        code: ErrorCodes.FILE_NOT_FOUND_OR_EXPIRED,
        message: 'File not found in storage. It may not have been uploaded or has expired.',
      });
    }

    if (detectedPurpose) {
      const allowedTypes = ALLOWED_CONTENT_TYPES[detectedPurpose];
      if (storedContentType && !allowedTypes.includes(storedContentType)) {
        await this.redis.del(redisKey);
        throw new BadRequestException({
          code: ErrorCodes.MIME_TYPE_MISMATCH,
          message: `Stored content type ${storedContentType} is not allowed for this upload slot`,
        });
      }

      if (contentLength !== undefined && contentLength < MIN_FILE_SIZE) {
        await this.redis.del(redisKey);
        throw new BadRequestException({
          code: ErrorCodes.INVALID_FILE_TYPE,
          message: `File is too small (${contentLength} bytes). Minimum size is ${MIN_FILE_SIZE} bytes`,
        });
      }

      const maxSize = MAX_FILE_SIZE[detectedPurpose];
      if (contentLength !== undefined && contentLength > maxSize) {
        await this.redis.del(redisKey);
        throw new BadRequestException({
          code: ErrorCodes.FILE_TOO_LARGE,
          message: `File exceeds maximum allowed size of ${Math.round(maxSize / 1024 / 1024)} MB for this upload type`,
        });
      }

      try {
        // B-36 (audit-fix): widen the byte-range to cover the ISO BMFF brand
        // signatures at offset 4..11. 31-byte upper bound is plenty.
        const getCmd = new GetObjectCommand({ Bucket: bucket, Key: decodedKey, Range: `bytes=0-${MIME_HEADER_BYTES - 1}` });
        const getResp = await this.getS3Client().send(getCmd);
        const chunks: Uint8Array[] = [];
        const body = getResp.Body as AsyncIterable<Uint8Array>;
        for await (const chunk of body) { chunks.push(chunk); }
        const header = Buffer.concat(chunks);
        const detectedMime = detectMimeFromBytes(header);
        if (!detectedMime) {
          await this.redis.del(redisKey);
          throw new BadRequestException({
            code: ErrorCodes.MIME_TYPE_MISMATCH,
            message: 'Unable to identify file type from content. Upload rejected.',
          });
        }
        if (storedContentType && detectedMime !== storedContentType) {
          await this.redis.del(redisKey);
          throw new BadRequestException({
            code: ErrorCodes.MIME_TYPE_MISMATCH,
            message: `File content (${detectedMime}) does not match declared type (${storedContentType})`,
          });
        }
        if (!allowedTypes.includes(detectedMime)) {
          await this.redis.del(redisKey);
          throw new BadRequestException({
            code: ErrorCodes.MIME_TYPE_MISMATCH,
            message: `Actual file type ${detectedMime} is not allowed for this upload slot`,
          });
        }
      } catch (error) {
        if (error instanceof BadRequestException) throw error;
        this.logger.error(`Magic-byte check failed for key=${decodedKey}: ${(error as Error).message}`);
        await this.redis.del(redisKey);
        throw new BadRequestException({
          code: ErrorCodes.MIME_TYPE_MISMATCH,
          message: 'Unable to verify file content integrity. Please re-upload.',
        });
      }
    }

    const result: { fileKey: string; confirmed: boolean; sha256?: string; verified?: boolean } = {
      fileKey: decodedKey,
      confirmed: true,
    };

    if (sha256) {
      // B-40 (audit-fix): this block used to echo the CLIENT-supplied hash straight
      // back and set verified:true without ever hashing the stored object. The
      // client-side integrity check in
      // apps/mobile/lib/hooks/useOrderProofUpload.ts (`confirmResp.sha256 !==
      // localHash`) was therefore comparing a value to itself and could never
      // fail — a corrupted or swapped upload reported as "verified". Hash what we
      // actually stored. ContentLength is already bounded by MAX_FILE_SIZE for the
      // purpose above, so streaming the whole body is safe and never buffers it.
      let computed: string;
      try {
        const getCmd = new GetObjectCommand({ Bucket: bucket, Key: decodedKey });
        const getResp = await this.getS3Client().send(getCmd);
        const hash = createHash('sha256');
        for await (const chunk of getResp.Body as AsyncIterable<Uint8Array>) {
          hash.update(chunk);
        }
        computed = hash.digest('hex');
      } catch (error) {
        this.logger.error(`SHA-256 verification read failed for key=${decodedKey}: ${(error as Error).message}`);
        await this.redis.del(redisKey);
        throw new BadRequestException({
          code: ErrorCodes.UPLOAD_FAILED,
          message: 'Unable to verify uploaded file integrity. Please re-upload.',
        });
      }

      if (computed !== sha256.toLowerCase()) {
        this.logger.warn(`SHA-256 mismatch for key=${decodedKey} (expected client hash did not match stored object)`);
        await this.redis.del(redisKey);
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'Uploaded file checksum does not match the provided sha256 value. Please re-upload.',
        });
      }

      result.sha256 = computed;
      result.verified = true;
    }

    return result;
  }

  isConfirmedUploadKey(userId: string, fileKey: string): Promise<boolean> {
    if (!isSafeFileKey(fileKey)) return Promise.resolve(false);
    const segments = fileKey.split('/');
    if (segments.length !== 4 || segments[2] !== userId || !PURPOSE_BY_FOLDER[segments[1]]) {
      return Promise.resolve(false);
    }
    const redisKey = `confirmed_upload:${userId}:${fileKey}`;
    return this.redis.get(redisKey).then((val) => val !== null);
  }

  async verifyEvidenceFileKeys(userId: string, fileKeys: string[], evidenceType: 'dispute-evidence' | 'report-evidence' = 'dispute-evidence'): Promise<void> {
    const prefix = `uploads/${evidenceType}/${userId}/`;
    const bucket = this.getPrivateBucket();
    const purpose = evidenceType === 'dispute-evidence' ? UploadPurpose.DISPUTE_EVIDENCE : UploadPurpose.REPORT_EVIDENCE;
    const maxSize = MAX_FILE_SIZE[purpose];

    for (const key of fileKeys) {
      // B-39: shape/traversal check BEFORE the prefix check. `startsWith(prefix)`
      // alone accepts `uploads/dispute-evidence/<myId>/../../kyc-ktp/<victim>/x.jpg`.
      if (!isSafeFileKey(key) || !key.startsWith(prefix) || key.split('/').length !== 4) {
        throw new BadRequestException({
          code: ErrorCodes.FILE_ACCESS_DENIED,
          message: 'One or more files were not uploaded by you or are not valid evidence files',
        });
      }

      const isConfirmed = await this.isConfirmedUploadKey(userId, key);
      if (!isConfirmed) {
        throw new BadRequestException({
          code: ErrorCodes.UPLOAD_NOT_CONFIRMED,
          message: `File must be confirmed via /upload/confirm before use: ${key}`,
        });
      }

      let contentLength: number | undefined;
      try {
        const command = new HeadObjectCommand({ Bucket: bucket, Key: key });
        const head = await this.getS3Client().send(command) as HeadObjectCommandOutput;
        contentLength = head.ContentLength;
      } catch {
        throw new NotFoundException({
          code: ErrorCodes.FILE_NOT_FOUND_OR_EXPIRED,
          message: `Evidence file not found in storage: ${key}`,
        });
      }

      if (contentLength !== undefined && contentLength > maxSize) {
        throw new BadRequestException({
          code: ErrorCodes.FILE_TOO_LARGE,
          message: `Evidence file exceeds maximum allowed size of ${Math.round(maxSize / 1024 / 1024)} MB`,
        });
      }

      const consumeKey = `confirmed_upload:${userId}:${key}`;
      const consumed = await this.redis.consumeOnce(consumeKey, { throwOnError: true });
      if (!consumed) {
        throw new BadRequestException({
          code: ErrorCodes.UPLOAD_NOT_CONFIRMED,
          message: `File confirmation has already been consumed: ${key}`,
        });
      }
    }
  }

  async verifyEvidenceFileKeysBatch(
    userId: string,
    fileKeys: string[],
    fileTypes: string[],
    evidenceType: 'dispute-evidence' | 'report-evidence' = 'dispute-evidence',
  ): Promise<{ fileKey: string; fileType: string; status: 'ok' | 'error'; error?: string }[]> {
    const prefix = `uploads/${evidenceType}/${userId}/`;
    const bucket = this.getPrivateBucket();
    const purpose = evidenceType === 'dispute-evidence' ? UploadPurpose.DISPUTE_EVIDENCE : UploadPurpose.REPORT_EVIDENCE;
    const maxSize = MAX_FILE_SIZE[purpose];
    const allowedTypes = ALLOWED_CONTENT_TYPES[purpose];

    const results = await Promise.all(
      fileKeys.map(async (key, idx) => {
        const fileType = fileTypes[idx] || 'application/octet-stream';
        try {
          // B-39: see verifyEvidenceFileKeys — prefix match alone permits traversal.
          if (!isSafeFileKey(key) || !key.startsWith(prefix) || key.split('/').length !== 4) {
            return { fileKey: key, fileType, status: 'error' as const, error: 'File was not uploaded by you or is not a valid evidence file' };
          }

          if (!allowedTypes.includes(fileType)) {
            return { fileKey: key, fileType, status: 'error' as const, error: `File type not allowed: ${fileType}` };
          }

          const isConfirmed = await this.isConfirmedUploadKey(userId, key);
          if (!isConfirmed) {
            return { fileKey: key, fileType, status: 'error' as const, error: 'File must be confirmed via /upload/confirm before use' };
          }

          let contentLength: number | undefined;
          try {
            const command = new HeadObjectCommand({ Bucket: bucket, Key: key });
            const head = await this.getS3Client().send(command) as HeadObjectCommandOutput;
            contentLength = head.ContentLength;
            if (head.ContentType && head.ContentType !== fileType) {
              return { fileKey: key, fileType, status: 'error' as const, error: 'Declared file type does not match the stored object type' };
            }
          } catch {
            return { fileKey: key, fileType, status: 'error' as const, error: 'Evidence file not found in storage' };
          }

          if (contentLength !== undefined && contentLength > maxSize) {
            return { fileKey: key, fileType, status: 'error' as const, error: `File exceeds maximum allowed size of ${Math.round(maxSize / 1024 / 1024)} MB` };
          }

          const consumeKey = `confirmed_upload:${userId}:${key}`;
          const consumed = await this.redis.consumeOnce(consumeKey, { throwOnError: true });
          if (!consumed) {
            return { fileKey: key, fileType, status: 'error' as const, error: 'File confirmation has already been consumed' };
          }

          return { fileKey: key, fileType, status: 'ok' as const };
        } catch {
          return { fileKey: key, fileType, status: 'error' as const, error: 'Unexpected validation error' };
        }
      }),
    );

    return results;
  }

  async verifyUserFileKeys(userId: string, fileKeys: string[], purpose: UploadPurpose): Promise<void> {
    const folder = UploadService.PURPOSE_FOLDER_MAP[purpose];
    const prefix = `uploads/${folder}/${userId}/`;
    const allowedTypes = ALLOWED_CONTENT_TYPES[purpose];
    const maxSize = MAX_FILE_SIZE[purpose];
    if (!Array.isArray(fileKeys) || fileKeys.length > 5) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Too many attachment files' });
    }
    if (new Set(fileKeys).size !== fileKeys.length) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Duplicate attachment file keys are not allowed' });
    }

    for (const fileKey of fileKeys) {
      if (!isSafeFileKey(fileKey) || !fileKey.startsWith(prefix) || fileKey.split('/').length !== 4) {
        throw new BadRequestException({ code: ErrorCodes.FILE_ACCESS_DENIED, message: 'Attachment file key is not owned by this user or has the wrong purpose' });
      }
      if (!(await this.isConfirmedUploadKey(userId, fileKey))) {
        throw new BadRequestException({ code: ErrorCodes.UPLOAD_NOT_CONFIRMED, message: 'Attachment must be confirmed before it can be attached' });
      }

      let head: HeadObjectCommandOutput;
      try {
        head = await this.getS3Client().send(new HeadObjectCommand({ Bucket: this.getPrivateBucket(), Key: fileKey })) as HeadObjectCommandOutput;
      } catch {
        throw new NotFoundException({ code: ErrorCodes.FILE_NOT_FOUND_OR_EXPIRED, message: 'Attachment file was not found in storage' });
      }
      if (head.ContentLength === undefined || head.ContentLength < MIN_FILE_SIZE || head.ContentLength > maxSize) {
        throw new BadRequestException({ code: ErrorCodes.FILE_TOO_LARGE, message: 'Attachment file size is outside the allowed range' });
      }
      if (!head.ContentType || !allowedTypes.includes(head.ContentType)) {
        throw new BadRequestException({ code: ErrorCodes.MIME_TYPE_MISMATCH, message: 'Attachment content type is not allowed' });
      }
    }

    for (const fileKey of fileKeys) {
      const consumed = await this.redis.consumeOnce(`confirmed_upload:${userId}:${fileKey}`, { throwOnError: true });
      if (!consumed) {
        throw new ConflictException({ code: ErrorCodes.UPLOAD_NOT_CONFIRMED, message: 'Attachment confirmation has already been consumed' });
      }
    }
  }

  async getFileSize(fileKey: string): Promise<number> {
    if (!isSafeFileKey(fileKey) || !this.isKnownStorageKey(fileKey)) throw new BadRequestException({ code: ErrorCodes.INVALID_FILE_TYPE, message: 'Invalid file key format' });
    const bucket = this.getBucketForKey(fileKey);
    const command = new HeadObjectCommand({ Bucket: bucket, Key: fileKey });
    const head = await this.getS3Client().send(command) as HeadObjectCommandOutput;
    return head.ContentLength ?? 0;
  }

  async generateDownloadUrl(fileKey: string, expiresIn = 300): Promise<string> {
    if (!isSafeFileKey(fileKey) || !this.isKnownStorageKey(fileKey)) throw new BadRequestException({ code: ErrorCodes.INVALID_FILE_TYPE, message: 'Invalid file key format' });
    const bucket = this.getBucketForKey(fileKey);
    const safeExpiresIn = Math.min(Math.max(Math.floor(expiresIn), 60), 3600);
    const rawFileName = fileKey.split('/').pop() || 'download';
    const sanitizedFileName = sanitizeStoredFileName(rawFileName);
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: fileKey,
      ResponseContentDisposition: `attachment; filename="${sanitizedFileName}"`,
    });
    return getSignedUrl(this.getS3Client(), command, { expiresIn: safeExpiresIn });
  }

  /**
   * Stores a generated account export in the private bucket. This method is
   * intentionally not exposed by UploadController: users can request an
   * export through SettingsService, but cannot choose an arbitrary private key.
   */
  async uploadPrivateAccountExport(userId: string, content: Buffer): Promise<{ downloadUrl: string; expiresAt: Date }> {
    const fileKey = `uploads/account-exports/${userId}/${nanoid()}.json`;
    if (!isSafeFileKey(fileKey)) {
      throw new Error('Generated account export key failed storage safety validation');
    }
    const bucket = this.getPrivateBucket();
    await this.getS3Client().send(new PutObjectCommand({
      Bucket: bucket,
      Key: fileKey,
      Body: content,
      ContentType: 'application/json; charset=utf-8',
      ContentDisposition: 'attachment; filename="kahade-account-export.json"',
      Metadata: { owner: userId, purpose: 'account-export' },
    }));

    const configuredExpiry = this.configService.get<number>('r2.presignExpires') ?? 900;
    const expiresIn = Math.min(Math.max(Math.floor(configuredExpiry), 60), 3600);
    return {
      downloadUrl: await this.generateDownloadUrl(fileKey, expiresIn),
      expiresAt: new Date(Date.now() + expiresIn * 1000),
    };
  }

  async uploadDirect(
    userId: string,
    purpose: UploadPurpose,
    fileName: string,
    contentType: string,
    fileBuffer: Buffer,
  ): Promise<{ fileKey: string; fileUrl: string }> {
    const allowedTypes = ALLOWED_CONTENT_TYPES[purpose];
    if (!allowedTypes.includes(contentType)) {
      throw new BadRequestException({
        code: ErrorCodes.MIME_TYPE_MISMATCH,
        message: `Content type ${contentType} is not allowed for ${purpose}. Allowed: ${allowedTypes.join(', ')}`,
      });
    }

    if (fileBuffer.length < MIN_FILE_SIZE) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_FILE_TYPE,
        message: `File is too small (${fileBuffer.length} bytes). Minimum size is ${MIN_FILE_SIZE} bytes`,
      });
    }

    const maxSize = MAX_FILE_SIZE[purpose];
    if (fileBuffer.length > maxSize) {
      throw new BadRequestException({
        code: ErrorCodes.FILE_TOO_LARGE,
        message: `File exceeds maximum allowed size of ${Math.round(maxSize / 1024 / 1024)} MB`,
      });
    }

    const header = fileBuffer.subarray(0, MIME_HEADER_BYTES);
    const detectedMime = detectMimeFromBytes(header);
    if (!detectedMime) {
      throw new BadRequestException({
        code: ErrorCodes.MIME_TYPE_MISMATCH,
        message: 'Unable to identify file type from content. The file may be corrupted or unsupported.',
      });
    }
    if (detectedMime !== contentType) {
      throw new BadRequestException({
        code: ErrorCodes.MIME_TYPE_MISMATCH,
        message: `File content (${detectedMime}) does not match declared type (${contentType})`,
      });
    }

    const sanitizedFileName = sanitizeStoredFileName(fileName);
    const timestamp = Date.now();
    const randomSuffix = nanoid();
    const folder = UploadService.PURPOSE_FOLDER_MAP[purpose];
    const fileKey = `uploads/${folder}/${userId}/${timestamp}-${randomSuffix}-${sanitizedFileName}`;
    const bucket = this.getBucket(purpose);

    try {
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: fileKey,
        ContentType: contentType,
        Body: fileBuffer,
      });
      await this.getS3Client().send(command);
    } catch (error) {
      this.logger.error(`Direct upload to R2 failed for key=${fileKey}`, error instanceof Error ? error.stack : error);
      throw new BadRequestException({
        code: ErrorCodes.UPLOAD_FAILED,
        message: 'Failed to upload file to storage. Please try again.',
      });
    }

    const redisKey = `confirmed_upload:${userId}:${fileKey}`;
    await this.redis.setNx(redisKey, '1', CONFIRMED_KEY_TTL_SECONDS);

    let fileUrl: string;
    if (isPrivatePath(fileKey)) {
      fileUrl = fileKey;
    } else {
      const publicUrl = this.configService.get<string>('r2.publicUrl');
      fileUrl = publicUrl ? `${publicUrl.replace(/\/+$/, '')}/${fileKey}` : fileKey;
    }

    return { fileKey, fileUrl };
  }

  async cleanupFileKeys(userId: string, fileKeys: string[]): Promise<{ deleted: number; errors: { fileKey: string; reason: string }[] }> {
    let deleted = 0;
    const errors: { fileKey: string; reason: string }[] = [];

    for (const fileKey of fileKeys) {
      // B-39: this was the weakest of the three key-consuming paths — it took
      // fileKeys straight from the request body (`CleanupFilesDto` only declares
      // `@IsString({ each: true })`) and asserted nothing but `segments[2] === userId`.
      // `uploads/x/<myId>/../../avatars/<victim>/a.jpg` satisfied that and reached
      // DeleteObjectCommand, so a caller could delete objects they do not own.
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
        const command = new DeleteObjectCommand({ Bucket: bucket, Key: fileKey });
        await this.getS3Client().send(command);
        const redisKey = `confirmed_upload:${userId}:${fileKey}`;
        await this.redis.del(redisKey);
        deleted++;
      } catch (error) {
        this.logger.warn(`Failed to delete file key=${fileKey}`, error instanceof Error ? error.message : error);
        errors.push({ fileKey, reason: 'storage deletion failed' });
      }
    }

    return { deleted, errors };
  }

  private isKnownStorageKey(fileKey: string): boolean {
    const parts = fileKey.split('/');
    return parts.length === 4 && (Boolean(PURPOSE_BY_FOLDER[parts[1]]) || parts[1] === 'account-exports');
  }

  private static readonly PURPOSE_FOLDER_MAP: Record<UploadPurpose, string> = PURPOSE_FOLDER_MAP_INTERNAL;

  private getBucket(purpose: UploadPurpose): string {
    const folder = UploadService.PURPOSE_FOLDER_MAP[purpose];
    const syntheticKey = `uploads/${folder}/`;
    return this.getBucketForKey(syntheticKey);
  }
}
