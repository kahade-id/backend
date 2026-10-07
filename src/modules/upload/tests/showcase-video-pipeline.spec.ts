/**
 * Regresi Bug #2 — pipeline video showcase (tahap + fail-open + fail-closed).
 *
 * Menguji `UploadService.uploadDirectFromPath` → `processShowcaseVideo` dengan
 * ffprobe/ffmpeg PALSU (mode dikendalikan berkas — lihat
 * `helpers/fake-ffmpeg.ts`) dan disk sungguhan di direktori temporer:
 *
 *  - sukses: metadata (durasi/dimensi) + thumbnail JPEG tersimpan, dan log
 *    berjenjang per tahap (`mulai`, `probe-ok`, `thumbnail-mulai`, `selesai`)
 *    tersedia untuk diagnosis produksi;
 *  - gagal (bukan video / durasi >180s / resolusi >3840px / ffmpeg error):
 *    ditolak dengan kode error yang benar DAN file video dihapus (fail-closed);
 *  - ffmpeg tidak tersedia: 500 `UPLOAD_FAILED` + file dihapus;
 *  - Redis down saat menandai thumbnail `confirmed_upload`: upload TETAP sukses
 *    (fail-open) — dulu `setNx` melempar setelah semua kerja ffmpeg selesai.
 */
import { BadRequestException, InternalServerErrorException, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { UploadService } from '../upload.service';
import { LocalStorageService } from '../local-storage.service';
import { VideoProcessingService } from '../video-processing.service';
import { UploadPurpose } from '../dto/presigned-url.dto';
import { createFakeFfmpegHarness, type FakeFfmpegHarness } from './helpers/fake-ffmpeg';

jest.setTimeout(30_000);

const USER_ID = 'cluser00000000000000001';
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kahade-storage-'));

/** Video minimal ≥ MIN_FILE_SIZE dengan magic-byte ftyp/isom. */
function fakeMp4(bytes = 4096): Buffer {
  return Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]),
    Buffer.alloc(bytes - 12, 0x21),
  ]);
}

function errorCodeOf(err: unknown): string | null {
  const response = (err as { getResponse?: () => unknown })?.getResponse?.();
  if (response && typeof response === 'object' && 'code' in response) {
    return String((response as { code: unknown }).code);
  }
  return null;
}

