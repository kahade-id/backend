import { Injectable, BadRequestException, NotFoundException, Logger, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { Readable } from 'stream';

import { customAlphabet } from 'nanoid';
import { UploadPurpose } from './dto/presigned-url.dto';
import { RedisService } from '../../redis/redis.service';
import { LocalStorageService } from './local-storage.service';
import { encryptAES, decryptAES } from '../../common/utils/crypto.util';
import * as ErrorCodes from '../../common/constants/error-codes';

const nanoid = customAlphabet('1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', 10);

// NOTE (batch 1A, ST-016): image/heic & image/heif DITERIMA untuk KYC, dokumen
// bisnis, bukti, dan lampiran chat — format default kamera iPhone tidak boleh
// ditolak. Magic-byte detection sudah mencakup brand ftyp HEIC/HEIF.
// AVATAR & SHOWCASE_IMAGE tetap tanpa HEIC: keduanya dirender langsung oleh
// browser/<Image> dan browser tidak merender HEIC — klaim itu tetap valid
// untuk konten yang tampil publik.
const ALLOWED_CONTENT_TYPES: Record<UploadPurpose, string[]> = {
  [UploadPurpose.KYC_KTP]: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'],
  [UploadPurpose.KYC_SELFIE]: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'],
  [UploadPurpose.KYC_PASSPORT]: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'],
  [UploadPurpose.KYC_LIVENESS]: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'],
  // Dokumen badan usaha boleh PDF (NPWP/akta/SIUP umumnya dipindai sebagai PDF).
  [UploadPurpose.BUSINESS_DOCUMENT]: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'],
  // Section 3: gambar showcase tampil publik di feed, jadi hanya image raster.
  // PDF/SVG ditolak — tidak bisa dirender sebagai thumbnail kartu feed.
  [UploadPurpose.SHOWCASE_IMAGE]: ['image/jpeg', 'image/png', 'image/webp'],
  [UploadPurpose.AVATAR]: ['image/jpeg', 'image/png', 'image/webp'],
  [UploadPurpose.CHAT_ATTACHMENT]: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf', 'video/mp4', 'video/quicktime', 'video/webm', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4'],
  [UploadPurpose.DISPUTE_EVIDENCE]: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf', 'video/mp4', 'video/quicktime', 'video/webm'],
  [UploadPurpose.REPORT_EVIDENCE]: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'],
  [UploadPurpose.DELIVERY_PROOF]: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'],
};

const MIN_FILE_SIZE = 1024;

const MAX_FILE_SIZE: Record<UploadPurpose, number> = {
  [UploadPurpose.KYC_KTP]: 5 * 1024 * 1024,
  [UploadPurpose.KYC_SELFIE]: 5 * 1024 * 1024,
  [UploadPurpose.KYC_PASSPORT]: 5 * 1024 * 1024,
  [UploadPurpose.KYC_LIVENESS]: 5 * 1024 * 1024,
  [UploadPurpose.BUSINESS_DOCUMENT]: 10 * 1024 * 1024,
  [UploadPurpose.SHOWCASE_IMAGE]: 5 * 1024 * 1024,
  [UploadPurpose.AVATAR]: 2 * 1024 * 1024,
  [UploadPurpose.CHAT_ATTACHMENT]: 50 * 1024 * 1024,
  [UploadPurpose.DISPUTE_EVIDENCE]: 50 * 1024 * 1024,
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
  [UploadPurpose.KYC_PASSPORT]: 'private',
  [UploadPurpose.KYC_LIVENESS]: 'private',
  [UploadPurpose.BUSINESS_DOCUMENT]: 'private',
  [UploadPurpose.SHOWCASE_IMAGE]: 'public',
  [UploadPurpose.AVATAR]: 'public',
  [UploadPurpose.CHAT_ATTACHMENT]: 'private',
  [UploadPurpose.DISPUTE_EVIDENCE]: 'private',
  [UploadPurpose.REPORT_EVIDENCE]: 'private',
  [UploadPurpose.DELIVERY_PROOF]: 'private',
};

