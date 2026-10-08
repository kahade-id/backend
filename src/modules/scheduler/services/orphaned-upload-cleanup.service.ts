import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../../redis/redis.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { ensureRedisAvailable } from '../../../common/utils/redis-health.util';
import { formatWIBDate } from '../../../common/utils/date.util';
import { safeErrorMessage, startLockRenewal } from '../../../common/utils/background-reliability.util';
import { UPLOAD_DISK_FOLDER_NAMES } from '../../upload/upload.service';

@Injectable()
export class OrphanedUploadCleanupService {
  private readonly logger = new Logger(OrphanedUploadCleanupService.name);

  constructor(
    private redis: RedisService,
    private configService: ConfigService,
    private prisma: PrismaService,
  ) {}

  // SCH-017/SCH-028: Runs at 11:00 WIB (04:00 UTC) daily with conservative 24-hour orphan window
  @Cron('0 4 * * *', { name: 'orphaned-upload-cleanup', timeZone: 'UTC' })
  async cleanupOrphanedUploads(): Promise<void> {
    if (!(await ensureRedisAvailable(this.redis, 'orphaned-upload-cleanup'))) return;

    const today = formatWIBDate();
    const lockKey = `cron_lock:orphaned_upload_cleanup:${today}`;
    const lockToken = randomUUID();
    const lockTtlSeconds = 1800;
    const acquired = await this.redis.setNx(lockKey, lockToken, lockTtlSeconds);
    if (!acquired) return;
    const lease = startLockRenewal(this.redis, lockKey, lockToken, lockTtlSeconds, this.logger);

    this.logger.log('Starting orphaned upload cleanup...');

    try {
      let totalDeleted = 0;
      // SCH-028: Conservative orphan detection window (configurable, default 24h)
      const thresholdHours = this.configService.get<number>('app.orphanUploadThresholdHours') ?? 24;
      const cutoffMs = Date.now() - thresholdHours * 60 * 60 * 1000;

      // SECURITY: orphan-detection currently relies ONLY on a 24h Redis key
      // (`confirmed_upload:<userId>:<key>`) which is deleted on consume by
      // verifyEvidenceFileKeys/verifyEvidenceFileKeysBatch and naturally
      // expires after 24h. Files persisted into DB tables (DisputeEvidence,
      // DeliveryProof, User.kycKtpUrl/kycSelfieUrl/avatarUrl, etc.) at the
      // same `uploads/` prefix would therefore be wrongly classified as
      // orphan once their Redis key is gone. Until cleanupBucket() is updated
      // with per-table DB existence checks, the destructive delete is
      // gated behind ORPHAN_CLEANUP_ENABLED — defaulting to DRY-RUN.
      const destructiveDeleteEnabled = this.configService.get<boolean>('app.orphanCleanupEnabled') === true;
      if (!destructiveDeleteEnabled) {
        this.logger.warn('Orphan upload cleanup running in DRY-RUN mode — set ORPHAN_CLEANUP_ENABLED=true ONLY after a DB reference check is implemented in cleanupBucket().');
      }

      // Batch 1A (ST-011): pindai disk lokal untuk file yatim. Logika orphan
      // sama (Redis confirmed key 24 jam); destructive delete memakai gate
      // yang sama (ORPHAN_CLEANUP_ENABLED).
      if (lease.lost()) throw new Error('Orphaned upload cleanup lease lost');
      totalDeleted += await this.cleanupLocalDisk(cutoffMs, destructiveDeleteEnabled, lease);

      // Batch 1A (ST-019): export akun kedaluwarsa setelah 24 jam — hapus dari
      // disk agar dump PII tidak menumpuk.
      if (lease.lost()) throw new Error('Orphaned upload cleanup lease lost');
      totalDeleted += await this.cleanupExpiredAccountExports();

      this.logger.log(`Orphaned upload cleanup completed: ${totalDeleted} files ${destructiveDeleteEnabled ? 'deleted' : 'WOULD-be-deleted (dry-run)'}`);
      await this.redis.setex('cron_heartbeat:orphaned_upload_cleanup', 86400, JSON.stringify({ ranAt: new Date().toISOString(), totalDeleted, dryRun: !destructiveDeleteEnabled })).catch((err: unknown) => this.logger.warn(`Failed to write orphan cleanup heartbeat: ${safeErrorMessage(err)}`));
    } catch (error) {
      const message = safeErrorMessage(error);
      this.logger.error(`Orphaned upload cleanup FAILED: ${message}`);
      await this.redis.setex('cron_alert:orphaned_upload_cleanup_failed', 3600, JSON.stringify({ failedAt: new Date().toISOString(), error: message })).catch((alertError: unknown) => this.logger.warn(`Failed to write orphan cleanup failure alert: ${safeErrorMessage(alertError)}`));
      throw error;
    } finally {
      lease.stop();
      await this.redis.releaseLock(lockKey, lockToken).catch((err) => this.logger.warn(`silent-catch: ${safeErrorMessage(err)}`));
    }
  }

