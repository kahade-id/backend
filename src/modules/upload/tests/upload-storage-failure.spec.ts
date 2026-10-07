/**
 * Bug #2 — kegagalan PENYIMPANAN (disk penuh / FS read-only / izin) tidak lagi
 * menggantung, tidak lagi lolos sebagai error tak tertangani, dan bisa
 * didiagnosis dari log.
 *
 * Yang diuji:
 * 1. `complete` chunked saat menulis file rakitan gagal ENOSPC → 503
 *    `UPLOAD_STORAGE_UNAVAILABLE`, log memuat errno + capacity=true, direktori
 *    sesi dibersihkan, dan TIDAK ada unhandled error (dulu write-stream tanpa
 *    listener 'error' → unhandled 'error' event yang bisa mematikan proses).
 * 2. `uploadChunk` saat menulis chunk gagal ENOSPC → 503 + sisa `.part`
 *    dibersihkan.
 * 3. `uploadDirect` saat `saveFile` gagal ENOSPC → 503; gagal EACCES → 503;
 *    gagal non-storage (mis. TypeError bug) → tetap 400 UPLOAD_FAILED.
 * 4. Probe storage `GET /v1/health/synthetic` memakai direktori yang SAMA
 *    dengan aplikasi (STORAGE_PATH) — bukan UPLOAD_DIR yang bisa menunjuk
 *    volume berbeda.
 */
import { BadRequestException, Logger, ServiceUnavailableException } from '@nestjs/common';
import * as fs from 'fs';
import { PassThrough } from 'stream';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';

import { ChunkedUploadService } from '../chunked-upload.service';
import { UploadService } from '../upload.service';
import { LocalStorageService } from '../local-storage.service';
import { VideoProcessingService } from '../video-processing.service';
import { UploadPurpose } from '../dto/presigned-url.dto';
import { SyntheticService, resolveStorageDirForProbe } from '../../observability/synthetic.service';

jest.setTimeout(30_000);

const USER = 'cluser00000000000000001';

function errorCodeOf(err: unknown): string | null {
  const response = (err as { getResponse?: () => unknown })?.getResponse?.();
  if (response && typeof response === 'object' && 'code' in response) {
    return String((response as { code: unknown }).code);
  }
  return null;
}

const enospc = () => Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
const eacces = () => Object.assign(new Error('permission denied'), { code: 'EACCES' });

/** Write-stream yang langsung mengemit ENOSPC — meniru disk penuh saat merakit. */
class FailingWriteStream extends PassThrough {}

class FailingChunkedUploadService extends ChunkedUploadService {
  protected createWriteStream(): fs.WriteStream {
    const stream = new FailingWriteStream();
    process.nextTick(() => stream.emit('error', Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })));
    return stream as unknown as fs.WriteStream;
  }
}

