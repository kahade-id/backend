import { Injectable, Logger } from '@nestjs/common';
import { execFile, execFileSync } from 'child_process';
import * as fs from 'fs';

export interface VideoProbeResult {
  /** Durasi dalam detik (float dari ffprobe). */
  durationSec: number;
  /** Lebar stream video pertama (px). */
  width: number;
  /** Tinggi stream video pertama (px). */
  height: number;
}

/**
 * Bug #2 (video showcase "Memproses video..." tanpa akhir): timeout tunggal
 * `execFile({ timeout })` TIDAK cukup. Node hanya mengirim `killSignal`
 * (default SIGTERM) saat timeout; proses yang mengabaikan SIGTERM (atau
 * tertahan di uninterruptible I/O pada file besar/FS penuh) membuat promise
 * `execFile` TIDAK PERNAH settle. Karena slot semaphore ffmpeg dipegang sampai
 * promise settle, dua kejadian seperti itu membuat SEMUA upload video
 * berikutnya antre selamanya tanpa error dan tanpa log.
 *
 * Perbaikan berlapis:
 * 1. `killSignal: 'SIGKILL'` — timeout normal membunuh paksa (tidak bisa
 *    diabaikan proses anak).
 * 2. Watchdog independen `timeout + KILL_GRACE_MS` yang SELALU menolak
 *    promise (sekalipun proses anak tetap hidup, mis. D-state), sehingga slot
 *    semaphore dilepas dan permintaan gagal cepat dengan pesan jelas.
 * 3. Log berjenjang di setiap tahap (mulai/selesai/gagal + elapsed) supaya
 *    insiden berikutnya bisa didiagnosis dari log produksi saja.
 */
const KILL_GRACE_MS = 5_000;

/**
 * Batch 19 TIM A (item 1) — pemrosesan video showcase via ffmpeg/ffprobe.
 *
 * Semua pemanggilan memakai execFile (argv array, tanpa shell) sehingga path
 * file tidak bisa meng-inject perintah. Path yang diproses SELALU berasal dari
 * server (LocalStorageService.resolvePath), bukan input mentah user.
 *
 * PRASYARAT DEPLOY: `ffmpeg` + `ffprobe` harus terinstal di server
 * (15.232.109.186). Tanpa itu upload video showcase gagal fail-closed.
 */
@Injectable()
export class VideoProcessingService {
  private readonly logger = new Logger(VideoProcessingService.name);
  private availability: boolean | null = null;

  /**
   * Path biner ffprobe. Default: cari di PATH (perilaku lama). Override
   * opsional lewat env `FFPROBE_PATH` untuk deploy yang ffmpeg-nya tidak ada
   * di PATH — sekaligus jalur deterministik bagi test (lihat
   * video-processing-hang.spec.ts).
   */
  protected get ffprobeBin(): string {
    return process.env.FFPROBE_PATH || 'ffprobe';
  }

  /** Path biner ffmpeg — lihat `ffprobeBin`. */
  protected get ffmpegBin(): string {
    return process.env.FFMPEG_PATH || 'ffmpeg';
  }

  /**
   * Timeout ffprobe (ms). Getter (bukan field) supaya test bisa menurunkan
   * nilainya lewat subclass tanpa mengubah default produksi.
   */
  protected get probeTimeoutMs(): number {
    return 30_000;
  }

  /** Timeout ffmpeg thumbnail (ms) — lihat `probeTimeoutMs`. */
  protected get thumbnailTimeoutMs(): number {
    return 60_000;
  }

  /**
   * Grace setelah timeout resmi sebelum watchdog menolak permintaan —
   * lihat `KILL_GRACE_MS`. Getter agar test bisa mempercepat.
   */
  protected get killGraceMs(): number {
    return KILL_GRACE_MS;
  }

  /**
   * Seam test: pemanggilan biner sesungguhnya. Test menimpanya untuk
   * mensimulasikan proses anak yang TIDAK PERNAH menyelesaikan callback
   * (kasus uninterruptible I/O) — satu-satunya cara memverifikasi watchdog
   * lapis kedua tanpa membuat proses D-state sungguhan.
   */
  protected spawnBinary(
    binary: string,
    args: string[],
    options: { timeout: number; killSignal: NodeJS.Signals; maxBuffer: number },
    callback: (error: Error | null, stdout: string) => void,
  ): { kill: (signal?: NodeJS.Signals) => boolean } {
    return execFile(binary, args, options, callback as never);
  }

