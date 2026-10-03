import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface VideoProbeResult {
  /** Durasi dalam detik (float dari ffprobe). */
  durationSec: number;
  /** Lebar stream video pertama (px). */
  width: number;
  /** Tinggi stream video pertama (px). */
  height: number;
}

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
   * UPV-03: batasi ffmpeg/ffprobe konkuren — proses ini CPU-bound dan
   * berjalan di dalam request handler. Tanpa batas, N upload video
   * bersamaan menahan event loop/CPU hingga ~90 dtk per request.
   * Semaphore sederhana: maks 2 proses ffmpeg/ffprobe jalan bersamaan per
   * instance; sisanya antre di promise (tidak menolak — upload tetap jalan,
   * hanya lebih lambat saat spike).
   */
  private static readonly MAX_CONCURRENT_FFMPEG = 2;
  private activeFfmpeg = 0;
  private readonly ffmpegWaiters: Array<() => void> = [];

  private async acquireFfmpegSlot(): Promise<() => void> {
    if (this.activeFfmpeg < VideoProcessingService.MAX_CONCURRENT_FFMPEG) {
      this.activeFfmpeg += 1;
      return () => this.releaseFfmpegSlot();
    }
    await new Promise<void>((resolve) => this.ffmpegWaiters.push(resolve));
    this.activeFfmpeg += 1;
    return () => this.releaseFfmpegSlot();
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
      require('child_process').execFileSync('ffprobe', ['-version'], { stdio: 'ignore', timeout: 5000 });
      require('child_process').execFileSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 5000 });
      this.availability = true;
    } catch {
      this.availability = false;
    }
    return this.availability;
  }

  /**
   * Baca durasi + dimensi video. Melempar Error bila file bukan video valid
   * atau ffprobe tidak bisa membaca stream-nya (fail closed di pemanggil).
   */
  async probeVideo(filePath: string): Promise<VideoProbeResult> {
    const release = await this.acquireFfmpegSlot();
    try {
      return await this.probeVideoInner(filePath);
    } finally {
      release();
    }
  }

  private async probeVideoInner(filePath: string): Promise<VideoProbeResult> {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync('ffprobe', [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'format=duration:stream=width,height',
        '-of', 'json',
        filePath,
      ], { timeout: 30000, maxBuffer: 1024 * 1024 }));
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
    const release = await this.acquireFfmpegSlot();
    try {
      await execFileAsync('ffmpeg', [
        '-y',
        '-ss', String(Math.max(0, atSecond)),
        '-i', filePath,
        '-vframes', '1',
        '-vf', `scale=${width}:-2`,
        '-q:v', '5',
        destPath,
      ], { timeout: 60000, maxBuffer: 1024 * 1024 });
    } catch (err) {
      this.logger.warn(`ffmpeg thumbnail gagal untuk ${filePath}: ${(err as Error).message}`);
      throw new Error('VIDEO_THUMBNAIL_FAILED');
    } finally {
      release();
    }
  }
}
