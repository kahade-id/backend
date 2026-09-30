import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { UploadPurpose } from './dto/presigned-url.dto';
import { InitChunkedUploadDto } from './dto/chunked-upload.dto';
import * as ErrorCodes from '../../common/constants/error-codes';
import { ALLOWED_CONTENT_TYPES, DirectUploadResult, MAX_FILE_SIZE, UploadService, fileTooLargeException } from './upload.service';

/**
 * NP-006 (perf-fix, 2026-09-29): upload chunked/resumable SEJATI untuk file
 * besar (video showcase s/d 100 MiB).
 *
 * Protokol (additive-only — endpoint baru, jalur `POST /v1/upload/direct`
 * tidak berubah):
 *   1. `POST /v1/upload/chunked/init`      → { sessionId, chunkSize, totalChunks, expiresAt }
 *   2. `POST /v1/upload/chunked/:id/chunk` → multipart `chunk` + field `chunkIndex`
 *   3. `GET  /v1/upload/chunked/:id/status`→ { received[], totalChunks, ... } (untuk resume)
 *   4. `POST /v1/upload/chunked/:id/complete` → rakit + jalankan pipeline
 *      `UploadService.uploadDirect` yang SAMA (validasi MIME magic-byte,
 *      batas purpose, ffmpeg thumbnail, dsb.) → DirectUploadResult.
 *
 * Gagal di tengah → client tanya `status`, kirim HANYA chunk yang hilang,
 * lalu `complete`. Chunk yang sudah diterima bersifat idempoten (kirim ulang
 * chunk yang sama → 200, bukan error).
 *
 * Penyimpanan sesi: `<storagePath>/.chunks/<sessionId>/` (manifest.json +
 * berkas `chunk-<index>`). Direktori ini TIDAK diserve nginx (location
 * `^~ /uploads/` mengembalikan 404 untuk prefix tak dikenal) dan TIDAK
 * terekspos lewat endpoint file mana pun — hanya diakses layanan ini.
 *
 * Keamanan:
 * - sessionId 64 hex acak (unguessable) + terikat userId di manifest —
 *   request sesi orang lain → 403.
 * - Format sessionId divalidasi ketat (anti path traversal); chunkIndex
 *   integer dalam rentang; ukuran tiap chunk diverifikasi terhadap yang
 *   disepakati (chunk terakhir boleh parsial).
 * - TTL sesi 24 jam; sesi kedaluwarsa → 410 + direktori dihapus.
 * - Sweep sesi kedaluwarsa oportunistik tiap `init` (murah: satu readdir).
 */
export interface ChunkSessionManifest {
  v: 1;
  sessionId: string;
  userId: string;
  purpose: UploadPurpose;
  fileName: string;
  mimeType: string;
  totalSize: number;
  chunkSize: number;
  totalChunks: number;
  createdAt: string;
  expiresAt: string;
}

export interface ChunkedInitResult {
  sessionId: string;
  chunkSize: number;
  totalChunks: number;
  totalSize: number;
  expiresAt: string;
}

export interface ChunkStatusResult {
  sessionId: string;
  chunkSize: number;
  totalChunks: number;
  totalSize: number;
  received: number[];
  receivedBytes: number;
  expiresAt: string;
}

const SESSION_ID_RE = /^[0-9a-f]{64}$/;
const CHUNK_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MIN_CHUNK_BYTES = 512 * 1024;
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;