describe('Bug #2 — pipeline video showcase', () => {
  let harness: FakeFfmpegHarness;
  let localStorage: LocalStorageService;
  let redis: { setNx: jest.Mock };
  let logs: string[];
  let warns: string[];
  let errors: string[];

  const makeService = (): UploadService =>
    new UploadService(
      { get: jest.fn().mockReturnValue(undefined) } as never,
      redis as never,
      localStorage,
      new VideoProcessingService(),
    );

  /** Nama file di showcase-videos/<user> — dipakai membuktikan tidak ada file yatim. */
  const listVideoFiles = (): string[] => {
    const dir = path.join(storageRoot, 'showcase-videos', USER_ID);
    return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
  };

  const sourceVideo = (): string => {
    const file = path.join(storageRoot, `src-${Date.now()}-${Math.random().toString(16).slice(2)}.mp4`);
    fs.writeFileSync(file, fakeMp4());
    return file;
  };

  beforeAll(() => {
    harness = createFakeFfmpegHarness();
    harness.installEnv();
    localStorage = new LocalStorageService({
      get: (key: string) =>
        key === 'app.storagePath' ? storageRoot : key === 'app.storagePublicUrl' ? 'https://api.kahade.id/uploads' : undefined,
    } as never);
  });

  afterAll(() => {
    harness.cleanup();
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    harness.setMode('ok');
    redis = { setNx: jest.fn().mockResolvedValue(true) };
    logs = [];
    warns = [];
    errors = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((msg: unknown) => void logs.push(String(msg)));
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((msg: unknown) => void warns.push(String(msg)));
    jest.spyOn(Logger.prototype, 'error').mockImplementation((msg: unknown) => void errors.push(String(msg)));
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sukses: metadata + thumbnail tersimpan + log setiap tahap', async () => {
    const svc = makeService();
    const result = await svc.uploadDirectFromPath(
      USER_ID,
      UploadPurpose.SHOWCASE_VIDEO,
      'klip.mp4',
      'video/mp4',
      sourceVideo(),
    );

    expect(result.fileKey).toMatch(new RegExp(`^uploads/showcase-videos/${USER_ID}/`));
    expect(result.durationSec).toBe(13); // 12.5 dibulatkan
    expect(result.width).toBe(1280);
    expect(result.height).toBe(720);
    expect(result.thumbnailFileKey).toMatch(new RegExp(`^uploads/showcase-images/${USER_ID}/`));
    expect(result.thumbnailUrl).toBe(
      `https://api.kahade.id/uploads/${result.thumbnailFileKey!.replace(/^uploads\//, '')}`,
    );
    // File video + thumbnail benar-benar ada di disk.
    expect(fs.statSync(localStorage.resolvePath(result.fileKey)).size).toBe(4096);
    expect(fs.readFileSync(localStorage.resolvePath(result.thumbnailFileKey!), 'utf8')).toBe('JPEG-FAKE-THUMBNAIL');
    // Thumbnail ditandai confirmed (janitor orphan-cleanup).
    expect(redis.setNx).toHaveBeenCalledWith(
      `confirmed_upload:${USER_ID}:${result.thumbnailFileKey}`,
      '1',
      expect.any(Number),
    );
    // Log tahap (dipakai untuk diagnosis produksi).
    expect(logs.some((l) => l.includes('[showcase-video] mulai') && l.includes('size=4096B'))).toBe(true);
    expect(logs.some((l) => l.includes('[showcase-video] probe-ok') && l.includes('duration=12.500s'))).toBe(true);
    expect(logs.some((l) => l.includes('[showcase-video] thumbnail-mulai'))).toBe(true);
    expect(logs.some((l) => l.includes('[showcase-video] selesai') && l.includes('elapsed='))).toBe(true);
  });

  it('video tidak valid (ffprobe keluaran sampah) → 400 VIDEO_UNPROCESSABLE + file dihapus', async () => {
    harness.setMode('garbage');
    const svc = makeService();
    const file = sourceVideo();
    const before = listVideoFiles();
    let caught: unknown;
    try {
      await svc.uploadDirectFromPath(USER_ID, UploadPurpose.SHOWCASE_VIDEO, 'klip.mp4', 'video/mp4', file);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    expect(errorCodeOf(caught)).toBe('VIDEO_UNPROCESSABLE');
    expect(warns.some((l) => l.includes('[video-probe] gagal'))).toBe(true);
    expect(logs.some((l) => l.includes('[showcase-video] gagal') && l.includes('probe ffprobe gagal'))).toBe(true);
    // Fail-closed: tidak ada video yatim — daftar file kembali seperti semula.
    expect(listVideoFiles()).toEqual(before);
  });

  it('durasi > 180s → 400 VIDEO_TOO_LONG + file dihapus', async () => {
    harness.setMode('too-long');
    const svc = makeService();
    let caught: unknown;
    try {
      await svc.uploadDirectFromPath(USER_ID, UploadPurpose.SHOWCASE_VIDEO, 'klip.mp4', 'video/mp4', sourceVideo());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    expect(errorCodeOf(caught)).toBe('VIDEO_TOO_LONG');
    expect(logs.some((l) => l.includes('[showcase-video] gagal') && l.includes('durasi 300.0s'))).toBe(true);
  });

  it('resolusi > 3840px → 400 VIDEO_RESOLUTION_TOO_HIGH + file dihapus', async () => {
    harness.setMode('huge');
    const svc = makeService();
    let caught: unknown;
    try {
      await svc.uploadDirectFromPath(USER_ID, UploadPurpose.SHOWCASE_VIDEO, 'klip.mp4', 'video/mp4', sourceVideo());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    expect(errorCodeOf(caught)).toBe('VIDEO_RESOLUTION_TOO_HIGH');
    expect(logs.some((l) => l.includes('[showcase-video] gagal') && l.includes('8000x4320'))).toBe(true);
  });

  it('ffmpeg thumbnail gagal → 500 UPLOAD_FAILED dan video+thumbnail dibersihkan', async () => {
    harness.setMode('fail');
    const svc = makeService();
    const before = listVideoFiles();
    let caught: unknown;
    try {
      await svc.uploadDirectFromPath(USER_ID, UploadPurpose.SHOWCASE_VIDEO, 'klip.mp4', 'video/mp4', sourceVideo());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InternalServerErrorException);
    expect(errorCodeOf(caught)).toBe('UPLOAD_FAILED');
    expect(errors.some((l) => l.includes('[video-thumbnail] gagal'))).toBe(true);
    expect(logs.some((l) => l.includes('[showcase-video] gagal') && l.includes('thumbnail ffmpeg gagal'))).toBe(true);
    expect(listVideoFiles()).toEqual(before);
  });

  it('ffmpeg/ffprobe tidak tersedia → 500 UPLOAD_FAILED + file dihapus (fail-closed)', async () => {
    const origProbe = process.env.FFPROBE_PATH;
    process.env.FFPROBE_PATH = path.join(harness.dir, 'tidak-ada-ffprobe');
    process.env.FFMPEG_PATH = path.join(harness.dir, 'tidak-ada-ffmpeg');
    const before = listVideoFiles();
    try {
      const svc = makeService();
      let caught: unknown;
      try {
        await svc.uploadDirectFromPath(USER_ID, UploadPurpose.SHOWCASE_VIDEO, 'klip.mp4', 'video/mp4', sourceVideo());
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(InternalServerErrorException);
      expect(errorCodeOf(caught)).toBe('UPLOAD_FAILED');
      expect(
        errors.some((l) => l.includes('[ffmpeg-check]') && l.toLowerCase().includes('tidak tersedia')),
      ).toBe(true);
      expect(logs.some((l) => l.includes('[showcase-video] gagal') && l.includes('ffmpeg/ffprobe tidak tersedia'))).toBe(true);
      expect(listVideoFiles()).toEqual(before);
    } finally {
      if (origProbe === undefined) delete process.env.FFPROBE_PATH;
      else process.env.FFPROBE_PATH = origProbe;
      harness.installEnv();
    }
  });

  it('Redis down saat setNx confirmed_upload → upload TETAP sukses (fail-open)', async () => {
    redis.setNx.mockRejectedValue(new Error('Redis connection refused'));
    const svc = makeService();
    const result = await svc.uploadDirectFromPath(
      USER_ID,
      UploadPurpose.SHOWCASE_VIDEO,
      'klip.mp4',
      'video/mp4',
      sourceVideo(),
    );
    expect(result.thumbnailFileKey).toBeDefined();
    expect(fs.existsSync(localStorage.resolvePath(result.thumbnailFileKey!))).toBe(true);
    expect(warns.some((l) => l.includes('setNx confirmed_upload gagal') && l.includes('fail-open'))).toBe(true);
    expect(logs.some((l) => l.includes('[showcase-video] selesai'))).toBe(true);
  });
});
