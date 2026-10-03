import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { JobApplicationStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { UploadService } from '../upload/upload.service';
import { CV_PENDING_TTL_MS } from './careers.service';

/** Retensi UU PDP: lamaran DITOLAK dihapus otomatis >90 hari setelah keputusan. */
const RETENTION_DAYS = 90;

/**
 * Cron karir:
 * 1. `careers-retention` (03:00 UTC harian): hard delete lamaran DITOLAK yang
 *    `updatedAt` > 90 hari — data DB (cascade: history) + file CV di storage.
 *    DITERIMA tidak dihapus otomatis (arsip HR); BARU/DIREVIEW/WAWANCARA basi
 *    tidak auto-hapus (badge "basi" di admin — keputusan spec Q4).
 * 2. `career-cv-pending-cleanup` (tiap 15 menit): hapus file di folder
 *    `career-cvs/` yang berumur >1 jam dan TIDAK dirujuk `JobApplication`
 *    manapun (upload CV yang tidak jadi di-submit / submit yang gagal).
 */
@Injectable()
export class CareersRetentionService {
  private readonly logger = new Logger(CareersRetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly uploadService: UploadService,
    private readonly configService: ConfigService,
  ) {}

  @Cron('0 3 * * *', { name: 'careers-retention', timeZone: 'UTC' })
  async purgeRejectedApplications(): Promise<{ deleted: number }> {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const stale = await this.prisma.jobApplication.findMany({
      where: { status: JobApplicationStatus.DITOLAK, updatedAt: { lt: cutoff } },
      select: { id: true, cvFileKey: true },
    });

    let deleted = 0;
    for (const app of stale) {
      try {
        // Best-effort: file dulu, baru baris DB (cascade hapus history).
        await this.uploadService.deleteStoredFile(app.cvFileKey);
        await this.prisma.jobApplication.delete({ where: { id: app.id } });
        deleted++;
      } catch (err) {
        this.logger.error(
          `careers-retention: gagal hapus lamaran ${app.id}`,
          err instanceof Error ? err.stack : err,
        );
      }
    }
    this.logger.log(
      `careers-retention: ${deleted}/${stale.length} lamaran DITOLAK >${RETENTION_DAYS} hari dihapus (data + file CV).`,
    );
    return { deleted };
  }

  @Cron('*/15 * * * *', { name: 'career-cv-pending-cleanup', timeZone: 'UTC' })
  async cleanupPendingCvs(): Promise<{ deleted: number }> {
    const basePath = this.configService.get<string>('app.storagePath') || '/var/www/kahade-storage';
    const dir = path.join(basePath, 'career-cvs');
    if (!fs.existsSync(dir)) return { deleted: 0 };

    const referenced = new Set(
      (await this.prisma.jobApplication.findMany({ select: { cvFileKey: true } })).map(
        (r) => r.cvFileKey,
      ),
    );

    const cutoffMs = Date.now() - CV_PENDING_TTL_MS;
    let deleted = 0;
    for (const fileKey of this.listFileKeys(dir)) {
      if (referenced.has(fileKey)) continue;
      const fullPath = path.join(basePath, fileKey.replace(/^uploads\//, ''));
      let mtime = 0;
      try {
        mtime = fs.statSync(fullPath).mtimeMs;
      } catch {
        continue;
      }
      if (mtime < cutoffMs) {
        // deleteStoredFile memvalidasi bentuk key (anti traversal) — best-effort.
        const ok = await this.uploadService.deleteStoredFile(fileKey);
        if (ok) deleted++;
      }
    }
    if (deleted > 0) {
      this.logger.log(`career-cv-pending-cleanup: ${deleted} file CV pending >1 jam dihapus.`);
    }
    return { deleted };
  }

  /** Daftar fileKey `uploads/career-cvs/...` untuk semua file di bawah dir. */
  private listFileKeys(dir: string): string[] {
    const out: string[] = [];
    const walk = (current: string, rel: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const relPath = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(current, e.name), relPath);
        else if (e.isFile()) out.push(`uploads/career-cvs/${relPath}`);
      }
    };
    walk(dir, '');
    return out;
  }
}
