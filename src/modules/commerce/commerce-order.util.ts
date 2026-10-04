import { DELIVERY_DEADLINE_DAYS_MIN, DELIVERY_DEADLINE_DAYS_MAX } from '../../common/constants/app.constants';

/**
 * POIN 2 (2026-10-04) — unifikasi transaksi escrow: helper bersama untuk
 * endpoint create-order commerce (jastip/patungan/service-booking).
 *
 * Menghitung `deliveryDeadlineDays` order dari sebuah tenggat domain
 * (orderDeadline trip, deadlineAt grup, slotDate jasa), di-clamp ke rentang
 * yang diterima `OrdersService.createOrder` (1–14 hari).
 */
export function clampDeadlineDays(deadline: Date): number {
  const days = Math.ceil((deadline.getTime() - Date.now()) / 86400000);
  return Math.min(DELIVERY_DEADLINE_DAYS_MAX, Math.max(DELIVERY_DEADLINE_DAYS_MIN, days));
}
