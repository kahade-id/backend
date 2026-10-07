/**
 * Bug #2 — kontrak antara nginx dan aplikasi untuk batas badan request upload.
 *
 * Insiden "video showcase menggantung / 413 tanpa penjelasan" terjadi karena
 * `client_max_body_size` nginx (1m) jauh di bawah batas yang divalidasi
 * aplikasi (video 100 MiB, chunk 8 MiB, guard multer 104 MiB, lampiran chat
 * 50 MiB): request ditolak nginx sebelum sampai ke kode aplikasi.
 *
 * Test ini membaca KEDUA config nginx (compose + deploy) dan menegakkan
 * invarian:
 *   - route upload punya badan besar ≥ guard aplikasi + margin;
 *   - `proxy_request_buffering off` (jangan tulis ~100 MiB ke disk nginx);
 *   - timeout jalur upload cukup untuk rakit + ffprobe + ffmpeg;
 *   - default server tetap ketat (1m) supaya route JSON lain tidak ikut longgar;
 *   - guard multer SELALU < batas nginx (413 terstruktur dari aplikasi, bukan
 *     halaman HTML nginx).
 */
import {
  loadNginxConfigs,
  parseSizeToBytes,
  parseTimeToSeconds,
  findLocationBlock,
  directiveValue,
} from './nginx-config-test.utils';
import {
  CHAT_ATTACHMENT_MAX_BYTES,
  SHOWCASE_VIDEO_MAX_BYTES,
  UPLOAD_DIRECT_MULTER_MAX_BYTES,
} from '../../../common/constants/app.constants';

const CONFIGS = loadNginxConfigs();

describe.each(CONFIGS)('Bug #2 — batas upload nginx ($rel)', ({ content }) => {
  it('route /v1/upload/ menerima video 100 MiB + margin dan men-stream ke upstream', () => {
    const block = findLocationBlock(content, /location\s+\^?~?\s*\/v1\/upload\//);
    expect(block).not.toBeNull();

    const limitRaw = directiveValue(block!, 'client_max_body_size');
    expect(limitRaw).not.toBeNull();
    const limit = parseSizeToBytes(limitRaw!);
    // Harus ≥ batas video (100 MiB) dan ≥ guard multer (104 MiB).
    expect(limit).toBeGreaterThanOrEqual(SHOWCASE_VIDEO_MAX_BYTES);
    expect(limit).toBeGreaterThan(UPLOAD_DIRECT_MULTER_MAX_BYTES);
    // Dan TIDAK berlebihan (≤2× guard multer) supaya nginx tetap jadi backstop.
    expect(limit).toBeLessThanOrEqual(UPLOAD_DIRECT_MULTER_MAX_BYTES * 2);

    expect(directiveValue(block!, 'proxy_request_buffering')).toBe('off');
  });

  it('route /v1/upload/ punya timeout yang menutupi rakit + ffprobe + ffmpeg', () => {
    const block = findLocationBlock(content, /location\s+\^?~?\s*\/v1\/upload\//)!;
    // 30s (ffprobe) + 60s (ffmpeg) + waktu rakit/antrean → minimal 120s.
    expect(parseTimeToSeconds(directiveValue(block, 'proxy_read_timeout')!)).toBeGreaterThanOrEqual(120);
    expect(parseTimeToSeconds(directiveValue(block, 'proxy_send_timeout')!)).toBeGreaterThanOrEqual(120);
  });

  it('route unggah lampiran chat menerima 50 MiB (bukan 1m server-wide)', () => {
    const block = findLocationBlock(content, /location\s+[~^]*[^\n]*chat\/rooms\/[^\n]*upload/);
    expect(block).not.toBeNull();
    const limit = parseSizeToBytes(directiveValue(block!, 'client_max_body_size')!);
    expect(limit).toBeGreaterThan(CHAT_ATTACHMENT_MAX_BYTES);
    expect(directiveValue(block!, 'proxy_request_buffering')).toBe('off');
  });

  it('default server tetap ketat (1m) — hanya jalur upload yang longgar', () => {
    const serverLevel = content.match(/^\s*client_max_body_size\s+([^;]+);/m);
    expect(serverLevel).not.toBeNull();
    expect(parseSizeToBytes(serverLevel![1])).toBe(1024 * 1024);
  });

  it('guard multer & aplikasi SELALU di bawah batas nginx (413 terstruktur, bukan HTML nginx)', () => {
    // Invarian ini yang dulu dilanggar: "105M" = 105.000.000 B < 104 MiB = 109.051.904 B.
    const block = findLocationBlock(content, /location\s+\^?~?\s*\/v1\/upload\//)!;
    const nginxLimit = parseSizeToBytes(directiveValue(block, 'client_max_body_size')!);
    expect(UPLOAD_DIRECT_MULTER_MAX_BYTES).toBeLessThan(nginxLimit);
    expect(SHOWCASE_VIDEO_MAX_BYTES).toBeLessThan(nginxLimit);

    const chatBlock = findLocationBlock(content, /location\s+[~^]*[^\n]*chat\/rooms\/[^\n]*upload/)!;
    expect(CHAT_ATTACHMENT_MAX_BYTES).toBeLessThan(parseSizeToBytes(directiveValue(chatBlock, 'client_max_body_size')!));
  });
});