describe('Bug #2 — kegagalan penyimpanan (disk penuh / izin) tertangani & ter-log', () => {
  let storageRoot: string;
  let uploadService: UploadService;
  let chunked: ChunkedUploadService;
  let failingChunked: ChunkedUploadService;
  let logs: string[];
  let warns: string[];
  let errors: string[];

  beforeEach(() => {
    storageRoot = mkdtempSync(join(tmpdir(), 'kahade-storage-fail-'));
    const configService = {
      get: (key: string) =>
        key === 'app.storagePath' ? storageRoot : key === 'app.storagePublicUrl' ? 'https://api.kahade.id/uploads' : undefined,
    };
    const localStorage = new LocalStorageService(configService as never);
    uploadService = new UploadService(
      configService as never,
      { setNx: jest.fn(), del: jest.fn() } as never,
      localStorage,
      new VideoProcessingService(),
    );
    chunked = new ChunkedUploadService(configService as never, uploadService);
    failingChunked = new FailingChunkedUploadService(configService as never, uploadService);
    logs = [];
    warns = [];
    errors = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((m: unknown) => void logs.push(String(m)));
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((m: unknown) => void warns.push(String(m)));
    jest.spyOn(Logger.prototype, 'error').mockImplementation((m: unknown) => void errors.push(String(m)));
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    rmSync(storageRoot, { recursive: true, force: true });
  });

  const initSession = async (totalSize = 512 * 1024) =>
    chunked.initiate(USER, {
      purpose: UploadPurpose.SHOWCASE_VIDEO,
      fileName: 'v.mp4',
      mimeType: 'video/mp4',
      totalSize,
      chunkSize: 512 * 1024,
    });

  it('complete saat penulisan rakitan ENOSPC → 503 UPLOAD_STORAGE_UNAVAILABLE + log errno (bukan unhandled error)', async () => {
    const session = await initSession();
    await chunked.uploadChunk(USER, session.sessionId, 0, {
      buffer: Buffer.alloc(512 * 1024, 0x21),
      size: 512 * 1024,
    });

    // Simulasi disk penuh: write-stream mengemit ENOSPC (perilaku fs nyata).
    let caught: unknown;
    try {
      await failingChunked.complete(USER, session.sessionId);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ServiceUnavailableException);
    expect(errorCodeOf(caught)).toBe('UPLOAD_STORAGE_UNAVAILABLE');
    expect((caught as ServiceUnavailableException).getStatus()).toBe(503);
    // Terklasifikasi + ter-log (dipakai untuk alert disk penuh).
    expect(errors.concat(warns).some((l) => l.includes('[chunked] complete gagal') && l.includes('errno=ENOSPC') && l.includes('capacity=true'))).toBe(true);
    // Sesi dibersihkan: tidak ada file rakitan/chunk yatim.
    const chunkDirs = fs.existsSync(join(storageRoot, '.chunks')) ? fs.readdirSync(join(storageRoot, '.chunks')) : [];
    expect(chunkDirs).toEqual([]);
  });

  it('complete TETAP menggantung? tidak — selesai < 5s dan proses tidak crash', async () => {
    const session = await initSession();
    await chunked.uploadChunk(USER, session.sessionId, 0, { buffer: Buffer.alloc(512 * 1024), size: 512 * 1024 });
    const started = Date.now();
    await expect(failingChunked.complete(USER, session.sessionId)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('uploadChunk saat penulisan chunk ENOSPC → 503 + sisa .part dibersihkan', async () => {
    const session = await initSession();
    const writeSpy = jest.spyOn(fs.promises, 'writeFile').mockRejectedValue(enospc());

    let caught: unknown;
    try {
      await chunked.uploadChunk(USER, session.sessionId, 0, { buffer: Buffer.alloc(512 * 1024), size: 512 * 1024 });
    } catch (err) {
      caught = err;
    } finally {
      writeSpy.mockRestore();
    }

    expect(errorCodeOf(caught)).toBe('UPLOAD_STORAGE_UNAVAILABLE');
    expect(errors.some((l) => l.includes('[chunked] tulis chunk gagal') && l.includes('errno=ENOSPC'))).toBe(true);
    const sessionDir = join(storageRoot, '.chunks', session.sessionId);
    const leftovers = fs.existsSync(sessionDir) ? fs.readdirSync(sessionDir).filter((f) => f.endsWith('.part')) : [];
    expect(leftovers).toEqual([]);
  });

  it('uploadDirect saat saveFile ENOSPC → 503 UPLOAD_STORAGE_UNAVAILABLE + log', async () => {
    const saveSpy = jest.spyOn(LocalStorageService.prototype, 'saveFile').mockRejectedValue(enospc());
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2048, 0x00)]);
    let caught: unknown;
    try {
      await uploadService.uploadDirect(USER, UploadPurpose.CHAT_ATTACHMENT, 'foto.jpg', 'image/jpeg', jpeg);
    } catch (err) {
      caught = err;
    } finally {
      saveSpy.mockRestore();
    }
    expect(errorCodeOf(caught)).toBe('UPLOAD_STORAGE_UNAVAILABLE');
    expect((caught as ServiceUnavailableException).getStatus()).toBe(503);
    expect(errors.some((l) => l.includes('[storage] direct gagal') && l.includes('capacity=true'))).toBe(true);
  });

  it('uploadDirect saat saveFile EACCES (izin) → 503; penyebabnya ter-log dengan errno', async () => {
    const saveSpy = jest.spyOn(LocalStorageService.prototype, 'saveFile').mockRejectedValue(eacces());
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2048, 0x00)]);
    let caught: unknown;
    try {
      await uploadService.uploadDirect(USER, UploadPurpose.CHAT_ATTACHMENT, 'foto.jpg', 'image/jpeg', jpeg);
    } catch (err) {
      caught = err;
    } finally {
      saveSpy.mockRestore();
    }
    expect(errorCodeOf(caught)).toBe('UPLOAD_STORAGE_UNAVAILABLE');
    expect(errors.some((l) => l.includes('errno=EACCES'))).toBe(true);
  });

  it('kegagalan BUKAN penyimpanan tetap 400 UPLOAD_FAILED (kontrak lama tidak berubah)', async () => {
    const saveSpy = jest
      .spyOn(LocalStorageService.prototype, 'saveFile')
      .mockRejectedValue(new TypeError('unexpected bug'));
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2048, 0x00)]);
    let caught: unknown;
    try {
      await uploadService.uploadDirect(USER, UploadPurpose.CHAT_ATTACHMENT, 'foto.jpg', 'image/jpeg', jpeg);
    } catch (err) {
      caught = err;
    } finally {
      saveSpy.mockRestore();
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    expect((caught as BadRequestException).getStatus()).toBe(400);
    expect(errorCodeOf(caught)).toBe('UPLOAD_FAILED');
  });

  describe('probe storage /health/synthetic menunjuk direktori yang benar', () => {
    const ORIGINAL = { storage: process.env.STORAGE_PATH, upload: process.env.UPLOAD_DIR };

    afterEach(() => {
      if (ORIGINAL.storage === undefined) delete process.env.STORAGE_PATH;
      else process.env.STORAGE_PATH = ORIGINAL.storage;
      if (ORIGINAL.upload === undefined) delete process.env.UPLOAD_DIR;
      else process.env.UPLOAD_DIR = ORIGINAL.upload;
    });

    it('STORAGE_PATH diutamakan (volume yang dipakai aplikasi)', () => {
      process.env.STORAGE_PATH = '/mnt/kahade-data';
      process.env.UPLOAD_DIR = '/var/www/kahade-storage';
      expect(resolveStorageDirForProbe()).toBe('/mnt/kahade-data');
    });

    it('UPLOAD_DIR dipakai bila STORAGE_PATH tidak diset', () => {
      delete process.env.STORAGE_PATH;
      process.env.UPLOAD_DIR = '/var/www/kahade-storage';
      expect(resolveStorageDirForProbe()).toBe('/var/www/kahade-storage');
    });

    it('checkStorage menulis-baca-hapus di direktori itu dan melaporkan errno saat gagal', async () => {
      const probeDir = mkdtempSync(join(tmpdir(), 'kahade-probe-'));
      process.env.STORAGE_PATH = probeDir;
      const service = new SyntheticService({} as never, {} as never);

      const ok = await (service as never as { checkStorage: () => Promise<{ status: string; detail?: string }> }).checkStorage();
      expect(ok.status).toBe('ok');
      expect(ok.detail).toContain(`dir=${probeDir}`);
      // Tidak meninggalkan file temp.
      expect(fs.readdirSync(probeDir)).toEqual([]);

      // Direktori tidak bisa ditulis → status down + errno terlihat.
      fs.chmodSync(probeDir, 0o500);
      try {
        const bad = await (service as never as { checkStorage: () => Promise<{ status: string; detail?: string }> }).checkStorage();
        // Root (mis. CI container) masih bisa menulis → hanya assert bentuk saat gagal.
        if (bad.status !== 'ok') {
          expect(bad.detail).toMatch(/EACCES|EROFS|EPERM/);
        }
      } finally {
        fs.chmodSync(probeDir, 0o700);
        rmSync(probeDir, { recursive: true, force: true });
      }
    });
  });
});
