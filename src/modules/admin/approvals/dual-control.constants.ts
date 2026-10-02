/**
 * Ambang dual control (maker-checker) untuk aksi admin pemindah dana
 * (audit 2026-10-03: SEC-501/502/601/602).
 *
 * Aksi dengan nominal DI ATAS ambang ini tidak dieksekusi langsung —
 * melainkan dibuatkan record PENDING yang baru dieksekusi setelah admin
 * KEDUA (berbeda dari pengusul) menyetujui dengan step-up-nya sendiri.
 */
export const DUAL_CONTROL_THRESHOLD_IDR = 1_000_000;
export const DUAL_CONTROL_THRESHOLD_SEN = BigInt(DUAL_CONTROL_THRESHOLD_IDR) * BigInt(100);

/** Kedaluwarsa record approval yang belum diputuskan: 24 jam. */
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * SEC-503: aksi step-up yang mengikat token untuk tiap tipe approval.
 * Token step-up yang dipakai untuk propose/approve sebuah approval HARUS
 * diterbitkan dengan action ini (POST /v1/admin/auth/step-up {action}).
 * Memakai action yang sama dengan endpoint domain-nya agar satu niat
 * ("resolve dispute X") mencakup propose maupun approve.
 */
export const APPROVAL_STEP_UP_ACTIONS: Record<string, string> = {
  DISPUTE_RESOLVE: 'dispute.resolve',
  INSURANCE_CLAIM_PAY: 'insurance.pay',
  WALLET_ADJUST: 'wallet.adjust',
  COMMERCE_REFUND: 'commerce.refund',
  DISBURSEMENT_REOPEN: 'disbursement.reopen',
  OPS_SETTING_CHANGE: 'opsSetting.update',
};
