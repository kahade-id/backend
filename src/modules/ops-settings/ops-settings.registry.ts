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
  /**
   * SEC-506: true → kategori FINANSIAL (fee, limit, ambang disbursement,
   * config DANA, WALLET_ENABLED). Perubahan WAJIB via dual control
   * (OPS_SETTING_CHANGE) — tidak bisa diubah langsung via PUT.
   */
  financial: boolean;
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
    financial: false,
  },
  {
    key: 'FONNTE_WEBHOOK_SECRET',
    label: 'Fonnte Webhook Secret',
    description:
      'Secret verifikasi webhook Fonnte. Kirim via header x-fonnte-secret ' +
      '(disarankan) atau field body webhookSecret — JANGAN via query param ' +
      '?webhookSecret= karena URL tercatat di nginx access log (SEC-003). ' +
      'CATATAN: Dashboard Fonnte tidak mendukung secret custom — gunakan ' +
      'FONNTE_WEBHOOK_IPS (IP whitelist) sebagai gantinya. Bila secret DAN ' +
      'IP whitelist kosong, SEMUA webhook DITOLAK (fail-closed).',
    isSecret: true,
    testable: false,
    financial: false,
  },
  {
    key: 'FONNTE_WEBHOOK_IPS',
    label: 'Fonnte Webhook IP Whitelist',
    description:
      'Daftar IP server Fonnte yang diizinkan mengirim webhook, dipisah koma ' +
      '(mis. 103.52.212.50). Dashboard Fonnte tidak mendukung webhook secret, ' +
      'sehingga verifikasi dilakukan via IP pengirim. Hanya IP dalam daftar ' +
      'ini yang diterima bila secret tidak cocok. Kosongkan untuk menonaktifkan ' +
      'verifikasi IP (tidak disarankan).',
    isSecret: false,
    testable: false,
    financial: false,
  },
  {
    key: 'FONNTE_API_URL',
    label: 'Fonnte API URL',
    description:
      'Endpoint API Fonnte (default https://api.fonnte.com/send). Hapus override ' +
      'via tombol "Kembalikan ke default" untuk memakai default. URL divalidasi ' +
      'anti-SSRF (wajib HTTPS, tanpa kredensial, bukan IP privat) dan ' +
      'dinormalisasi — nilai tersimpan bisa berbeda dari yang diketik.',
    isSecret: false,
    testable: false,
    financial: false,
  },
  {
    key: 'FONNTE_COUNTRY_CODE',
    label: 'Fonnte Country Code',
    description: 'Kode negara default untuk nomor tujuan Fonnte (default: 62).',
    isSecret: false,
    testable: false,
    financial: false,
  },
  {
    key: 'MAINTENANCE_MODE',
    label: 'Mode Maintenance',
    description:
      'Bila "true", semua request non-admin dijawab 503 + header Retry-After ' +
      '(admin panel tetap bisa diakses). Default: off (kosong/"false"). ' +
      'Diubah via PUT /v1/admin/maintenance (toggle + pesan) atau panel ini.',
    isSecret: false,
    testable: false,
    financial: false,
  },
  {
    key: 'MAINTENANCE_MESSAGE',
    label: 'Pesan Maintenance',
    description:
      'Pesan yang ditampilkan ke user saat mode maintenance aktif ' +
      '(maks 500 karakter). Hapus override via tombol "Kembalikan ke default" ' +
      '(atau kosongkan pesan di kartu maintenance) untuk memakai pesan default.',
    isSecret: false,
    testable: false,
    financial: false,
  },
  {
    key: 'WALLET_ENABLED',
    label: 'Wallet Internal Aktif',
    description:
      'Kill-switch wallet internal (misi BI-safe). "true" = wallet internal ' +
      '(saldo, top-up, withdraw, PIN) diaktifkan kembali; kosong/"false" = ' +
      'NONAKTIF (default, fail-closed) — uang hanya numpang lewat via DANA ' +
      '(buyer → DANA → escrow → rekening bank seller). Setara dengan env ' +
      'WALLET_ENABLED. Berlaku untuk request berikutnya (maks ~60 detik). ' +
      'SEC-506: kategori FINANSIAL — perubahan wajib dual control.',
    isSecret: false,
    testable: false,
    financial: true,
  },
  {
    key: 'TRANSLATION_PROVIDER',
    label: 'Translation Provider',
    description:
      'FAL-006: provider layanan terjemahan (mis. "google", "deepl"). ' +
      'Dibaca dinamis oleh consumer terjemahan via OpsSettingsService.',
    isSecret: false,
    testable: false,
    financial: false,
  },
  {
    key: 'TRANSLATION_API_KEY',
    label: 'Translation API Key',
    description:
      'FAL-006: API key provider terjemahan. Disimpan terenkripsi AES-GCM, ' +
      'tampil ter-mask di panel.',
    isSecret: true,
    testable: false,
    financial: false,
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
