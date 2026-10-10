/**
 * K8 (audit transaksi 2026-10-10) — feature-flag per cron job.
 *
 * `CRON_DISABLED_JOBS` = daftar nama job (sesuai `name` di `@Cron(...)`),
 * dipisah koma; `*` mematikan semua job yang memakai gate ini. Dipakai untuk
 * mematikan cepat job yang bermasalah (mis. hot loop) tanpa deploy ulang —
 * cukup ubah env + restart proses.
 *
 * Contoh: `CRON_DISABLED_JOBS=auto-complete-orders,returns-seller-sla`
 */
export function isCronJobDisabled(jobName: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.CRON_DISABLED_JOBS;
  if (!raw) return false;
  const entries = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return entries.some((entry) => entry === '*' || entry === jobName);
}