  /**
   * UPV-03: batasi ffmpeg/ffprobe konkuren — proses ini CPU-bound dan
   * berjalan di dalam request handler. Tanpa batas, N upload video
   * bersamaan menahan event loop/CPU hingga ~90 dtk per request.
   * Semaphore sederhana: maks 2 proses ffmpeg/ffprobe jalan bersamaan per
   * instance; sisanya antre di promise (tidak menolak — upload tetap jalan,
   * hanya lebih lambat saat spike).
   */
  private static readonly MAX_CONCURRENT_FFMPEG = 2;
  /** Ambang logging antrean slot (Bug #2): antre lama = gejala spike/ffmpeg nyangkut. */
  private static readonly SLOT_WAIT_LOG_MS = 1500;
  private activeFfmpeg = 0;
  private readonly ffmpegWaiters: Array<() => void> = [];

  private async acquireFfmpegSlot(label: string): Promise<() => void> {
    const startedAt = Date.now();
    if (this.activeFfmpeg < VideoProcessingService.MAX_CONCURRENT_FFMPEG) {
      this.activeFfmpeg += 1;
      if (this.ffmpegWaiters.length > 0) {
        this.logger.debug(
          `[ffmpeg-slot] ${label} mengambil slot bebas; ${this.ffmpegWaiters.length} masih menunggu`,
        );
      }
      return this.makeRelease();
    }
    this.logger.log(
      `[ffmpeg-slot] ${label} menunggu slot (aktif=${this.activeFfmpeg}/${VideoProcessingService.MAX_CONCURRENT_FFMPEG}, antre=${this.ffmpegWaiters.length + 1})`,
    );
    await new Promise<void>((resolve) => this.ffmpegWaiters.push(resolve));
    this.activeFfmpeg += 1;
    const waitedMs = Date.now() - startedAt;
    if (waitedMs >= VideoProcessingService.SLOT_WAIT_LOG_MS) {
      this.logger.warn(`[ffmpeg-slot] ${label} menunggu ${waitedMs}ms sebelum dapat slot`);
    }
    return this.makeRelease();
  }

