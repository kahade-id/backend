/**
 * Kahade — synthetic check read-only (G489 audit 2026-09-26).
 *
 * Diekspos di `GET /v1/health/synthetic` (publik, throttle ketat) supaya bisa
 * dipanggil monitoring eksternal TANPA akun nyata:
 *   - database: `SELECT 1`
 *   - redis: PING
 *   - storage: tulis → baca → hapus file temp di direktori upload lokal
 *     (bukan R2 — upload baru di disk server sejak 2026-09-26)
 *
 * Semua cek read-only / self-cleaning: tidak membuat user, order, atau
 * transaksi. File temp diberi prefix `synthetic-` + UUID dan SELALU dihapus
 * di `finally` agar tidak menumpuk bila proses mati di tengah jalan.
 */
import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { resolveStorageDir } from '../../common/utils/storage-error.util';

export type CheckStatus = 'ok' | 'down';

export interface SyntheticCheck {
  name: string;
  status: CheckStatus;
  latencyMs: number;
  detail?: string;
}

export interface SyntheticResult {
  status: 'ok' | 'degraded';
  release: string;
  at: string;
  checks: SyntheticCheck[];
}

const CHECK_TIMEOUT_MS = 5_000;

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), CHECK_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

@Injectable()
export class SyntheticService {
  private readonly logger = new Logger(SyntheticService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async run(): Promise<SyntheticResult> {
    const checks = await Promise.all([
      this.checkDatabase(),
      this.checkRedis(),
      this.checkStorage(),
    ]);
    const degraded = checks.some((c) => c.status !== 'ok');
    return {
      status: degraded ? 'degraded' : 'ok',
      release: process.env.RELEASE_SHA || process.env.APP_VERSION || 'unknown',
      at: new Date().toISOString(),
      checks,
    };
  }

  private async checkDatabase(): Promise<SyntheticCheck> {
    const started = Date.now();
    try {
      await withTimeout(this.prisma.$queryRaw`SELECT 1`, 'synthetic db');
      return { name: 'database', status: 'ok', latencyMs: Date.now() - started };
    } catch (err) {
      return {
        name: 'database', status: 'down', latencyMs: Date.now() - started,
        detail: err instanceof Error ? err.name : 'unknown',
      };
    }
  }

  private async checkRedis(): Promise<SyntheticCheck> {
    const started = Date.now();
    try {
      const pong = await withTimeout(this.redis.getClient().ping(), 'synthetic redis');
      if (pong !== 'PONG') throw new Error('Redis did not return PONG');
      return { name: 'redis', status: 'ok', latencyMs: Date.now() - started };
    } catch (err) {
      return {
        name: 'redis', status: 'down', latencyMs: Date.now() - started,
        detail: err instanceof Error ? err.name : 'unknown',
      };
    }
  }

  private async checkStorage(): Promise<SyntheticCheck> {
    const started = Date.now();
    // Bug #2 (2026-10-07): aplikasi menulis upload ke `STORAGE_PATH`
    // (app.config: `process.env.STORAGE_PATH || '/var/www/kahade-storage'`),
    // tetapi probe ini dulu memakai `UPLOAD_DIR`. Bila deploy memindahkan
    // storage ke volume lain (mis. /mnt/data), probe memeriksa direktori yang
    // SALAH dan bisa melaporkan "storage ok" padahal upload nyata gagal
    // (disk penuh/FS read-only di volume yang benar). Urutan prioritas kini
    // sama dengan aplikasi; `UPLOAD_DIR` tetap dihormati sebagai override
    // operasional.
    const dir = resolveStorageDirForProbe();
    const fileName = `synthetic-${randomUUID()}.tmp`;
    const filePath = path.join(dir, fileName);
    const payload = `synthetic-check ${new Date().toISOString()}`;
    try {
      await withTimeout(
        (async () => {
          await fs.promises.mkdir(dir, { recursive: true });
          await fs.promises.writeFile(filePath, payload, 'utf8');
          const readBack = await fs.promises.readFile(filePath, 'utf8');
          if (readBack !== payload) throw new Error('storage read-back mismatch');
        })(),
        'synthetic storage',
      );
      return { name: 'storage', status: 'ok', latencyMs: Date.now() - started, detail: `dir=${dir}` };
    } catch (err) {
      const errno = (err as NodeJS.ErrnoException)?.code;
      return {
        name: 'storage',
        status: 'down',
        latencyMs: Date.now() - started,
        // errno penting untuk insiden disk penuh (ENOSPC/EDQUOT) — nama error
        // saja ("Error") tidak memberi sinyal apa pun.
        detail: `${err instanceof Error ? err.name : 'unknown'}${errno ? ` (${errno})` : ''} dir=${dir}`,
      };
    } finally {
      await fs.promises.unlink(filePath).catch(() => undefined);
    }
  }
}

/**
 * Direktori storage untuk probe sintetis — HARUS sama dengan yang dipakai
 * aplikasi (`STORAGE_PATH`), karena itu volume tempat upload nyata ditulis.
 * Implementasi dibagi dengan indikator disk `/v1/health` (lihat
 * `common/utils/storage-error.util`).
 */
export const resolveStorageDirForProbe = resolveStorageDir;

/** Direktori storage temp default bila env tidak diset (untuk smoke test). */
export function defaultStorageDir(): string {
  return process.env.STORAGE_PATH || process.env.UPLOAD_DIR || path.join(os.tmpdir(), 'kahade-storage');
}

