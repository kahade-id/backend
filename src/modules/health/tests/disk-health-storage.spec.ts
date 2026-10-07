/**
 * Bug #2 — `/v1/health` harus memperhatikan VOLUME STORAGE, bukan hanya `/`.
 *
 * Sebelumnya `DiskHealthIndicator` memanggil `fs.statfsSync('/')` saja.
 * Di produksi upload ditulis ke `STORAGE_PATH` (`/var/www/kahade-storage`)
 * yang biasanya volume terpisah: volume storage bisa 100% penuh (semua upload
 * gagal ENOSPC) sementara `/` masih longgar → health tetap "ok", tidak ada
 * alert, dan insiden baru ketahuan dari keluhan user.
 */
import { DiskHealthIndicator } from '../health.module';

/**
 * Indikator dengan pemakaian disk yang bisa dikendalikan per-path.
 * `fs.statfsSync` tidak bisa di-spy di Node 22 (properti modul
 * non-configurable) → test memakai seam `diskUsage` yang disediakan kelas.
 */
class FakeDiskHealthIndicator extends DiskHealthIndicator {
  constructor(private readonly usedPercentByPath: Record<string, number>, private readonly fallbackPercent = 40) {
    super();
  }

  protected diskUsage(dirPath: string): { path: string; usedPercent: number; freeMb: number } {
    const usedPercent = this.usedPercentByPath[dirPath] ?? this.fallbackPercent;
    const sizeMb = 4096;
    return { path: dirPath, usedPercent, freeMb: Math.round(sizeMb * (1 - usedPercent / 100)) };
  }
}

class UnavailableDiskHealthIndicator extends DiskHealthIndicator {
  protected diskUsage(): { path: string; usedPercent: number; freeMb: number } {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }
}

describe('Bug #2 — indikator disk health memeriksa volume storage', () => {
  const ORIGINAL = { storage: process.env.STORAGE_PATH, upload: process.env.UPLOAD_DIR };

  beforeEach(() => {
    process.env.STORAGE_PATH = '/var/www/kahade-storage';
    delete process.env.UPLOAD_DIR;
  });

  afterEach(() => {
    if (ORIGINAL.storage === undefined) delete process.env.STORAGE_PATH;
    else process.env.STORAGE_PATH = ORIGINAL.storage;
    if (ORIGINAL.upload === undefined) delete process.env.UPLOAD_DIR;
    else process.env.UPLOAD_DIR = ORIGINAL.upload;
  });

  it('volume storage penuh (99%) walau / longgar (40%) → TIDAK sehat + path storage dilaporkan', async () => {
    const result = await new FakeDiskHealthIndicator({ '/var/www/kahade-storage': 99, '/': 40 }).isHealthy('disk');
    expect(result.disk.status).toBe('down');
    expect(result.disk.path).toBe('/var/www/kahade-storage');
    expect(result.disk.usedPercent).toBe(99);
    expect(result.disk.storageUsedPercent).toBe(99);
    expect(result.disk.rootUsedPercent).toBe(40);
  });

  it('root penuh (95%) walau storage longgar (20%) → tetap TIDAK sehat (perilaku lama dipertahankan)', async () => {
    const result = await new FakeDiskHealthIndicator({ '/var/www/kahade-storage': 20, '/': 95 }).isHealthy('disk');
    expect(result.disk.status).toBe('down');
    expect(result.disk.path).toBe('/');
    expect(result.disk.rootUsedPercent).toBe(95);
  });

  it('keduanya longgar → sehat + freeMb dilaporkan', async () => {
    const result = await new FakeDiskHealthIndicator({}, 35).isHealthy('disk');
    expect(result.disk.status).toBe('up');
    expect(result.disk.usedPercent).toBe(35);
    expect(typeof result.disk.freeMb).toBe('number');
  });

  it('UPLOAD_DIR dihormati bila STORAGE_PATH tidak diset (deploy lama)', async () => {
    delete process.env.STORAGE_PATH;
    process.env.UPLOAD_DIR = '/mnt/kahade-uploads';
    const result = await new FakeDiskHealthIndicator({ '/mnt/kahade-uploads': 93, '/': 10 }).isHealthy('disk');
    expect(result.disk.status).toBe('down');
    expect(result.disk.path).toBe('/mnt/kahade-uploads');
  });

  it('probe disk tidak tersedia → TIDAK sehat (bukan false-positive)', async () => {
    const result = await new UnavailableDiskHealthIndicator().isHealthy('disk');
    expect(result.disk.status).toBe('down');
    expect(result.disk.message).toBe('disk check unavailable');
  });
});