  private async walkLocalFiles(dir: string, out: string[]): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await this.walkLocalFiles(full, out);
      else if (e.isFile()) out.push(full);
    }
  }

  private async cleanupLocalDisk(cutoffMs: number, destructiveDeleteEnabled: boolean, lease: { lost(): boolean }): Promise<number> {
    const storagePath = this.configService.get<string>('app.storagePath') || '/var/www/kahade-storage';
    // UPI-02: layout nyata TIDAK punya direktori `uploads/` — prefix itu
    // di-strip oleh LocalStorageService.resolvePath saat simpan. Pindai
    // storage root langsung.
    const files: string[] = [];
    await this.walkLocalFiles(storagePath, files);

    // UPI-02: avatar/header TIDAK punya confirmed-key Redis (alur direct
    // mem-publish langsung ke DB), jadi tidak boleh dinilai via Redis.
    // Kumpulkan kandidatnya untuk verifikasi DB batch di bawah — file yang
    // masih dirujuk user.avatarUrl/headerUrl bukan orphan.
    const profileMedia: { full: string; folder: string; userId: string; fileName: string }[] = [];

    let orphanCount = 0;
    let deleted = 0;
    for (const full of files) {
      if (lease.lost()) throw new Error('Orphaned upload cleanup lease lost');
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(full);
      } catch {
        continue;
      }
      if (stat.mtimeMs > cutoffMs) continue;
      const rel = path.relative(storagePath, full).split(path.sep).join('/');
      // UPI-01: ekspor akun/admin ditangani janitor khusus — jangan sentuh di sini.
      if (rel.startsWith('account-exports/') || rel.startsWith('admin-exports/')) continue;
      // UPI-02: hanya folder upload yang dikenal — jangan sentuh `.chunks`
      // (sweep chunked-upload), `smoke-test`, atau direktori tak dikenal.
      const parts = rel.split('/');
      if (parts.length !== 3 || !UPLOAD_DISK_FOLDER_NAMES.has(parts[0])) continue;
      const folder = parts[0];
      const userId = parts[1];
      const fileName = parts[2];

      // Story media is retained by Story/StoryHighlight references and pruned
      // by the story-retention job; the generic Redis-key orphan janitor must
      // never delete it after confirmed_upload expires.
      if (folder === 'story-media' || folder === 'story-highlights') continue;

      if (folder === 'avatars' || folder === 'headers') {
        profileMedia.push({ full, folder, userId, fileName });
        continue;
      }

      // fileKey bentuk kanonis: uploads/<folder>/<userId>/<file>
      const fileKey = `uploads/${rel}`;
      let isConfirmed = false;
      try {
        isConfirmed = (await this.redis.get(`confirmed_upload:${userId}:${fileKey}`, { throwOnError: true })) !== null;
      } catch {
        this.logger.error('Redis became unavailable during local cleanup — aborting to prevent deleting confirmed files');
        return deleted;
      }
      if (isConfirmed) continue;
      orphanCount++;
      if (!destructiveDeleteEnabled) continue;
      try {
        await fs.promises.unlink(full);
        deleted++;
      } catch (err) {
        this.logger.warn(`Failed to delete orphaned local file ${rel}: ${safeErrorMessage(err)}`);
      }
    }

    // UPI-02: verifikasi avatar/header terhadap DB (satu query batch) —
    // yang masih live bukan orphan dan TIDAK boleh dihapus.
    if (profileMedia.length > 0) {
      const userIds = [...new Set(profileMedia.map((c) => c.userId))];
      const liveFiles = new Set<string>();
      let dbOk = false;
      try {
        const users = await this.prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, avatarUrl: true, headerUrl: true },
        });
        for (const u of users) {
          for (const url of [u.avatarUrl, u.headerUrl]) {
            if (!url) continue;
            const name = url.split('/').pop();
            if (name) liveFiles.add(`${u.id}/${name}`);
          }
        }
        dbOk = true;
      } catch (err) {
        // Fail-closed: tanpa verifikasi DB, jangan sentuh avatar/header —
        // salah hapus berarti avatar user hilang.
        this.logger.error(`DB unavailable during profile-media orphan check — skipping ${profileMedia.length} candidate(s) to avoid deleting live avatars/headers: ${safeErrorMessage(err)}`);
      }
      if (dbOk) {
        for (const c of profileMedia) {
          if (lease.lost()) throw new Error('Orphaned upload cleanup lease lost');
          if (liveFiles.has(`${c.userId}/${c.fileName}`)) continue;
          orphanCount++;
          if (!destructiveDeleteEnabled) continue;
          try {
            await fs.promises.unlink(c.full);
            deleted++;
          } catch (err) {
            this.logger.warn(`Failed to delete orphaned profile media ${c.folder}/${c.userId}/${c.fileName}: ${safeErrorMessage(err)}`);
          }
        }
      }
    }

    if (orphanCount > 0 && !destructiveDeleteEnabled) {
      this.logger.warn(`DRY-RUN (local disk): ${orphanCount} orphan candidate(s) under ${storagePath} older than cutoff; set ORPHAN_CLEANUP_ENABLED=true to delete`);
    } else if (deleted > 0) {
      this.logger.log(`Deleted ${deleted} orphaned files from local disk`);
    }
    // Samakan konvensi hitungan dengan pass sebelumnya (dry-run ikut dihitung).
    return destructiveDeleteEnabled ? deleted : orphanCount;
  }

  // Batch 1A (ST-019): export akun (dump PII) kedaluwarsa 24 jam setelah dibuat.
  // UPI-01: path janitor SALAH sebelumnya (`<storage>/uploads/account-exports`
  // tidak ada — prefix `uploads/` di-strip oleh LocalStorageService.resolvePath
  // saat simpan, jadi file nyata ada di `<storage>/account-exports/`).
  // Sekaligus mencakup `admin-exports/` (CSV berisi PII, sebelumnya tidak
  // punya janitor sama sekali).
  private async cleanupExpiredAccountExports(): Promise<number> {
    const storagePath = this.configService.get<string>('app.storagePath') || '/var/www/kahade-storage';
    // TTL per direktori: ekspor akun 24 jam (ST-019); ekspor admin 2 jam
    // (AdminUsersService.EXPORT_JOB_TTL_SECONDS) — keduanya berisi PII.
    const exportDirs = [
      { dir: path.join(storagePath, 'account-exports'), ttlMs: 24 * 60 * 60 * 1000 },
      { dir: path.join(storagePath, 'admin-exports'), ttlMs: 2 * 60 * 60 * 1000 },
    ];
    let deleted = 0;
    for (const { dir, ttlMs } of exportDirs) {
      const files: string[] = [];
      await this.walkLocalFiles(dir, files);
      const cutoffMs = Date.now() - ttlMs;
      for (const full of files) {
        try {
          const stat = await fs.promises.stat(full);
          if (stat.mtimeMs > cutoffMs) continue;
          await fs.promises.unlink(full);
          deleted++;
        } catch {
          // File hilang di tengah jalan — abaikan.
        }
      }
    }
    if (deleted > 0) this.logger.log(`Deleted ${deleted} expired account/admin export file(s)`);
    return deleted;
  }
}
