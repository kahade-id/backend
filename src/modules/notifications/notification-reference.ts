/**
 * SYS-C-402 (audit sistemik ronde 3, 2026-10-03) — kontrak kanonis
 * NotificationReference untuk SEMUA notifikasi lintas modul.
 *
 * - `refType`: nama entitas yang dirujuk (mis. 'ShowcaseReport',
 *   'UserShowcase', 'Order', 'Dispute', 'ChatRoom').
 * - `refId`: ID ENTITAS yang dirujuk — WAJIB id entitas itu sendiri,
 *   BUKAN userId pelapor/pemilik/penerima.
 *
 * Insiden yang diperbaiki: admin-showcase-reports mengisi refId dengan
 * reporterId (pelapor) dan ownerId (pemilik item) — deep-link klien
 * jatuh ke layar yang salah. Kontrak ini + test mengunci semantiknya.
 */
export interface NotificationReference {
  refType: string;
  refId: string;
}

/**
 * Validasi fail-closed sebuah NotificationReference: kedua field wajib
 * string non-kosong. Dipakai sebelum persist/emit notifikasi.
 */
export function assertValidNotificationReference(
  ref: NotificationReference,
): asserts ref is NotificationReference {
  if (!ref || typeof ref.refType !== 'string' || ref.refType.trim() === '') {
    throw new Error('NOTIFICATION_REF_INVALID: refType wajib string non-kosong');
  }
  if (typeof ref.refId !== 'string' || ref.refId.trim() === '') {
    throw new Error('NOTIFICATION_REF_INVALID: refId wajib string non-kosong');
  }
}