const PURPOSE_FOLDER_MAP_INTERNAL: Record<UploadPurpose, string> = {
  [UploadPurpose.KYC_KTP]: 'kyc-ktp',
  [UploadPurpose.KYC_SELFIE]: 'kyc-selfie',
  [UploadPurpose.KYC_PASSPORT]: 'kyc-passport',
  [UploadPurpose.KYC_LIVENESS]: 'kyc-liveness',
  [UploadPurpose.BUSINESS_DOCUMENT]: 'business-documents',
  [UploadPurpose.SHOWCASE_IMAGE]: 'showcase-images',
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

// Batch 1A (ST-005): visibility classification yang di-ENFORCE. Sebelumnya
// `isPrivatePath()` adalah dead code (nol call site) — sekarang dipakai oleh
// generateDownloadUrl(), uploadDirect(), dan endpoint download terautentikasi.
export function isPrivateFileKey(fileKey: string): boolean {
  return PRIVATE_FOLDER_PREFIXES.some(prefix => fileKey.startsWith(prefix))
    || fileKey.startsWith('uploads/account-exports/');
}

/** Prefix folder publik yang diserve langsung oleh nginx tanpa auth. */
export const PUBLIC_FOLDER_PREFIXES = ['uploads/avatars/', 'uploads/headers/', 'uploads/showcase-images/'];

export function isPublicFileKey(fileKey: string): boolean {
  return PUBLIC_FOLDER_PREFIXES.some(prefix => fileKey.startsWith(prefix));
}

@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);

  constructor(
    private configService: ConfigService,
    private redis: RedisService,
    private localStorage: LocalStorageService,
  ) {}

  // ── Batch 1A (ST-002/03-#1): signed URL HMAC untuk file privat ──
  // Menggantikan semantik presigned-URL R2: URL kedaluwarsa yang hanya bisa
  // dibuat server-side setelah otorisasi. Secret dari STORAGE_URL_SECRET
  // (opsional), fallback ke JWT_SECRET (wajib, ≥32 char).
  private getUrlSigningSecret(): string {
    const dedicated = this.configService.get<string>('STORAGE_URL_SECRET');
    if (dedicated && dedicated.trim().length >= 16) return dedicated.trim();
    const jwtSecret = this.configService.get<string>('jwt.secret') || this.configService.get<string>('JWT_SECRET');
    if (!jwtSecret) {
      throw new Error('URL signing secret unavailable: set STORAGE_URL_SECRET or JWT_SECRET');
    }
    return jwtSecret;
  }

  private buildSignedDownloadUrl(fileKey: string, expiresIn: number): string {
    const exp = Math.floor(Date.now() / 1000) + Math.max(60, expiresIn);
    const sig = createHmac('sha256', this.getUrlSigningSecret())
      .update(`${fileKey}:${exp}`)
      .digest('hex');
    const publicBase = (this.configService.get<string>('app.storagePublicUrl') || 'https://api.kahade.id/uploads').replace(/\/+$/, '');
    // Basis API = publicBase tanpa segmen /uploads terakhir.
    const apiBase = publicBase.replace(/\/uploads\/?$/, '') || publicBase;
    return `${apiBase}/v1/upload/s?key=${encodeURIComponent(fileKey)}&exp=${exp}&sig=${sig}`;
  }

  /** Verifikasi query signed download. Kembalikan fileKey bila valid. */
  verifySignedDownload(key: string, exp: string, sig: string): string | null {
    if (!isSafeFileKey(key) || !isPrivateFileKey(key)) return null;
    const expNum = Number(exp);
    if (!Number.isInteger(expNum) || expNum <= Math.floor(Date.now() / 1000)) return null;
    if (!/^[0-9a-f]{64}$/.test(sig)) return null;
    let expected: Buffer;
    try {
      expected = Buffer.from(
        createHmac('sha256', this.getUrlSigningSecret()).update(`${key}:${expNum}`).digest('hex'),
        'hex',
      );
    } catch {
      return null;
    }
    const actual = Buffer.from(sig, 'hex');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    return key;
  }

  /** Stream byte file privat untuk endpoint download terautentikasi. */
  async getPrivateFileStream(fileKey: string): Promise<{ stream: Readable; contentType: string; size: number }> {
    if (!isSafeFileKey(fileKey) || !isPrivateFileKey(fileKey)) {
      throw new BadRequestException({ code: ErrorCodes.INVALID_FILE_TYPE, message: 'Invalid private file key' });
    }
    const size = await this.localStorage.getFileSize(fileKey);
    if (size === null) {
      throw new NotFoundException({ code: ErrorCodes.FILE_NOT_FOUND_OR_EXPIRED, message: 'File not found' });
    }
    let stream: Readable = this.localStorage.createReadStream(fileKey) as Readable;
    // ST-019: export akun disimpan terenkripsi at-rest — dekripsi saat serve.
    // Fallback: file lama (sebelum enkripsi) yang sudah berupa JSON diserve
    // apa adanya agar masa transisi tidak merusak unduhan yang sedang berjalan.
    if (fileKey.startsWith('uploads/account-exports/')) {
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString('utf-8');
      let buf: Buffer;
      try {
        const decryptedB64 = await decryptAES(raw);
        buf = Buffer.from(decryptedB64, 'base64');
      } catch {
        if (raw.trimStart().startsWith('{')) {
          buf = Buffer.from(raw, 'utf-8');
        } else {
          throw new BadRequestException({ code: ErrorCodes.FILE_NOT_FOUND_OR_EXPIRED, message: 'Export file is unavailable or corrupted' });
        }
      }
      stream = Readable.from([buf]);
      return { stream, contentType: 'application/json', size: buf.length };
    }
    return { stream, contentType: this.localStorage.getContentType(fileKey), size };
  }

  // ── Self-hosted storage (2026-09-26): R2 diganti local disk. ──
  // getS3Client(), getBucket(), getBucketForKey() dihapus.

  async generatePresignedUrl(userId: string, purpose: UploadPurpose, fileName: string, contentType: string, fileSize: number): Promise<{ uploadUrl: string; fileKey: string; expiresIn: number; minFileSize: number; maxFileSize: number }> {
    // DEPRECATED 2026-09-26: R2 dihapus, storage self-hosted di disk server.
    // Tidak ada presigned URL lagi — gunakan POST /v1/upload/direct (multipart).
    throw new BadRequestException({
      code: 'DEPRECATED',
      message: 'Presigned URL upload is no longer supported. Use POST /v1/upload/direct instead.',
    });
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

    const exists = await this.localStorage.fileExists(decodedKey);

    let contentLength: number | undefined;
    let storedContentType: string | undefined;
    if (!exists) {
      await this.redis.del(redisKey);
      this.logger.error(`Local storage file not found for key=${decodedKey}`);
      throw new NotFoundException({
        code: ErrorCodes.FILE_NOT_FOUND_OR_EXPIRED,
        message: 'File not found in storage. It may not have been uploaded or has expired.',
      });
    }
    contentLength = await this.localStorage.getFileSize(decodedKey) ?? undefined;
    // storedContentType tidak tersedia di local storage — deteksi dari bytes di bawah (lebih kuat).

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
        const header = await this.localStorage.readFileRange(decodedKey, 0, MIME_HEADER_BYTES - 1);
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
        const hash = createHash('sha256');
        const stream = this.localStorage.createReadStream(decodedKey);
        for await (const chunk of stream) {
          hash.update(chunk as Buffer);
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

      const contentLength = await this.localStorage.getFileSize(key);
      if (contentLength === null) {
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

          const contentLength = await this.localStorage.getFileSize(key);
          if (contentLength === null) {
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

  /**
   * Validasi file key hasil upload presigned milik user: bentuk key, kepemilikan,
   * konfirmasi /upload/confirm, ukuran tersimpan, dan content type tersimpan.
   *
   * `opts.maxFiles`  — batas jumlah file (default 5, perilaku lama).
   * `opts.consume`   — konsumsi konfirmasi upload (default true). Set false bila
   *                    pemanggil masih bisa gagal SETELAH validasi ini dan file
   *                    harus tetap bisa dipakai ulang (pola business-verification).
   * `opts.label`     — kata benda untuk pesan error (default "Attachment").
   *
   * Bucket diturunkan dari `purpose` (PURPOSE_VISIBILITY), bukan hardcoded private,
   * supaya purpose public seperti SHOWCASE_IMAGE/AVATAR bisa lewat jalur yang sama.
   */
  async verifyUserFileKeys(
    userId: string,
    fileKeys: string[],
    purpose: UploadPurpose,
    opts?: { maxFiles?: number; consume?: boolean; label?: string },
  ): Promise<void> {
    const folder = UploadService.PURPOSE_FOLDER_MAP[purpose];
    const prefix = `uploads/${folder}/${userId}/`;
    const allowedTypes = ALLOWED_CONTENT_TYPES[purpose];
    const maxSize = MAX_FILE_SIZE[purpose];
    const maxFiles = opts?.maxFiles ?? 5;
    const shouldConsume = opts?.consume ?? true;
    const label = opts?.label ?? 'Attachment';
    if (!Array.isArray(fileKeys) || fileKeys.length > maxFiles) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: `Too many ${label.toLowerCase()} files (max ${maxFiles})` });
    }
    if (new Set(fileKeys).size !== fileKeys.length) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: `Duplicate ${label.toLowerCase()} file keys are not allowed` });
    }

    for (const fileKey of fileKeys) {
      if (!isSafeFileKey(fileKey) || !fileKey.startsWith(prefix) || fileKey.split('/').length !== 4) {
        throw new BadRequestException({ code: ErrorCodes.FILE_ACCESS_DENIED, message: `${label} file key is not owned by this user or has the wrong purpose` });
      }
      if (!(await this.isConfirmedUploadKey(userId, fileKey))) {
        throw new BadRequestException({ code: ErrorCodes.UPLOAD_NOT_CONFIRMED, message: `${label} must be confirmed before it can be attached` });
      }

      const contentLength = await this.localStorage.getFileSize(fileKey);
      if (contentLength === null || contentLength < MIN_FILE_SIZE || contentLength > maxSize) {
        throw new BadRequestException({ code: ErrorCodes.FILE_TOO_LARGE, message: `${label} file size is outside the allowed range` });
      }
      // Content type dideteksi dari bytes saat confirm — local storage tidak
      // menyimpan ContentType terpisah, jadi skip check ContentType di sini.
    }

    if (!shouldConsume) return;
    for (const fileKey of fileKeys) {
      const consumed = await this.redis.consumeOnce(`confirmed_upload:${userId}:${fileKey}`, { throwOnError: true });
      if (!consumed) {
        throw new ConflictException({ code: ErrorCodes.UPLOAD_NOT_CONFIRMED, message: `${label} confirmation has already been consumed` });
      }
    }
  }

  /**
   * URL publik untuk file di storage lokal (AVATAR / SHOWCASE_IMAGE / dll).
   * Diserve nginx dari STORAGE_PATH via https://api.kahade.id/uploads/.
   */
  buildPublicUrl(fileKey: string): string {
    return this.localStorage.getPublicUrl(fileKey);
  }

  async getFileSize(fileKey: string): Promise<number> {
    if (!isSafeFileKey(fileKey) || !this.isKnownStorageKey(fileKey)) throw new BadRequestException({ code: ErrorCodes.INVALID_FILE_TYPE, message: 'Invalid file key format' });
    return (await this.localStorage.getFileSize(fileKey)) ?? 0;
  }

  /**
   * URL unduh untuk fileKey.
   *
   * Batch 1A (03-#1, ST-002): file PUBLIK → URL publik langsung (disserve nginx).
   * File PRIVAT → signed URL HMAC ke `GET /v1/upload/s` dengan expiry sesuai
   * `expiresIn`. Sebelumnya selalu mengembalikan URL publik permanen dan
   * mengabaikan `expiresIn`.
   */
  async generateDownloadUrl(fileKey: string, expiresIn = 300): Promise<string> {
    if (!isSafeFileKey(fileKey) || !this.isKnownStorageKey(fileKey)) throw new BadRequestException({ code: ErrorCodes.INVALID_FILE_TYPE, message: 'Invalid file key format' });
    if (isPrivateFileKey(fileKey)) {
      return this.buildSignedDownloadUrl(fileKey, expiresIn);
    }
    return this.localStorage.getPublicUrl(fileKey);
  }

  /**
   * Stores a generated account export in local storage. This method is
   * intentionally not exposed by UploadController: users can request an
   * export through SettingsService, but cannot choose an arbitrary private key.
   *
   * Batch 1A (ST-019): konten dienkripsi AES-GCM at-rest. URL unduh adalah
   * signed URL kedaluwarsa (bukan URL publik permanen), dan file dihapus
   * otomatis oleh scheduler setelah 24 jam.
   */
  async uploadPrivateAccountExport(userId: string, content: Buffer): Promise<{ downloadUrl: string; expiresAt: Date }> {
    const fileKey = `uploads/account-exports/${userId}/${nanoid()}.json`;
    if (!isSafeFileKey(fileKey)) {
      throw new Error('Generated account export key failed storage safety validation');
    }
    const encrypted = await encryptAES(content.toString('base64'));
    await this.localStorage.saveFile(fileKey, Buffer.from(encrypted, 'utf-8'));

    const expiresIn = 900;
    return {
      downloadUrl: this.buildSignedDownloadUrl(fileKey, expiresIn),
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

    try {
      await this.localStorage.saveFile(fileKey, fileBuffer);
    } catch (error) {
      this.logger.error(`Direct upload to local storage failed for key=${fileKey}`, error instanceof Error ? error.stack : error);
      throw new BadRequestException({
        code: ErrorCodes.UPLOAD_FAILED,
        message: 'Failed to upload file to storage. Please try again.',
      });
    }

    const redisKey = `confirmed_upload:${userId}:${fileKey}`;
    await this.redis.setNx(redisKey, '1', CONFIRMED_KEY_TTL_SECONDS);

    // Batch 1A (ST-004): purpose PRIVAT (KYC/dokumen/bukti) mendapat signed URL
    // kedaluwarsa, bukan URL publik permanen. Purpose publik (avatar/showcase)
    // tetap mendapat URL publik via nginx.
    const fileUrl = isPrivateFileKey(fileKey)
      ? this.buildSignedDownloadUrl(fileKey, 900)
      : this.localStorage.getPublicUrl(fileKey);

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

      try {
        await this.localStorage.deleteFile(fileKey);
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
}