  /** Release idempoten — double release (bug lama) bisa melepas slot orang lain. */
  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.releaseFfmpegSlot();
    };
  }

  private releaseFfmpegSlot(): void {
    this.activeFfmpeg = Math.max(0, this.activeFfmpeg - 1);
    const next = this.ffmpegWaiters.shift();
    if (next) next();
  }

  /** true bila ffmpeg & ffprobe tersedia di PATH. Hasil di-cache per proses. */
  isAvailable(): boolean {
    if (this.availability !== null) return this.availability;
    try {
      execFileSync(this.ffprobeBin, ['-version'], { stdio: 'ignore', timeout: 5000 });
      execFileSync(this.ffmpegBin, ['-version'], { stdio: 'ignore', timeout: 5000 });
      this.availability = true;
      this.logger.log(
        `[ffmpeg-check] tersedia: ffprobe=${this.ffprobeBin} ffmpeg=${this.ffmpegBin}`,
      );
    } catch {
      this.availability = false;
      this.logger.error(
        `[ffmpeg-check] ffprobe/ffmpeg TIDAK tersedia (ffprobe=${this.ffprobeBin} ffmpeg=${this.ffmpegBin}) — ` +
          'upload video showcase akan ditolak (fail-closed). Instal ffmpeg di server atau set FFPROBE_PATH/FFMPEG_PATH.',
      );
    }
    return this.availability;
  }

  /**
   * Bug #2: jalankan biner dengan timeout berlapis (SIGKILL + watchdog).
   * Selalu settle (resolve/reject) — tidak pernah menggantung tanpa batas.
   */
  private runBinary(
    binary: string,
    args: string[],
    opts: { timeoutMs: number; maxBuffer: number; label: string },
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const state: { settled: boolean; timer: NodeJS.Timeout | null } = { settled: false, timer: null };
      const settle = (fn: () => void): void => {
        if (state.settled) return;
        state.settled = true;
        if (state.timer) clearTimeout(state.timer);
        fn();
      };

      const graceMs = this.killGraceMs;
      const child = this.spawnBinary(
        binary,
        args,
        { timeout: opts.timeoutMs, killSignal: 'SIGKILL', maxBuffer: opts.maxBuffer },
        (err, stdout) => {
          if (err) {
            settle(() => reject(err));
          } else {
            settle(() => resolve(stdout));
          }
        },
      );

      state.timer = setTimeout(() => {
        settle(() => {
          this.logger.error(
            `[${opts.label}] proses ${binary} belum berhenti setelah ${opts.timeoutMs + graceMs}ms ` +
              `— SIGKILL paksa & permintaan ditolak (watchdog anti-hang Bug #2)`,
          );
          try {
            child.kill('SIGKILL');
          } catch {
            /* proses sudah mati */
          }
          reject(new Error(`${opts.label}_TIMEOUT`));
        });
      }, opts.timeoutMs + graceMs);
    });
  }

  /**
   * Baca durasi + dimensi video. Melempar Error bila file bukan video valid
   * atau ffprobe tidak bisa membaca stream-nya (fail closed di pemanggil).
   */
  async probeVideo(filePath: string): Promise<VideoProbeResult> {
    const release = await this.acquireFfmpegSlot('ffprobe');
    const startedAt = Date.now();
    this.logger.log(`[video-probe] mulai file=${filePath}`);
    try {
      const result = await this.probeVideoInner(filePath);
      this.logger.log(
        `[video-probe] selesai file=${filePath} duration=${result.durationSec.toFixed(3)}s ` +
          `dim=${result.width}x${result.height} elapsed=${Date.now() - startedAt}ms`,
      );
      return result;
    } catch (err) {
      this.logger.warn(
        `[video-probe] gagal file=${filePath} elapsed=${Date.now() - startedAt}ms error=${(err as Error).message}`,
      );
      throw err;
    } finally {
      release();
    }
  }

  private async probeVideoInner(filePath: string): Promise<VideoProbeResult> {
    let stdout: string;
    try {
      stdout = await this.runBinary(
        this.ffprobeBin,
        [
          '-v', 'error',
          '-select_streams', 'v:0',
          '-show_entries', 'format=duration:stream=width,height',
          '-of', 'json',
          filePath,
        ],
        { timeoutMs: this.probeTimeoutMs, maxBuffer: 1024 * 1024, label: 'VIDEO_PROBE' },
      );
    } catch (err) {
      this.logger.warn(`ffprobe gagal membaca ${filePath}: ${(err as Error).message}`);
      throw new Error('VIDEO_UNPROCESSABLE');
    }
    let parsed: { format?: { duration?: string }; streams?: { width?: number; height?: number }[] };
    try {
      parsed = JSON.parse(stdout) as typeof parsed;
    } catch {
      throw new Error('VIDEO_UNPROCESSABLE');
    }
    const durationSec = Number(parsed.format?.duration);
    const width = Number(parsed.streams?.[0]?.width);
    const height = Number(parsed.streams?.[0]?.height);
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      throw new Error('VIDEO_UNPROCESSABLE');
    }
    if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
      throw new Error('VIDEO_UNPROCESSABLE');
    }
    return { durationSec, width, height };
  }

  /**
   * Generate thumbnail JPEG (satu frame) dari video. Melempar Error bila
   * ffmpeg gagal — pemanggil menghapus file video yang sudah tersimpan.
   */
  async generateThumbnail(filePath: string, destPath: string, atSecond: number, width: number): Promise<void> {
    const release = await this.acquireFfmpegSlot('ffmpeg');
    const startedAt = Date.now();
    const safeAt = Math.max(0, atSecond);
    this.logger.log(
      `[video-thumbnail] mulai file=${filePath} dest=${destPath} at=${safeAt}s width=${width}px`,
    );
    try {
      await this.runBinary(
        this.ffmpegBin,
        [
          '-y',
          '-ss', String(safeAt),
          '-i', filePath,
          '-vframes', '1',
          '-vf', `scale=${width}:-2`,
          '-q:v', '5',
          destPath,
        ],
        { timeoutMs: this.thumbnailTimeoutMs, maxBuffer: 1024 * 1024, label: 'VIDEO_THUMBNAIL' },
      );
      let bytes: number | null = null;
      try {
        bytes = (await fs.promises.stat(destPath)).size;
      } catch {
        bytes = null;
      }
      this.logger.log(
        `[video-thumbnail] selesai dest=${destPath} bytes=${bytes ?? '?'} elapsed=${Date.now() - startedAt}ms`,
      );
    } catch (err) {
      this.logger.error(
        `[video-thumbnail] gagal file=${filePath} elapsed=${Date.now() - startedAt}ms error=${(err as Error).message}`,
      );
      throw new Error('VIDEO_THUMBNAIL_FAILED');
    } finally {
      release();
    }
  }
}
