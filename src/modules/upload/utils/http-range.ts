/**
 * UPV-01 (audit upload video 2026-10-03): parse header HTTP `Range` untuk
 * download file privat (video chat/sengketa tidak diserve nginx sehingga
 * tidak mendapat 206 otomatis seperti video showcase publik).
 *
 * Hanya mendukung SATU rentang `bytes=<start>-<end>` (yang dipakai video
 * player untuk seek). Multi-range (`bytes=0-99,200-299`) DITOLAK sebagai
 * invalid → server balas 200 penuh (bukan 416), karena tidak ada consumer
 * yang membutuhkannya dan implementasi multipart/byteranges rawan salah.
 *
 * Return:
 * - `{ start, end }` (inklusif, sudah di-clamp ke ukuran file) bila valid;
 * - `'unsatisfiable'` bila rentang di luar ukuran file → caller balas 416;
 * - `null` bila tidak ada header / format tak dikenal → caller balas 200.
 */
export type ParsedHttpRange = { start: number; end: number } | 'unsatisfiable' | null;

export function parseHttpRange(rangeHeader: string | undefined, size: number): ParsedHttpRange {
  if (!rangeHeader || size <= 0) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!m) return null;
  const [, startStr, endStr] = m;
  if (startStr === '' && endStr === '') return null;

  let start: number;
  let end: number;
  if (startStr === '') {
    // Suffix range: N byte terakhir.
    const suffix = Number(endStr);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startStr);
    if (!Number.isSafeInteger(start) || start < 0) return null;
    if (start >= size) return 'unsatisfiable';
    if (endStr === '') {
      end = size - 1;
    } else {
      end = Number(endStr);
      if (!Number.isSafeInteger(end) || end < start) return null;
      end = Math.min(end, size - 1);
    }
  }
  return { start, end };
}
