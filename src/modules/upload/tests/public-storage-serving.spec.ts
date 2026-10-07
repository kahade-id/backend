/**
 * Bug #2 — berkas storage yang PUBLIK harus benar-benar bisa diakses klien.
 *
 * Dua kegagalan nyata yang dijaga di sini:
 *  1. `deploy/nginx.conf` (produksi) TIDAK punya lokasi untuk
 *     `uploads/showcase-videos/`, padahal `upload.service.ts`
 *     mengklasifikasikannya PUBLIK (`PUBLIC_FOLDER_PREFIXES`) dan mengembalikan
 *     URL publik `<STORAGE_PUBLIC_URL>/showcase-videos/...`. Akibatnya video
 *     showcase 404 tepat setelah upload selesai — "video gagal dimuat"
 *     (persis keluhan Bug #2), meski pipeline ffmpeg sukses.
 *     `nginx/nginx.conf` (compose) bahkan tidak menyerve `/uploads/` sama
 *     sekali → semua avatar/gambar publik 404.
 *  2. `docker-compose.yml` menjalankan service `api` dengan `read_only: true`
 *     TANPA volume writable untuk storage → setiap upload gagal `EROFS`
 *     (`503 UPLOAD_STORAGE_UNAVAILABLE`), ffmpeg tidak bisa menulis thumbnail,
 *     dan `ffprobe`/`ffmpeg` menyentuh disk yang sama.
 *
 * Invarian (dijaga terhadap kode aplikasi, bukan daftar hardcode):
 *  - lokasi `/uploads/<folder>/` di KEDUA config nginx == PUBLIC_FOLDER_PREFIXES;
 *  - TIDAK ADA folder privat (chat-attachments/, kyc-…/, dispute-evidence/, …)
 *    yang punya alias statis — file privat hanya lewat signed URL;
 *  - catch-all `^~ /uploads/` mengembalikan 404;
 *  - path alias nginx == path mount volume compose == `resolveStorageDir()`
 *    (default aplikasi), jadi tidak ada config yang menunjuk volume berbeda;
 *  - service `api` (read_only) punya volume di path storage & `STORAGE_PATH`
 *    yang konsisten; service `nginx` me-mount volume yang sama (read-only).
 */
import * as fs from 'fs';

import {
  PUBLIC_FOLDER_PREFIXES,
  UPLOAD_DISK_FOLDER_NAMES,
} from '../upload.service';
import { DEFAULT_STORAGE_DIR, resolveStorageDir } from '../../../common/utils/storage-error.util';
import {
  findLocationBlock,
  directiveValue,
  loadNginxConfigs,
  readRepoFile,
  uploadsPrefixLocations,
} from './nginx-config-test.utils';

const STORAGE_ROOT = DEFAULT_STORAGE_DIR;
const COMPOSE = readRepoFile('docker-compose.yml');

