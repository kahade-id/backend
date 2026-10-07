/**
 * Helper parsing config nginx untuk test invarian (bukan kode produksi).
 *
 * Dipakai oleh:
 *  - `nginx-upload-limits.spec.ts`  → batas badan request upload;
 *  - `public-storage-serving.spec.ts` → prefix storage yang boleh diserve
 *    publik & konsistensi path storage (nginx ↔ compose ↔ aplikasi).
 *
 * Parsing sengaja sederhana (baris + brace-aware) supaya tidak butuh
 * dependensi YAML/nginx parser dan tetap deterministik di sandbox CI.
 */
import * as fs from 'fs';
import * as path from 'path';

export const REPO_ROOT = path.resolve(__dirname, '../../../..');

export interface NginxConfig {
  rel: string;
  content: string;
}

export function loadNginxConfigs(): NginxConfig[] {
  return ['nginx/nginx.conf', 'deploy/nginx.conf'].map((rel) => ({
    rel,
    content: fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'),
  }));
}

export function readRepoFile(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

/** "115m" / "115M" → byte; "1m" → 1 MiB (nginx: m/k/g = MiB/KiB/GiB). */
export function parseSizeToBytes(raw: string): number {
  const match = /^(\d+)\s*([kmg]?)$/i.exec(raw.trim());
  if (!match) throw new Error(`Unrecognized nginx size: ${raw}`);
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const factor = unit === 'k' ? 1024 : unit === 'm' ? 1024 * 1024 : unit === 'g' ? 1024 ** 3 : 1;
  return value * factor;
}

export function parseTimeToSeconds(raw: string): number {
  const match = /^(\d+)\s*(ms|s|m|h)?$/i.exec(raw.trim());
  if (!match) throw new Error(`Unrecognized nginx time: ${raw}`);
  const value = Number(match[1]);
  const unit = (match[2] ?? 's').toLowerCase();
  if (unit === 'ms') return value / 1000;
  if (unit === 's') return value;
  if (unit === 'm') return value * 60;
  return value * 3600;
}

/**
 * Cari blok `location <pattern> { ... }` dan kembalikan isinya (brace-aware,
 * mendukung blok bersarang seperti `location ~ \.(php)$ { return 403; }`).
 */
export function findLocationBlock(content: string, pattern: RegExp): string | null {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    // Komentar tidak pernah menjadi awal blok: komentar sering MENYEBUT
    // `location ^~ /uploads/ { return 404; }` sebagai dokumentasi, dan itu
    // dulu membuat parser mengambil blok yang salah.
    if (lines[i].trimStart().startsWith('#')) continue;
    if (!pattern.test(lines[i])) continue;
    let depth = 0;
    const collected: string[] = [];
    for (let j = i; j < lines.length; j++) {
      // Kurung di dalam komentar tidak dihitung.
      const code = lines[j].replace(/#.*$/, '');
      collected.push(lines[j]);
      depth += (code.match(/{/g) ?? []).length - (code.match(/}/g) ?? []).length;
      if (depth === 0 && j > i) break;
    }
    return collected.join('\n');
  }
  return null;
}

export function directiveValue(block: string, directive: string): string | null {
  const match = new RegExp(`^\\s*${directive}\\s+([^;]+);`, 'm').exec(block);
  return match ? match[1].trim() : null;
}

/**
 * Semua lokasi `location ^~ /uploads/<folder>/` (atau bentuk prefix-lainnya)
 * beserta alias-nya. Mengembalikan Map folder → alias path.
 */
export function uploadsPrefixLocations(content: string): Map<string, string> {
  const found = new Map<string, string>();
  const regex = /^[ \t]*location\s+\^~\s+\/uploads\/([A-Za-z0-9._-]+)\//gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    const block = findLocationBlock(content.slice(match.index), /location\s+\^~\s+\/uploads\//);
    const alias = block ? directiveValue(block, 'alias') : null;
    if (!alias) throw new Error(`location /uploads/${match[1]}/ tidak punya direktif alias`);
    found.set(match[1], alias);
  }
  return found;
}
