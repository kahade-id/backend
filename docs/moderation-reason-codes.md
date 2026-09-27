# Kode Alasan Moderasi — Dokumentasi Internal (G412/G413)

Dokumen ini untuk moderator Kahade. Setiap keputusan moderasi laporan etalase
**wajib** memakai salah satu `reasonCode` di bawah (bukan catatan bebas), agar
keputusan konsisten, dapat diaudit, dan bisa diagregasi untuk metrik.

Kode didefinisikan di
`backend/src/modules/admin/showcase-reports/moderation-prisma.types.ts`
(`MODERATION_REASON_CODES`). Bobot risiko tiap kode ada di
`moderation-lifecycle.constants.ts` (`REASON_CODE_RISK_WEIGHT`).

## Daftar kode

### SPAM
Konten promosi massal, tautan afiliasi berulang, atau teks identik yang
diposting ke banyak etalase. Tindakan umum: takedown bila pola jelas,
restrict sementara untuk pelanggaran pertama ringan.

### HARASSMENT
Ujaran kebencian, ancaman, perundungan, atau doxing terhadap pengguna lain
di judul/deskripsi/gambar etalase. Tindakan umum: takedown + pertimbangkan
sanksi akun via tim terkait.

### FRAUD_SUSPECTED
Indikasi penipuan: harga tidak wajar sebagai umpan, permintaan transaksi di
luar escrow, akun baru dengan pola mencurigakan. Tindakan umum: takedown +
eskalasi ke tim fraud (jangan hubungi pemilik selain notifikasi standar).

### PROHIBITED_ITEM
Barang/jasa yang dilarang kebijakan Kahade (mis. barang ilegal, senjata,
data pribadi diperjualbelikan). Tindakan umum: takedown permanen.

### MISLEADING
Deskripsi/gambar menyesatkan: foto tidak sesuai barang, klaim palsu
(original padahal replika), harga jebakan. Tindakan umum: takedown; bila
bisa diperbaiki pemilik, arahkan banding dengan bukti baru.

### IP_VIOLATION
Pelanggaran hak kekayaan intelektual: merek/logo tanpa izin, konten
berhak cipta. Tindakan umum: takedown; catat untuk potensi klaim berulang.

### NUDITY
Konten vulgar/eksplisit pada gambar etalase. Tindakan umum: takedown.

### OTHER
Tidak masuk kategori di atas. **Wajib** sertakan catatan manual yang jelas
(G422) — kode ini tidak boleh dipakai untuk menghindari klasifikasi.

## Aturan pemakaian

1. Pilih kode paling spesifik; bila ragu antara dua kode, pilih yang
   risikonya lebih tinggi dan jelaskan di catatan.
2. Setiap keputusan final (takedown / dismiss / no_action / restrict /
   reopen) wajib mencantumkan alasan manual (G422) selain kode.
3. Kode OTHER dengan catatan kosong akan ditolak backend.
4. Perubahan daftar kode adalah perubahan kebijakan — diskusikan dengan
   SUPER_ADMIN dan perbarui dokumen ini + konstanta backend bersamaan.