/** `uploads/showcase-videos/` → `showcase-videos`. */
const PUBLIC_FOLDERS = PUBLIC_FOLDER_PREFIXES.map((p) => p.replace(/^uploads\//, '').replace(/\/$/, ''));

/**
 * Folder PRIVAT = semua folder upload yang dikenal aplikasi dikurangi yang
 * publik, plus direktori internal yang tidak pernah boleh diserve:
 * ekspor akun/admin dan staging chunked.
 */
const PRIVATE_FOLDERS = [
  ...Array.from(UPLOAD_DISK_FOLDER_NAMES).filter((f) => !PUBLIC_FOLDERS.includes(f)),
  'account-exports',
  'admin-exports',
  '.chunks',
];

/** Ekstrak blok satu service compose (mapping 2 spasi) — tanpa dependensi YAML. */
function composeServiceBlock(content: string, service: string): string {
  const lines = content.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^  ${service}:\\s*$`).test(l));
  if (start === -1) throw new Error(`Service compose "${service}" tidak ditemukan`);
  const collected: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    // Blok service berakhir di baris berikutnya yang indentasinya ≤ 2 spasi
    // dan bukan baris kosong/komentar.
    if (/^ {0,2}\S/.test(lines[i])) break;
    collected.push(lines[i]);
  }
  return collected.join('\n');
}

describe('storage publik: nginx ↔ compose ↔ aplikasi', () => {
  // Env storage tidak boleh bocor dari lingkungan test runner.
  const savedEnv = { STORAGE_PATH: process.env.STORAGE_PATH, UPLOAD_DIR: process.env.UPLOAD_DIR };
  beforeAll(() => {
    delete process.env.STORAGE_PATH;
    delete process.env.UPLOAD_DIR;
  });
  afterAll(() => {
    if (savedEnv.STORAGE_PATH !== undefined) process.env.STORAGE_PATH = savedEnv.STORAGE_PATH;
    if (savedEnv.UPLOAD_DIR !== undefined) process.env.UPLOAD_DIR = savedEnv.UPLOAD_DIR;
  });

  it('default direktori storage aplikasi dipakai bersama oleh nginx & compose', () => {
    expect(resolveStorageDir()).toBe(STORAGE_ROOT);
    expect(STORAGE_ROOT).toBe('/var/www/kahade-storage');
  });

  describe.each(loadNginxConfigs())('$rel', ({ rel, content }) => {
    it('menyerve SETIAP prefix publik aplikasi, tidak kurang dan tidak lebih', () => {
      const served = uploadsPrefixLocations(content);
      expect([...served.keys()].sort()).toEqual([...PUBLIC_FOLDERS].sort());
    });

    it('setiap alias menunjuk ke volume storage yang sama dengan aplikasi', () => {
      for (const [folder, alias] of uploadsPrefixLocations(content)) {
        expect(alias).toBe(`${STORAGE_ROOT}/${folder}/`);
      }
    });

    it('TIDAK menyerve folder privat mana pun secara statis', () => {
      const served = [...uploadsPrefixLocations(content).keys()];
      for (const folder of PRIVATE_FOLDERS) {
        expect(served).not.toContain(folder);
      }
      // Tidak ada alias mentah ke subfolder privat (menangkap bentuk penulisan
      // lain yang tidak lewat `location ^~ /uploads/<folder>/`).
      for (const folder of PRIVATE_FOLDERS) {
        expect(content).not.toMatch(new RegExp(`alias\\s+\\S*/${folder.replace('.', '\\.')}/`));
      }
    });

    it('prefix privat / tak dikenal ditolak 404 (bukan diserve)', () => {
      const block = findLocationBlock(content, /location\s+\^~\s+\/uploads\/\s*\{/);
      expect(block).not.toBeNull();
      expect(directiveValue(block!, 'return')).toBe('404');
    });

    it('video showcase dikirim efisien (berkas sampai 100 MiB)', () => {
      const block = findLocationBlock(content, /location\s+\^~\s+\/uploads\/showcase-videos\//);
      expect(block).not.toBeNull();
      expect(directiveValue(block!, 'sendfile')).toBe('on');
    });

    it('config valid secara struktur (kurung seimbang, alias diakhiri "/")', () => {
      const opens = (content.match(/{/g) ?? []).length;
      const closes = (content.match(/}/g) ?? []).length;
      expect(opens).toBe(closes);
      const aliases = content.match(/^\s*alias\s+([^;]+);/gm) ?? [];
      expect(aliases.length).toBeGreaterThan(0);
      for (const line of aliases) {
        expect(line.trim()).toMatch(/\/;$/);
      }
    });

    it('direktif storage/serve ditulis lengkap dengan ";" (proksi untuk nginx -t)', () => {
      // Sandbox CI tidak punya biner nginx, jadi ini pengganti terdekat untuk
      // error sintaks paling umum (direktif tanpa ";" → reload nginx gagal).
      // Dibatasi ke direktif yang dipakai blok storage agar tidak salah
      // menandai direktif multi-baris (mis. `log_format` yang dipecah kutip).
      const mustTerminate = [
        'alias',
        'sendfile',
        'tcp_nopush',
        'expires',
        'add_header',
        'client_max_body_size',
        'proxy_request_buffering',
        'proxy_read_timeout',
        'proxy_send_timeout',
        'proxy_pass',
        'return',
      ];
      const offenders: string[] = [];
      content.split('\n').forEach((line, index) => {
        const code = line.replace(/#.*$/, '').trim();
        if (!code || code.endsWith(';') || code.endsWith('{') || code.endsWith('}')) return;
        for (const directive of mustTerminate) {
          if (new RegExp(`^${directive}\\b`).test(code)) {
            offenders.push(`${rel}:${index + 1} → ${code}`);
          }
        }
      });
      expect(offenders).toEqual([]);
    });
  });

  describe('docker-compose.yml', () => {
    const api = composeServiceBlock(COMPOSE, 'api');
    const nginx = composeServiceBlock(COMPOSE, 'nginx');

    it('service api read_only WAJIB punya volume writable di path storage', () => {
      // Premis: kalau read_only dimatikan, invarian volume ini tidak lagi wajib.
      expect(api).toMatch(/read_only:\s*true/);
      expect(api).toContain(`storage_data:${STORAGE_ROOT}`);
      // Dilarang read-only untuk penulis berkas.
      expect(api).not.toContain(`storage_data:${STORAGE_ROOT}:ro`);
    });

    it('service api memakai STORAGE_PATH yang sama dengan mount point-nya', () => {
      const match = /STORAGE_PATH:\s*(\S+)/.exec(api);
      expect(match).not.toBeNull();
      expect(match![1]).toBe(STORAGE_ROOT);
    });

    it('service nginx me-mount volume storage yang sama (read-only)', () => {
      expect(nginx).toContain(`storage_data:${STORAGE_ROOT}:ro`);
    });

    it('progress/ffmpeg punya ruang tulis (tmpfs) tanpa membocorkan rootfs', () => {
      expect(api).toMatch(/tmpfs:/);
      expect(api).toMatch(/- \/tmp/);
    });

    it('volume storage dideklarasikan di blok volumes tingkat-atas', () => {
      const topLevel = /^volumes:\n((?: {2,}.*\n?)+)/m.exec(COMPOSE);
      expect(topLevel).not.toBeNull();
      expect(topLevel![1]).toMatch(/^ {2}storage_data:/m);
    });
  });

  it('config nginx yang diserve memang ada di repo (bukan salah path)', () => {
    for (const rel of ['nginx/nginx.conf', 'deploy/nginx.conf']) {
      expect(fs.existsSync(`${__dirname}/../../../../${rel}`)).toBe(true);
    }
  });
});
