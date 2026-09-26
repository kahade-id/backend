import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';

/**
 * LocalStorageService — penyimpanan file self-hosted di disk server.
 *
 * Menggantikan Cloudflare R2 (2026-09-26): tidak ada biaya cloud, file
 * disimpan di STORAGE_PATH (default /var/www/kahade-storage) dan diserve
 * langsung oleh nginx via location /uploads/.
 *
 * fileKey format tetap: uploads/<folder>/<userId>/<timestamp>-<random>-<name>
 * Public URL: https://api.kahade.id/uploads/<path-setelah-uploads/>
 */
@Injectable()
export class LocalStorageService {
  private readonly logger = new Logger(LocalStorageService.name);
  private readonly basePath: string;
  private readonly publicBaseUrl: string;

  constructor(private configService: ConfigService) {
    this.basePath = this.configService.get<string>('app.storagePath') || '/var/www/kahade-storage';
    // URL publik untuk file — diserve nginx dari basePath
    this.publicBaseUrl = (this.configService.get<string>('app.storagePublicUrl') || 'https://api.kahade.id/uploads').replace(/\/+$/, '');
    // Pastikan direktori ada
    try {
      fs.mkdirSync(this.basePath, { recursive: true });
    } catch (e) {
      this.logger.error(`Failed to create storage dir ${this.basePath}: ${e}`);
    }
  }

  /** Path absolut di disk untuk sebuah fileKey. */
  resolvePath(fileKey: string): string {
    // fileKey: uploads/<folder>/<userId>/<file> → <basePath>/<folder>/<userId>/<file>
    // ("uploads/" prefix di-strip karena basePath sudah mewakilinya)
    const relative = fileKey.startsWith('uploads/') ? fileKey.slice('uploads/'.length) : fileKey;
    const full = path.resolve(this.basePath, relative);
    // Cegah path traversal
    if (!full.startsWith(path.resolve(this.basePath) + path.sep)) {
      throw new Error('Invalid file key: path traversal detected');
    }
    return full;
  }

  async saveFile(fileKey: string, buffer: Buffer): Promise<void> {
    const fullPath = this.resolvePath(fileKey);
    await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.promises.writeFile(fullPath, buffer);
  }

  async fileExists(fileKey: string): Promise<boolean> {
    try {
      const stat = await fs.promises.stat(this.resolvePath(fileKey));
      return stat.isFile();
    } catch (e) {
      // Batch 1A (ST-020): bedakan "tidak ada" vs "disk error". Sebelumnya
      // SEMUA error ditelan sebagai false — insiden disk tidak terdeteksi.
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
      this.logger.error(`fileExists disk error for key=${fileKey}: ${(e as Error).message}`);
      throw e;
    }
  }

  async getFileSize(fileKey: string): Promise<number | null> {
    try {
      const stat = await fs.promises.stat(this.resolvePath(fileKey));
      return stat.isFile() ? stat.size : null;
    } catch (e) {
      // Batch 1A (ST-020): lihat fileExists — ENOENT → null, error lain → throw.
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      this.logger.error(`getFileSize disk error for key=${fileKey}: ${(e as Error).message}`);
      throw e;
    }
  }

  async readFileRange(fileKey: string, start: number, end: number): Promise<Buffer> {
    const fullPath = this.resolvePath(fileKey);
    const fd = await fs.promises.open(fullPath, 'r');
    try {
      const len = end - start + 1;
      const buf = Buffer.alloc(len);
      await fd.read(buf, 0, len, start);
      return buf;
    } finally {
      await fd.close();
    }
  }

  /** Stream file untuk hashing tanpa buffer penuh di memori. */
  createReadStream(fileKey: string): fs.ReadStream {
    return fs.createReadStream(this.resolvePath(fileKey));
  }

  async deleteFile(fileKey: string): Promise<boolean> {
    try {
      await fs.promises.unlink(this.resolvePath(fileKey));
      return true;
    } catch {
      return false;
    }
  }

  /** URL publik untuk fileKey. */
  getPublicUrl(fileKey: string): string {
    const relative = fileKey.startsWith('uploads/') ? fileKey.slice('uploads/'.length) : fileKey;
    return `${this.publicBaseUrl}/${relative}`;
  }

  // Batch 1A: content-type untuk endpoint download terautentikasi.
  // Dipetakan dari ekstensi nama file (key sudah disanitasi saat upload).
  getContentType(fileKey: string): string {
    const ext = fileKey.split('.').pop()?.toLowerCase() ?? '';
    const map: Record<string, string> = {
      jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
      heic: 'image/heic', heif: 'image/heif', avif: 'image/avif',
      pdf: 'application/pdf',
      mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
      mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
      json: 'application/json',
    };
    return map[ext] ?? 'application/octet-stream';
  }
}
