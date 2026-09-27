/**
 * OPS — Registry setting operasional yang boleh dikelola via admin panel.
 *
 * ATURAN KERAS:
 * - Hanya key OPERASIONAL (token integrasi, URL, flag) yang masuk sini.
 * - Boot secret & kunci kripto (DATABASE_URL, JWT_*, AES_SECRET_KEY,
 *   HMAC_SECRET_KEY, WALLET_PIN_PEPPER, REDIS_*) TIDAK BOLEH masuk registry —
 *   dibaca sekali saat boot; salah ubah = aplikasi tidak bisa start dan
 *   admin terkunci dari luar.
 * - Menambah key baru = tambah entri di sini + wiring consumer-nya agar
 *   membaca via OpsSettingsService (bukan process.env langsung).
 */
export interface ManageableSettingDef {
  key: string;
  label: string;
  description: string;
  /** true → disimpan terenkripsi AES-GCM, tampil mask di UI/API */
  isSecret: boolean;
  /** true → admin panel menampilkan tombol "Test koneksi" */
  testable: boolean;
}

export const MANAGEABLE_SETTINGS: ManageableSettingDef[] = [
  {
    key: 'FONNTE_API_TOKEN',
    label: 'Fonnte API Token',
    description:
      'Token API Fonnte untuk WhatsApp OTP & notifikasi. Token ini bisa berubah ' +
      'sewaktu-waktu dari dashboard Fonnte — ganti di sini tanpa restart server. ' +
      'Berlaku untuk pengiriman berikutnya (maks ~60 detik).',
    isSecret: true,
    testable: true,
  },
  {
    key: 'FONNTE_WEBHOOK_SECRET',
    label: 'Fonnte Webhook Secret',
    description:
      'Secret verifikasi webhook Fonnte. Kirim via header x-fonnte-secret ' +
      '(disarankan) atau field body webhookSecret — JANGAN via query param ' +
      '?webhookSecret= karena URL tercatat di nginx access log (SEC-003). ' +
      'Wajib diset untuk hardening produksi; kosong = fail-open (tidak aman).',
    isSecret: true,
    testable: false,
  },
  {
    key: 'FONNTE_API_URL',
    label: 'Fonnte API URL',
    description: 'Endpoint API Fonnte. Kosongkan untuk memakai default https://api.fonnte.com/send.',
    isSecret: false,
    testable: false,
  },
  {
    key: 'FONNTE_COUNTRY_CODE',
    label: 'Fonnte Country Code',
    description: 'Kode negara default untuk nomor tujuan Fonnte (default: 62).',
    isSecret: false,
    testable: false,
  },
];

export const MANAGEABLE_SETTING_MAP: Map<string, ManageableSettingDef> = new Map(
  MANAGEABLE_SETTINGS.map((d) => [d.key, d]),
);

export function isManageableSetting(key: string): boolean {
  return MANAGEABLE_SETTING_MAP.has(key);
}

/** Mask untuk tampilan: "••••ab12" — tidak pernah membocorkan secret utuh. */
export function maskSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  const tail = value.slice(-4);
  return `••••${tail}`;
}
