/**
 * SYS-B-405 (audit 2026-10-03 ronde 3): registry eksplisit klasifikasi
 * system config — menggantikan deteksi "finansial" via substring
 * (FINANCIAL_CONFIG_KEYS) yang bisa lolos untuk key baru.
 *
 * Setiap key diklasifikasikan sebagai:
 * - financial: perubahan memengaruhi aliran/anggaran uang (fee, kurs,
 *   ambang dual-approval, diskon) → perubahan SELALU via dual control
 *   (tabel approvals + step-up), tidak pernah apply langsung.
 * - securityGated: perubahan memengaruhi posture keamanan (mis. kewajiban
 *   MFA admin) → SELALU via dual control + step-up, dan tidak bisa
 *   dimatikan/dilonggarkan oleh satu admin.
 *
 * Fail-closed: key yang TIDAK terdaftar (termasuk pola prefix tak dikenal)
 * diperlakukan sebagai financial — perubahan key baru tak dikenal tidak
 * akan pernah apply langsung satu admin.
 */
export interface SystemConfigClassification {
  financial: boolean;
  securityGated: boolean;
  description: string;
}

const EXACT_REGISTRY: Record<string, SystemConfigClassification> = {
  // c1: kewajiban MFA seluruh admin — eskalasi total bila dimatikan.
  admin_mfa_required: {
    financial: false,
    securityGated: true,
    description: 'Kewajiban MFA TOTP seluruh admin — security-gated, tidak bisa diubah 1 admin',
  },
  // c2: dibaca fee-calculator untuk diskon fee platform per rank membership.
  membership_rank_fee_discount_bps: {
    financial: true,
    securityGated: false,
    description: 'Diskon fee platform (bps) per rank membership — money-affecting',
  },
  // c3: parameter keamanan maker-checker (ADM-205) — juga finansial karena
  // mengontrol ambang dual approval penarikan.
  'withdrawal.dual_approval_threshold_idr': {
    financial: true,
    securityGated: true,
    description: 'Ambang dual-approval withdrawal — parameter keamanan + finansial',
  },
  // c4: bookkeeping internal rekonsiliasi (ditulis service, bukan uang).
  'reconciliation.batches': {
    financial: false,
    securityGated: false,
    description: 'Snapshot internal rekonsiliasi (ditulis service)',
  },
  'reconciliation.checkpoint': {
    financial: false,
    securityGated: false,
    description: 'Checkpoint internal rekonsiliasi (ditulis service)',
  },
  // c5: key warisan dari era substring-match — didaftarkan eksplisit agar
  // cakupannya tidak menyusut dibanding aturan lama.
  fee_percentage: { financial: true, securityGated: false, description: 'Tarif fee (warisan)' },
  platform_fee: { financial: true, securityGated: false, description: 'Fee platform (warisan)' },
  commission_rate: { financial: true, securityGated: false, description: 'Tarif komisi (warisan)' },
  kahade_fee_rate: { financial: true, securityGated: false, description: 'Tarif fee Kahade (warisan)' },
  kahade_plus_fee_rate: { financial: true, securityGated: false, description: 'Tarif fee Kahade Plus (warisan)' },
  withdrawal_fee: { financial: true, securityGated: false, description: 'Fee penarikan (warisan)' },
  payment_fee: { financial: true, securityGated: false, description: 'Fee pembayaran (warisan)' },
  escrow_fee: { financial: true, securityGated: false, description: 'Fee escrow (warisan)' },
  fee_savings_limit: { financial: true, securityGated: false, description: 'Batas hemat fee (warisan)' },
  dual_approval: { financial: true, securityGated: true, description: 'Parameter dual-approval (warisan)' },
};

const PREFIX_REGISTRY: Array<{ prefix: string; classification: SystemConfigClassification }> = [
  {
    // Kurs publik per mata uang — memengaruhi konversi nilai uang.
    prefix: 'exchange_rate_',
    classification: {
      financial: true,
      securityGated: false,
      description: 'Kurs mata uang publik — money-affecting',
    },
  },
];

const FAIL_CLOSED_UNKNOWN: SystemConfigClassification = {
  financial: true,
  securityGated: false,
  description: 'Key tak terdaftar — fail-closed: diperlakukan sebagai finansial',
};

export function classifySystemConfig(key: string): SystemConfigClassification {
  const exact = EXACT_REGISTRY[key];
  if (exact) return exact;
  for (const { prefix, classification } of PREFIX_REGISTRY) {
    if (key.startsWith(prefix)) return classification;
  }
  return FAIL_CLOSED_UNKNOWN;
}
