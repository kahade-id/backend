/**
 * Klasifikasi kegagalan penyimpanan (disk/server) untuk upload.
 *
 * Bug #2 (2026-10-07): kegagalan tingkat penyimpanan — disk penuh (ENOSPC),
 * kuota terlampaui (EDQUOT), filesystem read-only (EROFS), descriptor habis
 * (EMFILE), atau izin (EACCES) — dulu diperlakukan sama seperti kegagalan
 * validasi klien (HTTP 400 `UPLOAD_FAILED`) atau, di jalur chunked, lolos
 * sebagai error tak tertangani. Akibatnya:
 *   - monitoring tidak bisa membedakan "user salah unggah" dari "disk server
 *     penuh" (tidak ada sinyal 5xx untuk alert),
 *   - klien mengulang-ulang upload yang pasti gagal,
 *   - dan pada `complete` chunked, error pada write-stream saat merakit file
 *     100 MiB tidak punya listener → unhandled 'error' event (proses bisa mati).
 *
 * Helper ini hanya memetakan errno → metadata untuk LOG + pemilihan respons;
 * perilaku sukses tidak berubah.
 */
export interface StorageErrorInfo {
  /** errno Node (mis. ENOSPC) atau null bila bukan error filesystem. */
  errno: string | null;
  /** true bila penyimpanan kehabisan kapasitas / tidak bisa ditulis sama sekali. */
  capacity: boolean;
  /** true bila penyimpanan sedang tidak bisa dipakai (server-side, retryable). */
  unavailable: boolean;
}

/** errno yang berarti kapasitas/kuota penyimpanan habis. */
const CAPACITY_ERRNOS = new Set(['ENOSPC', 'EDQUOT']);
/** errno yang berarti penyimpanan tidak bisa dipakai (bukan salah user). */
const UNAVAILABLE_ERRNOS = new Set(['EROFS', 'EMFILE', 'ENFILE', 'EIO', 'EACCES', 'EPERM', 'ENOTDIR', 'EBUSY']);

export function describeStorageError(error: unknown): StorageErrorInfo {
  const errno = (error as NodeJS.ErrnoException)?.code ?? null;
  const capacity = errno !== null && CAPACITY_ERRNOS.has(errno);
  return {
    errno,
    capacity,
    unavailable: capacity || (errno !== null && UNAVAILABLE_ERRNOS.has(errno)),
  };
}

/** Pesan user-facing untuk kegagalan penyimpanan server-side (Indonesia). */
export const STORAGE_UNAVAILABLE_MESSAGE =
  'Penyimpanan server sedang bermasalah atau penuh. File Anda tidak tersimpan — silakan coba lagi beberapa saat lagi.';

/** Direktori storage default bila env tidak diset. */
export const DEFAULT_STORAGE_DIR = '/var/www/kahade-storage';

/**
 * Direktori penyimpanan upload yang SEDANG dipakai aplikasi
 * (`src/config/app.config.ts`: `STORAGE_PATH || '/var/www/kahade-storage'`).
 *
 * Bug #2: dipakai bersama oleh probe sintetis (`/v1/health/synthetic`) dan
 * indikator disk `/v1/health` supaya KEDUANYA memeriksa volume yang sama
 * dengan tempat upload ditulis — bukan `/` atau `UPLOAD_DIR` yang bisa
 * menunjuk filesystem berbeda (disk penuh di volume storage dulu tidak
 * terdeteksi sama sekali). `UPLOAD_DIR` dihormati sebagai override
 * operasional.
 */
export function resolveStorageDir(): string {
  return process.env.STORAGE_PATH || process.env.UPLOAD_DIR || DEFAULT_STORAGE_DIR;
}