@Injectable()
export class ChunkedUploadService {
  private readonly logger = new Logger(ChunkedUploadService.name);
  private readonly storageRoot: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly uploadService: UploadService,
  ) {
    this.storageRoot =
      this.configService.get<string>('app.storagePath') || '/var/www/kahade-storage';
  }

  private stagingRoot(): string {
    return path.join(this.storageRoot, '.chunks');
  }

  private sessionDir(sessionId: string): string {
    if (!SESSION_ID_RE.test(sessionId)) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Invalid session id format' });
    }
    const dir = path.resolve(this.stagingRoot(), sessionId);
    // Defense-in-depth: pastikan tetap di dalam staging root.
    if (dir !== path.join(path.resolve(this.stagingRoot()), sessionId)) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Invalid session id' });
    }
    return dir;
  }

  private manifestPath(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), 'manifest.json');
  }

  private chunkPath(sessionId: string, index: number): string {
    return path.join(this.sessionDir(sessionId), `chunk-${index}`);
  }

  private async loadManifest(userId: string, sessionId: string): Promise<ChunkSessionManifest> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(this.manifestPath(sessionId), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
        throw new NotFoundException({ code: 'CHUNK_SESSION_NOT_FOUND', message: 'Upload session not found' });
      }
      throw e;
    }
    let manifest: ChunkSessionManifest;
    try {
      manifest = JSON.parse(raw) as ChunkSessionManifest;
    } catch {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Corrupt upload session' });
    }
    if (!manifest || manifest.v !== 1 || manifest.sessionId !== sessionId) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Corrupt upload session' });
    }
    if (manifest.userId !== userId) {
      throw new ForbiddenException({ code: 'FILE_ACCESS_DENIED', message: 'Upload session not found' });
    }
    if (Date.now() > new Date(manifest.expiresAt).getTime()) {
      await this.destroySession(sessionId).catch(() => undefined);
      throw new GoneException({ code: 'CHUNK_SESSION_EXPIRED', message: 'Upload session expired — start a new one' });
    }
    return manifest;
  }

  private async destroySession(sessionId: string): Promise<void> {
    await fs.promises.rm(this.sessionDir(sessionId), { recursive: true, force: true });
  }

  /** Daftar index chunk yang sudah diterima (scan file — tanpa state yang bisa race). */
  private async receivedChunks(manifest: ChunkSessionManifest): Promise<number[]> {
    const out: number[] = [];
    await Promise.all(
      Array.from({ length: manifest.totalChunks }, async (_, i) => {
        try {
          const stat = await fs.promises.stat(this.chunkPath(manifest.sessionId, i));
          if (stat.isFile()) out.push(i);
        } catch {
          /* belum ada */
        }
      }),
    );
    return out.sort((a, b) => a - b);
  }

  /** Sapu sesi kedaluwarsa — oportunistik & murah (satu readdir). */
  private async sweepExpired(): Promise<void> {
    try {
      const entries = await fs.promises.readdir(this.stagingRoot(), { withFileTypes: true });
      const now = Date.now();
      await Promise.all(
        entries
          .filter((e) => e.isDirectory() && SESSION_ID_RE.test(e.name))
          .map(async (e) => {
            try {
              const raw = await fs.promises.readFile(path.join(this.stagingRoot(), e.name, 'manifest.json'), 'utf8');
              const manifest = JSON.parse(raw) as Partial<ChunkSessionManifest>;
              if (manifest.expiresAt && now > new Date(manifest.expiresAt).getTime()) {
                await this.destroySession(e.name);
              }
            } catch {
              /* manifest rusak → biarkan; bukan sesi valid */
            }
          }),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        this.logger.warn(`Chunk sweep gagal: ${(e as Error).message}`);
      }
    }
  }

  /** Ukuran chunk yang disepakati untuk index tertentu (terakhir boleh parsial). */
  private expectedChunkSize(manifest: ChunkSessionManifest, index: number): number {
    if (index === manifest.totalChunks - 1) {
      return manifest.totalSize - manifest.chunkSize * (manifest.totalChunks - 1);
    }
    return manifest.chunkSize;
  }

  async initiate(userId: string, dto: InitChunkedUploadDto): Promise<ChunkedInitResult> {
    const maxBytes = MAX_FILE_SIZE[dto.purpose];
    if (!maxBytes) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Unsupported upload purpose' });
    }
    if (dto.totalSize > maxBytes) {
      // BFI-099 + UMD-002: kode SELARAS dengan jalur direct/complete (VIDEO_TOO_LARGE +
      // pesan Indonesia untuk SHOWCASE_VIDEO; FILE_TOO_LARGE untuk lainnya) —
      // video yang sama tidak lagi ditolak dengan kode berbeda per jalur, kontrak
      // error FE stabil antar endpoint.
      // BFI-060: 413 PayloadTooLargeException (bukan 400).
      throw fileTooLargeException(dto.purpose, maxBytes);
    }
    const allowed = ALLOWED_CONTENT_TYPES[dto.purpose] ?? [];
    if (!allowed.includes(dto.mimeType)) {
      throw new BadRequestException({
        code: ErrorCodes.MIME_TYPE_MISMATCH,
        message: `Content type ${dto.mimeType} not allowed for ${dto.purpose}`,
      });
    }
    const chunkSize = Math.min(
      MAX_CHUNK_BYTES,
      Math.max(MIN_CHUNK_BYTES, dto.chunkSize ?? DEFAULT_CHUNK_BYTES),
    );
    const totalChunks = Math.ceil(dto.totalSize / chunkSize);
    if (totalChunks > 512) {
      // Batas kewarasan: 512 chunk × 8MiB = 4GiB (jauh di atas batas purpose).
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'File too large for chunked upload' });
    }

    const sessionId = randomBytes(32).toString('hex');
    const now = new Date();
    const manifest: ChunkSessionManifest = {
      v: 1,
      sessionId,
      userId,
      purpose: dto.purpose,
      fileName: dto.fileName,
      mimeType: dto.mimeType,
      totalSize: dto.totalSize,
      chunkSize,
      totalChunks,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + CHUNK_SESSION_TTL_MS).toISOString(),
    };
    const dir = this.sessionDir(sessionId);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(this.manifestPath(sessionId), JSON.stringify(manifest), 'utf8');

    // Oportunistik: bersihkan sesi basi selagi di sini (tidak menghambat respons).
    void this.sweepExpired();

    return {
      sessionId,
      chunkSize,
      totalChunks,
      totalSize: dto.totalSize,
      expiresAt: manifest.expiresAt,
    };
  }

  async uploadChunk(
    userId: string,
    sessionId: string,
    chunkIndex: number,
    chunk: { buffer: Buffer; size: number },
  ): Promise<ChunkStatusResult> {
    const manifest = await this.loadManifest(userId, sessionId);
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= manifest.totalChunks) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'chunkIndex out of range' });
    }
    const expected = this.expectedChunkSize(manifest, chunkIndex);
    if (chunk.size <= 0 || chunk.size > manifest.chunkSize || chunk.size !== expected) {
      throw new BadRequestException({
        code: 'CHUNK_SIZE_MISMATCH',
        message: `Chunk ${chunkIndex} must be exactly ${expected} bytes`,
      });
    }
    const dest = this.chunkPath(sessionId, chunkIndex);
    try {
      const stat = await fs.promises.stat(dest);
      if (stat.isFile()) {
        if (stat.size === chunk.size) {
          // Idempoten: kirim ulang chunk yang sama (retry jaringan) → 200.
          return this.status(userId, sessionId);
        }
        throw new ConflictException({
          code: 'CHUNK_CONFLICT',
          message: `Chunk ${chunkIndex} already exists with different size — start a new session`,
        });
      }
    } catch (e) {
      if (e instanceof ConflictException) throw e;
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e;
    }
    // Tulis atomik: .part lalu rename — pembaca `status`/`complete` tidak
    // pernah melihat chunk setengah tertulis.
    const tmp = `${dest}.part`;
    await fs.promises.writeFile(tmp, chunk.buffer);
    await fs.promises.rename(tmp, dest);
    return this.status(userId, sessionId);
  }

  async status(userId: string, sessionId: string): Promise<ChunkStatusResult> {
    const manifest = await this.loadManifest(userId, sessionId);
    const received = await this.receivedChunks(manifest);
    let receivedBytes = 0;
    for (const i of received) receivedBytes += this.expectedChunkSize(manifest, i);
    return {
      sessionId,
      chunkSize: manifest.chunkSize,
      totalChunks: manifest.totalChunks,
      totalSize: manifest.totalSize,
      received,
      receivedBytes,
      expiresAt: manifest.expiresAt,
    };
  }

  /**
   * Rakit semua chunk (streaming, tanpa memuat seluruh file ke memori
   * sekaligus) lalu jalankan pipeline `UploadService.uploadDirect` yang SAMA
   * seperti upload single-shot — validasi magic-byte, batas purpose, dan
   * pemrosesan video (ffmpeg thumbnail) tetap berlaku. Direktori sesi selalu
   * dibersihkan (sukses maupun gagal).
   */
  async complete(userId: string, sessionId: string): Promise<DirectUploadResult> {
    const manifest = await this.loadManifest(userId, sessionId);
    const received = await this.receivedChunks(manifest);
    if (received.length !== manifest.totalChunks) {
      const missing = Array.from({ length: manifest.totalChunks }, (_, i) => i).filter(
        (i) => !received.includes(i),
      );
      throw new BadRequestException({
        code: 'CHUNKS_MISSING',
        message: `Missing chunks: ${missing.slice(0, 10).join(',')}${missing.length > 10 ? '…' : ''}`,
      });
    }
    const assembledPath = path.join(this.sessionDir(sessionId), 'assembled.bin');
    try {
      const out = fs.createWriteStream(assembledPath);
      for (let i = 0; i < manifest.totalChunks; i++) {
        const chunkFile = this.chunkPath(sessionId, i);
        await new Promise<void>((resolve, reject) => {
          const input = fs.createReadStream(chunkFile);
          input.on('error', reject);
          input.on('end', resolve);
          input.pipe(out, { end: false });
        });
      }
      await new Promise<void>((resolve, reject) => {
        out.on('finish', resolve);
        out.on('error', reject);
        out.end();
      });
      const stat = await fs.promises.stat(assembledPath);
      if (stat.size !== manifest.totalSize) {
        throw new BadRequestException({
          code: 'CHUNK_SIZE_MISMATCH',
          message: 'Assembled file size does not match declared totalSize',
        });
      }
      const buffer = await fs.promises.readFile(assembledPath);
      return await this.uploadService.uploadDirect(
        userId,
        manifest.purpose,
        manifest.fileName,
        manifest.mimeType,
        buffer,
      );
    } finally {
      await this.destroySession(sessionId).catch(() => undefined);
    }
  }
}
