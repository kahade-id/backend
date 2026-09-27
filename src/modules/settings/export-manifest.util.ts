/**
 * Manifest arsip ekspor data (G089, G097, G099).
 *
 * Setiap arsip ekspor memuat manifest.json:
 * { schemaVersion, generatedAt, locale, datasets: [{name, rows, format}],
 *   redactionPolicy, excluded }
 * Bahasa manifest mengikuti preferensi bahasa akun (id/en).
 */

export type ExportLocale = 'id' | 'en';

export const EXPORT_SCHEMA_VERSION = 2;

export interface ManifestDataset {
  name: string;
  rows: number;
  format: 'json' | 'csv';
}

export interface ManifestExcluded {
  field: string;
  reason: string;
}

const STRINGS: Record<ExportLocale, { redactionPolicy: string; excludedTitle: string; exclusions: ManifestExcluded[] }> = {
  id: {
    redactionPolicy:
      'Kebijakan redaksi ekspor data Kahade. (1) Data yang Anda buat atau yang ditujukan untuk Anda disertakan penuh. ' +
      '(2) Data pribadi pihak lain (lawan transaksi, admin, pengguna lain) diminimalkan menjadi username publik saja; ' +
      'isi pesan pihak lain tidak disertakan. (3) Nomor rekening bank hanya tampil 4 digit terakhir; nomor penuh ' +
      'tidak pernah disertakan. (4) Dokumen KYC tidak disertakan sama sekali. (5) Isi pesan chat tidak disertakan — ' +
      'hanya metadata (id room, peserta, jumlah pesan) beserta penjelasan retensi di bawah. ' +
      'Retensi chat: isi pesan disimpan selama akun aktif dan dihapus permanen saat akun dihapus; metadata ' +
      'dipertahankan untuk keperluan audit sesuai ketentuan yang berlaku.',
    excludedTitle: 'Data yang dikecualikan atau dimaskir',
    exclusions: [
      { field: 'Dokumen KYC (KTP, swafoto, dsb.)', reason: 'Dokumen identitas sangat sensitif; tidak disertakan dalam ekspor unduhan. Verifikasi status KYC tetap tersedia di aplikasi.' },
      { field: 'Nomor rekening bank penuh', reason: 'Hanya 4 digit terakhir yang ditampilkan untuk mencegah penyalahgunaan bila berkas bocor.' },
      { field: 'Nomor HP & email lawan transaksi', reason: 'Data kontak pihak lain bukan milik Anda; hanya username publik yang disertakan.' },
      { field: 'Isi pesan chat', reason: 'Percakapan dapat memuat data pribadi kedua belah pihak; hanya metadata yang diekspor. Lihat kebijakan retensi di atas.' },
      { field: 'Isi pesan admin/pihak lain pada tiket support & sengketa', reason: 'Privasi pihak lain (petugas/admin); hanya pesan milik Anda yang disertakan penuh.' },
      { field: 'URL file bukti sengketa', reason: 'Bukti dapat memuat dokumen identitas; URL akses tidak dibagikan ulang. Unduh ulang melalui aplikasi bila diperlukan.' },
      { field: 'Alamat IP sesi/perangkat', reason: 'Dimaskir sebagian (oktet terakhir disamarkan) untuk mengurangi jejak lokasi.' },
      { field: 'Metadata internal transaksi (idempotency key, referensi gateway)', reason: 'Data operasional internal, bukan data pribadi Anda.' },
    ],
  },
  en: {
    redactionPolicy:
      'Kahade data export redaction policy. (1) Data you created or addressed to you is included in full. ' +
      '(2) Other parties\u2019 personal data (counterparts, admins, other users) is minimized to public usernames only; ' +
      'other parties\u2019 message content is not included. (3) Bank account numbers show only the last 4 digits; full ' +
      'numbers are never included. (4) KYC documents are never included. (5) Chat message content is not included — ' +
      'only metadata (room id, participants, message count) plus the retention note below. ' +
      'Chat retention: message content is kept while the account is active and permanently deleted when the account ' +
      'is deleted; metadata is retained for audit as required by applicable regulations.',
    excludedTitle: 'Excluded or masked data',
    exclusions: [
      { field: 'KYC documents (ID card, selfies, etc.)', reason: 'Identity documents are highly sensitive; they are never included in downloadable exports. KYC verification status remains available in the app.' },
      { field: 'Full bank account numbers', reason: 'Only the last 4 digits are shown to prevent misuse if the file leaks.' },
      { field: 'Counterparty phone numbers & emails', reason: 'Other parties\u2019 contact data is not yours; only public usernames are included.' },
      { field: 'Chat message content', reason: 'Conversations may contain both parties\u2019 personal data; only metadata is exported. See the retention note above.' },
      { field: 'Admin/other-party message content in support tickets & disputes', reason: 'Privacy of the other party (agents/admins); only your own messages are included in full.' },
      { field: 'Dispute evidence file URLs', reason: 'Evidence may contain identity documents; access URLs are not re-shared. Re-download via the app if needed.' },
      { field: 'Session/device IP addresses', reason: 'Partially masked (last octet hidden) to reduce location traceability.' },
      { field: 'Internal transaction metadata (idempotency keys, gateway references)', reason: 'Internal operational data, not your personal data.' },
    ],
  },
};

export interface ExportManifest {
  schemaVersion: number;
  generatedAt: string;
  locale: ExportLocale;
  datasets: ManifestDataset[];
  redactionPolicy: string;
  excluded: { title: string; items: ManifestExcluded[] };
}

/** Bangun manifest ekspor sesuai locale akun (G099). */
export function buildExportManifest(locale: ExportLocale, datasets: ManifestDataset[]): ExportManifest {
  const loc: ExportLocale = locale === 'en' ? 'en' : 'id';
  const strings = STRINGS[loc];
  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    locale: loc,
    datasets,
    redactionPolicy: strings.redactionPolicy,
    excluded: { title: strings.excludedTitle, items: strings.exclusions },
  };
}
