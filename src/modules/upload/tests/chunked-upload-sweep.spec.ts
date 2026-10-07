/**
 * Bug #2 — kebocoran disk `/var/www/kahade-storage/.chunks/` (storage penuh =
 * upload "menggantung"/gagal di produksi).
 *
 * Sebelumnya `sweepExpired()` melewati SELAMANYA sesi chunked yang
 * `manifest.json`-nya hilang atau rusak (`catch {}`): sesi seperti itu tidak
 * mungkin di-resume klien (init/status/complete semuanya membaca manifest),
 * jadi chunk-nya hanya menumpuk di disk tanpa batas sampai storage penuh.
 *
 * Kontrak yang diuji:
 * 1. Sesi tanpa manifest + direktori lebih tua dari TTL 24 jam → DISAPU.
 * 2. Sesi dengan manifest rusak (JSON invalid) + tua → DISAPU.
 * 3. Sesi dengan manifest kedaluwarsa → DISAPU (regresi: perilaku lama).
 * 4. Sesi tanpa manifest TAPI direktori masih segar (sedang diunggah) →
 *    TIDAK disentuh (anti-balapan dengan upload yang berjalan).
 * 5. Sesi dengan manifest masih valid → TIDAK disentuh.
 * 6. Direktori yang namanya bukan sessionId (mis. `.tmp`) → TIDAK disentuh.
 */
import { Logger } from '@nestjs/common';
import * as fs from 'fs';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { ChunkedUploadService, ChunkSessionManifest } from '../chunked-upload.service';
import { UploadService } from '../upload.service';

jest.setTimeout(30_000);

const SESSION_A = 'a'.repeat(64);
const SESSION_B = 'b'.repeat(64);
const SESSION_C = 'c'.repeat(64);
const SESSION_D = 'd'.repeat(64);
const SESSION_E = 'e'.repeat(64);
const DAY_MS = 24 * 60 * 60 * 1000;

function manifestFor(sessionId: string, expiresAt: number): ChunkSessionManifest {
  return {
    v: 1,
    sessionId,
    userId: 'cluser00000000000000001',
    purpose: 'chat-attachment' as ChunkSessionManifest['purpose'],
    fileName: 'a.jpg',
    mimeType: 'image/jpeg',
    totalSize: 12 * 1024 * 1024,
    chunkSize: 4 * 1024 * 1024,
    totalChunks: 3,
    createdAt: new Date(expiresAt - DAY_MS).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

describe('Bug #2 — chunk sweep tidak lagi membocorkan sesi tanpa manifest', () => {
  let storageRoot: string;
  let staging: string;
  let service: ChunkedUploadService;
  let logs: string[];

  /** Buat direktori sesi + (opsional) manifest/chunk, lalu tuakan mtime. */
  function makeSession(name: string, opts: { manifest?: string | null; agedDays?: number } = {}): string {
    const dir = join(staging, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, 'chunk-0'), Buffer.alloc(2048, 7));
    if (opts.manifest !== null) {
      fs.writeFileSync(
        join(dir, 'manifest.json'),
        opts.manifest ?? JSON.stringify(manifestFor(name, Date.now() + DAY_MS)),
      );
    }
    const agedDays = opts.agedDays ?? 0;
    if (agedDays > 0) {
      const past = new Date(Date.now() - agedDays * DAY_MS);
      for (const f of fs.readdirSync(dir)) fs.utimesSync(join(dir, f), past, past);
      fs.utimesSync(dir, past, past);
    }
    return dir;
  }

  function sweep(): Promise<void> {
    // sweepExpired() privat — dipanggil `void` dari init(); di sini dipanggil
    // langsung agar deterministik tanpa bergantung pada alur HTTP.
    return (service as unknown as { sweepExpired(): Promise<void> }).sweepExpired();
  }

  beforeEach(() => {
    storageRoot = mkdtempSync(join(tmpdir(), 'kahade-chunk-sweep-'));
    staging = join(storageRoot, '.chunks');
    fs.mkdirSync(staging, { recursive: true });
    const configService = { get: (key: string) => (key === 'app.storagePath' ? storageRoot : undefined) };
    service = new ChunkedUploadService(configService as never, {} as unknown as UploadService);
    logs = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((m: unknown) => void logs.push(String(m)));
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    rmSync(storageRoot, { recursive: true, force: true });
  });

  it('menyapu sesi TANPA manifest yang sudah lebih tua dari TTL 24 jam', async () => {
    const dir = makeSession(SESSION_A, { manifest: null, agedDays: 3 });

    await sweep();

    expect(fs.existsSync(dir)).toBe(false);
    expect(logs.join(' ')).toContain('tanpa manifest valid');
  });

  it('menyapu sesi dengan manifest RUSAK (JSON invalid) yang sudah tua', async () => {
    const dir = makeSession(SESSION_B, { manifest: '{ skema lama, terpotong', agedDays: 2 });

    await sweep();

    expect(fs.existsSync(dir)).toBe(false);
  });

  it('tetap menyapu sesi dengan manifest kedaluwarsa (regresi perilaku lama)', async () => {
    const dir = makeSession(SESSION_C, {
      manifest: JSON.stringify(manifestFor(SESSION_C, Date.now() - DAY_MS)),
      agedDays: 2,
    });

    await sweep();

    expect(fs.existsSync(dir)).toBe(false);
  });

  it('TIDAK menyentuh sesi tanpa manifest yang masih segar (upload berjalan)', async () => {
    const dir = makeSession(SESSION_D, { manifest: null });

    await sweep();

    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.existsSync(join(dir, 'chunk-0'))).toBe(true);
  });

  it('TIDAK menyentuh sesi dengan manifest yang belum kedaluwarsa', async () => {
    const dir = makeSession(SESSION_E);

    await sweep();

    expect(fs.existsSync(dir)).toBe(true);
  });

  it('TIDAK menyentuh direktori yang namanya bukan sessionId', async () => {
    const odd = join(staging, 'tmp');
    fs.mkdirSync(odd, { recursive: true });
    fs.writeFileSync(join(odd, 'chunk-0'), Buffer.alloc(16));
    const past = new Date(Date.now() - 5 * DAY_MS);
    fs.utimesSync(odd, past, past);

    await sweep();

    expect(fs.existsSync(odd)).toBe(true);
  });
});
