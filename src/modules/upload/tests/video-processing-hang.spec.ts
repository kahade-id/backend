/**
 * Regresi Bug #2 — upload video showcase menggantung di "Memproses video...".
 *
 * Akar masalah (dibuktikan test ini): `execFile({ timeout })` HANYA mengirim
 * SIGTERM. Proses ffprobe/ffmpeg yang mengabaikan SIGTERM (atau tertahan di
 * uninterruptible I/O pada file besar / FS penuh) membuat promise TIDAK PERNAH
 * settle. Karena slot semaphore ffmpeg dipegang sampai promise settle, dua
 * kejadian seperti itu membuat SEMUA upload video berikutnya antre selamanya —
 * tanpa error, tanpa log, tanpa jalan pulih selain restart proses.
 *
 * Biner ffprobe/ffmpeg palsu + verifikasi PID benar-benar mati: lihat
 * `helpers/fake-ffmpeg.ts`.
 */
import { Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

import { VideoProcessingService } from '../video-processing.service';
import { createFakeFfmpegHarness, waitUntilDead, type FakeFfmpegHarness } from './helpers/fake-ffmpeg';

jest.setTimeout(30_000);

/** Timeout cepat supaya test tidak menunggu 30s/60s produksi. */
class FastVideoProcessingService extends VideoProcessingService {
  protected get probeTimeoutMs(): number {
    return 600;
  }

  protected get thumbnailTimeoutMs(): number {
    return 600;
  }

  protected get killGraceMs(): number {
    return 300;
  }
}

describe('VideoProcessingService — anti-hang (Bug #2)', () => {
  let harness: FakeFfmpegHarness;

  beforeAll(() => {
    harness = createFakeFfmpegHarness();
    harness.installEnv();
  });

  afterAll(() => {
    harness.cleanup();
  });

  afterEach(() => {
    harness.setMode('ok');
    for (const bin of ['ffprobe', 'ffmpeg'] as const) {
      fs.rmSync(path.join(harness.dir, `${bin}.pid`), { force: true });
    }
    jest.restoreAllMocks();
  });

  const setMode = (mode: 'ok' | 'hang' | 'garbage' | 'fail'): void => harness.setMode(mode);

  it('probeVideo sukses membaca metadata dari JSON ffprobe', async () => {
    const svc = new FastVideoProcessingService();
    expect(svc.isAvailable()).toBe(true);
    await expect(svc.probeVideo('/tmp/whatever.mp4')).resolves.toEqual({
      durationSec: 12.5,
      width: 1280,
      height: 720,
    });
  });

  it('probeVideo yang menggantung DITOLAK (bukan menggantung) & proses anak dibunuh', async () => {
    const svc = new FastVideoProcessingService();
    expect(svc.isAvailable()).toBe(true);
    setMode('hang');

    const startedAt = Date.now();
    await expect(svc.probeVideo('/tmp/hang.mp4')).rejects.toThrow('VIDEO_UNPROCESSABLE');
    const elapsed = Date.now() - startedAt;

    // Batas keras: timeout 600ms + grace 300ms + toleransi.
    expect(elapsed).toBeLessThan(2500);
    // Proses `sleep 600` benar-benar mati (SIGKILL) — bukan hanya promise-nya ditolak.
    expect(await waitUntilDead(path.join(harness.dir, 'ffprobe.pid'))).toBeNull();
  });

  it('slot semaphore DILEPAS setelah hang — upload berikutnya tidak ikut macet', async () => {
    const svc = new FastVideoProcessingService();
    expect(svc.isAvailable()).toBe(true);

    // Dua hang berurutan = kondisi yang dulu membuat semaphore (max 2) macet total.
    setMode('hang');
    await expect(svc.probeVideo('/tmp/hang-1.mp4')).rejects.toThrow('VIDEO_UNPROCESSABLE');
    await expect(svc.probeVideo('/tmp/hang-2.mp4')).rejects.toThrow('VIDEO_UNPROCESSABLE');

    // Kalau slot tidak dilepas, dua promise ini tidak akan pernah selesai.
    setMode('ok');
    const results = await Promise.all([
      svc.probeVideo('/tmp/ok-1.mp4'),
      svc.probeVideo('/tmp/ok-2.mp4'),
      svc.probeVideo('/tmp/ok-3.mp4'),
    ]);
    expect(results).toHaveLength(3);
    for (const r of results) expect(r.width).toBe(1280);
  });

  it('generateThumbnail yang menggantung DITOLAK, proses anak dibunuh, slot dilepas', async () => {
    const svc = new FastVideoProcessingService();
    expect(svc.isAvailable()).toBe(true);

    setMode('hang');
    const startedAt = Date.now();
    await expect(svc.generateThumbnail('/tmp/hang.mp4', '/tmp/thumb-hang.jpg', 1, 640)).rejects.toThrow(
      'VIDEO_THUMBNAIL_FAILED',
    );
    expect(Date.now() - startedAt).toBeLessThan(2500);
    expect(await waitUntilDead(path.join(harness.dir, 'ffmpeg.pid'))).toBeNull();

    setMode('ok');
    const dest = path.join(harness.dir, 'out-thumb.jpg');
    await expect(svc.generateThumbnail('/tmp/ok.mp4', dest, 1, 640)).resolves.toBeUndefined();
    expect(fs.readFileSync(dest, 'utf8')).toBe('JPEG-FAKE-THUMBNAIL');
  });

  it('watchdog lapis kedua: callback tidak pernah dipanggil → ditolak + SIGKILL dipaksa', async () => {
    class NeverSettlingService extends FastVideoProcessingService {
      readonly kills: Array<string | undefined> = [];
      // Proses anak "tidak bisa di-kill" (mis. D-state): callback tak pernah
      // dipanggil, kill() hanya dicatat.
      protected spawnBinary(): { kill: (signal?: NodeJS.Signals) => boolean } {
        return {
          kill: (signal?: NodeJS.Signals) => {
            (this as NeverSettlingService).kills.push(signal);
            return true;
          },
        };
      }
    }
    const svc = new NeverSettlingService();

    const errors: string[] = [];
    jest.spyOn(Logger.prototype, 'error').mockImplementation((msg: unknown) => {
      errors.push(String(msg));
    });
    const startedAt = Date.now();
    // `probeVideo` membungkus kegagalan apa pun jadi VIDEO_UNPROCESSABLE untuk
    // pemanggil (kontrak API tidak berubah); bukti jalur watchdog ada di log.
    await expect(svc.probeVideo('/tmp/dstate.mp4')).rejects.toThrow('VIDEO_UNPROCESSABLE');
    const elapsed = Date.now() - startedAt;
    expect(errors.some((l) => l.includes('[VIDEO_PROBE]') && l.includes('watchdog anti-hang Bug #2'))).toBe(true);

    // Tepat setelah timeout + grace — permintaan TIDAK menunggu selamanya.
    expect(elapsed).toBeGreaterThanOrEqual(850);
    expect(elapsed).toBeLessThan(2000);
    expect(svc.kills).toContain('SIGKILL');
  });

  it('log setiap tahap ffprobe/ffmpeg (mulai/selesai/gagal) tersedia untuk diagnosis', async () => {
    const logs: string[] = [];
    const warns: string[] = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((msg: unknown) => {
      logs.push(String(msg));
    });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((msg: unknown) => {
      warns.push(String(msg));
    });
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

    const svc = new FastVideoProcessingService();
    expect(svc.isAvailable()).toBe(true);

    setMode('ok');
    await svc.probeVideo('/tmp/log-ok.mp4');
    await svc.generateThumbnail('/tmp/log-ok.mp4', path.join(harness.dir, 'log-thumb.jpg'), 1, 640);

    expect(logs.some((l) => l.includes('[video-probe] mulai'))).toBe(true);
    expect(logs.some((l) => l.includes('[video-probe] selesai') && l.includes('elapsed='))).toBe(true);
    expect(logs.some((l) => l.includes('[video-thumbnail] mulai'))).toBe(true);
    expect(logs.some((l) => l.includes('[video-thumbnail] selesai') && l.includes('bytes='))).toBe(true);

    setMode('hang');
    await expect(svc.probeVideo('/tmp/log-hang.mp4')).rejects.toThrow();
    expect(warns.some((l) => l.includes('[video-probe] gagal') && l.includes('elapsed='))).toBe(true);
  });
});
