/**
 * GAP-E (G376–G400) — penyamaran PII berbasis role admin.
 *
 * Email & nomor HP pengguna disamarkan (mask) kecuali untuk role yang
 * diizinkan secara eksplisit di {@link PII_UNMASKED_ROLES}. Dipakai oleh
 * ekspor CSV pengguna (`GET /v1/admin/users/export/csv`, default mask=true)
 * dan dapat dipakai ulang oleh endpoint admin lain yang mengekspos PII.
 *
 * Rasional allowlist:
 * - SUPER_ADMIN: satu-satunya role dengan akses penuh (tanggung jawab
 *   tertinggi, setiap akses tercatat di audit).
 * - KYC_ADMIN / DISPUTE_ADMIN / FINANCE_ADMIN / CUSTOMER_SUPPORT:
 *   disamarkan — alur verifikasi identitas memakai modul KYC tersendiri
 *   (review dokumen), bukan ekspor massal; masking di sini tidak memblokir
 *   pekerjaan mereka dan meminimalkan paparan PII.
 * Bila kebutuhan produk berubah, tambah role ke PII_UNMASKED_ROLES
 * (daftar eksplisit — jangan invert menjadi denylist).
 */

const MASK_CHAR = '•';

/**
 * Akhiran domain dua segmen yang diperlakukan sebagai satu TLD
 * (umum di Indonesia: co.id, or.id, ...). Tanpa ini, `example.co.id`
 * akan kehilangan `.co` dan menyisakan `.id` saja.
 */
const TWO_PART_TLD_SUFFIXES = [
  '.co.id', '.or.id', '.ac.id', '.go.id', '.net.id', '.web.id',
  '.my.id', '.biz.id', '.desa.id', '.co.uk', '.com.au',
];

/** Pecah domain menjadi nama domain + TLD (mendukung TLD dua segmen). */
function splitDomainTld(domain: string): { domainName: string; tld: string } {
  const lower = domain.toLowerCase();
  for (const suffix of TWO_PART_TLD_SUFFIXES) {
    if (lower.endsWith(suffix) && domain.length > suffix.length) {
      return {
        domainName: domain.slice(0, domain.length - suffix.length),
        tld: domain.slice(domain.length - suffix.length),
      };
    }
  }
  const dot = domain.lastIndexOf('.');
  if (dot > 0) return { domainName: domain.slice(0, dot), tld: domain.slice(dot) };
  return { domainName: domain, tld: '' };
}

/**
 * Role yang boleh melihat email/nomor HP tanpa penyamaran.
 * Daftar eksplisit (allowlist) — role lain SELALU dimask, termasuk
 * role yang tidak dikenal / null / undefined (fail-closed).
 */
export const PII_UNMASKED_ROLES: readonly string[] = ['SUPER_ADMIN'];

/** Samarkan email: `budi.santoso@example.co.id` → `b•@e••.co.id`. */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return email ?? null;
  const at = email.indexOf('@');
  if (at <= 0) return `${MASK_CHAR.repeat(3)}`;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const { domainName, tld } = splitDomainTld(domain);
  const maskedLocal = local.length > 1 ? `${local[0]}${MASK_CHAR}` : MASK_CHAR;
  const maskedDomain =
    domainName.length > 1 ? `${domainName[0]}${MASK_CHAR.repeat(2)}` : MASK_CHAR;
  return `${maskedLocal}@${maskedDomain}${tld}`;
}

/**
 * Samarkan nomor HP: `+6281234567890` → `+62•••••••••90`.
 * Kode negara (bila terdeteksi) dipertahankan, 2 digit terakhir
 * dipertahankan agar admin masih bisa mencocokkan parsial.
 */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return phone ?? null;
  const trimmed = phone.trim();
  const plus = trimmed.startsWith('+') ? '+' : '';
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length <= 4) return `${plus}${MASK_CHAR.repeat(Math.max(digits.length, 3))}`;
  // Pertahankan 2 digit kode negara + 2 digit terakhir bila cukup panjang.
  const ccLen = digits.length > 8 ? 2 : 0;
  const visibleTail = 2;
  const maskedLen = digits.length - ccLen - visibleTail;
  return `${plus}${digits.slice(0, ccLen)}${MASK_CHAR.repeat(maskedLen)}${digits.slice(-visibleTail)}`;
}

export type PiiBearingUser = {
  email?: string | null;
  phoneNumber?: string | null;
};

/**
 * Terapkan masking PII sesuai role admin.
 * Kembalikan salinan `user` dengan email/phoneNumber disamarkan kecuali
 * `adminRole` ada di {@link PII_UNMASKED_ROLES}.
 */
export function applyUserMask<T extends PiiBearingUser>(
  adminRole: string | null | undefined,
  user: T,
): T {
  if (adminRole && PII_UNMASKED_ROLES.includes(adminRole)) {
    return user;
  }
  return {
    ...user,
    email: 'email' in user ? maskEmail(user.email) : (user as Record<string, unknown>).email,
    phoneNumber:
      'phoneNumber' in user ? maskPhone(user.phoneNumber) : (user as Record<string, unknown>).phoneNumber,
  };
}
