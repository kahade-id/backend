/**
 * GAP-E (G376–G400) — kompatibilitas mundur.
 *
 * Implementasi kanonis penyamaran PII kini tinggal di
 * `src/common/maskPiiByRole.ts` agar dapat dipakai lintas modul.
 * File ini hanya me-re-export simbol lama supaya import yang sudah ada
 * tidak pecah; kode baru WAJIB import dari `common/maskPiiByRole`.
 */
export {
  maskEmail,
  maskPhone,
  applyUserMask,
  PII_UNMASKED_ROLES,
} from '../../../common/maskPiiByRole';
export type { PiiBearingUser } from '../../../common/maskPiiByRole';

/** Alias nama lama → {@link applyUserMask}. */
export { applyUserMask as maskPiiByRole } from '../../../common/maskPiiByRole';
