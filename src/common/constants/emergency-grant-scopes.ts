/**
 * ADM-402 — Allowlist ketat scope emergency grant (fail-closed).
 *
 * Kosakata scope yang dikenal sistem. Daftar ini adalah SATU-SATUNYA sumber kebenaran
 * untuk nilai `scope` pada emergency grant dan pada klaim `scope` token admin.
 * Sinkron dengan opsi scope di panel admin (`team/emergency-grants` → SCOPE_OPTIONS).
 *
 * SEMANTIK KEAMANAN (fail-closed):
 * 1. Scope hanya bisa MEMPERSempit, tidak pernah memperluas akses. `JwtAdminGuard`
 *    menolak path di luar prefix yang diizinkan SEBELUM `AdminRolesGuard` memeriksa
 *    role — akses efektif = irisan (role ∩ scope).
 * 2. Scope yang TIDAK dikenal → tidak ada path yang diizinkan → token ditolak di
 *    semua endpoint (403 INSUFFICIENT_TOKEN_SCOPE). Pembuatan grant dengan scope
 *    tak dikenal ditolak dengan 400.
 * 3. Record grant di database sendiri TIDAK memberi akses apa pun — ia murni catatan
 *    audit niat break-glass. Penegakan scope berlaku untuk token yang membawa klaim
 *    `scope` (diterbitkan eksplisit oleh alur penerbitan token darurat).
 * 4. Menambah scope baru = keputusan produk + perubahan kode di file ini (review).
 *    Jangan menerima scope bebas dari input user.
 *
 * Path dicocokkan sebagai prefix terhadap path ternormalisasi (tanpa prefix `/v1`,
 * tanpa trailing slash), mis. prefix `/admin/users` mencakup
 * `/admin/users/123/wallet`.
 */
export interface EmergencyGrantScopeDef {
  /** Nama scope persis seperti yang dikirim klien & disimpan di DB. */
  name: string;
  /** Label manusiawi (id-ID) untuk UI/audit. */
  label: string;
  /** Prefix path admin yang boleh diakses token ber-scope ini. */
  allowedPathPrefixes: string[];
  /** `true` → tanpa batasan path (setara token tanpa scope). */
  unrestricted?: boolean;
}

export const EMERGENCY_GRANT_SCOPES: EmergencyGrantScopeDef[] = [
  {
    name: 'USERS',
    label: 'Pengguna',
    allowedPathPrefixes: ['/admin/users'],
  },
  {
    name: 'KYC',
    label: 'KYC',
    allowedPathPrefixes: ['/admin/kyc', '/admin/business-verifications'],
  },
  {
    name: 'FINANCE',
    label: 'Keuangan',
    allowedPathPrefixes: ['/admin/finance', '/admin/milestones'],
  },
  {
    name: 'DISPUTES',
    label: 'Sengketa',
    allowedPathPrefixes: ['/admin/disputes', '/admin/returns'],
  },
  {
    name: 'ALL',
    label: 'Semua area',
    allowedPathPrefixes: [],
    unrestricted: true,
  },
];

export const EMERGENCY_GRANT_SCOPE_NAMES: string[] = EMERGENCY_GRANT_SCOPES.map((s) => s.name);

export function isKnownEmergencyGrantScope(scope: string): boolean {
  return EMERGENCY_GRANT_SCOPE_NAMES.includes(scope);
}

export function getEmergencyGrantScopeDef(scope: string): EmergencyGrantScopeDef | undefined {
  return EMERGENCY_GRANT_SCOPES.find((s) => s.name === scope);
}
