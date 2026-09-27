import { sha256 } from './crypto.util';

/**
 * ADM-429 — watermark keterlacakan pada file ekspor CSV admin.
 *
 * Audit mencatat *siapa* mengekspor, tetapi file-nya sendiri tidak memuat
 * identitas pengekspor. Util ini menyisipkan baris metadata di awal CSV
 * (setelah BOM bila ada) agar kebocoran file bisa ditelusuri kembali ke
 * pengekspornya.
 *
 * Format: baris komentar `#` (diabaikan sebagian besar parser CSV):
 *   # kahade-export source=<sumber> exported_by_sha256=<16 hex> exported_at=<ISO>
 *
 * Identitas berupa hash sha256 (16 hex pertama) dari ID admin — cukup untuk
 * ditelusuri secara internal (cocokkan dengan daftar hash admin), tanpa
 * menulis ID internal mentah ke file yang bisa beredar di luar.
 */
export function buildCsvExportWatermark(exporterAdminId: string, source: string): string {
  const hash = sha256(`csv-export:${exporterAdminId}`).slice(0, 16);
  const at = new Date().toISOString();
  return `# kahade-export source=${source} exported_by_sha256=${hash} exported_at=${at}\n`;
}

/**
 * Sisipkan watermark di awal CSV. BOM (`\uFEFF`) bila ada tetap dipertahankan
 * sebagai karakter pertama agar Excel tetap mengenali encoding.
 */
export function withCsvExportWatermark(
  csv: string,
  exporterAdminId: string,
  source: string,
): string {
  const watermark = buildCsvExportWatermark(exporterAdminId, source);
  if (csv.startsWith('\uFEFF')) {
    return '\uFEFF' + watermark + csv.slice(1);
  }
  return watermark + csv;
}
