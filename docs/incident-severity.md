# Klasifikasi Insiden — SEV1–SEV4 (G496)

Dipakai on-call untuk menentukan urgensi, pemilik, dan kewajiban komunikasi.
"Pengguna" = pengguna aplikasi Kahade; "uang" = dana escrow/wallet/payout.

## Matriks

| | SEV1 (kritis) | SEV2 (tinggi) | SEV3 (sedang) | SEV4 (rendah) |
|---|---|---|---|---|
| **Definisi** | Uang pengguna berisiko / hilang, atau layanan inti mati total | Alur kritis rusak sebagian / degradasi berat | Gangguan terbatas, workaround ada | Kosmetik / internal, tanpa dampak pengguna |
| **Contoh** | Escrow tidak cair massal; webhook payment gagal >50%/30 mnt; kebocoran data; DB down | OTP down >15 mnt; login 5xx massal; disk >90%; PENDING >20%/jam | Satu provider push gagal; latency p95 >2x SLO 1 jam; DLQ naik tapi tertangani | Typo status page; alert false positive; metrik delay |
| **Pemilik** | CTO + on-call | On-call (+ secondary bila >1 jam) | On-call | Tim terkait (backlog) |
| **Respons awal** | ≤ 15 menit | ≤ 30 menit | ≤ 4 jam kerja | Sprint berikutnya |
| **Update status publik** | ≤ 30 menit, tiap 30 menit | ≤ 1 jam, tiap 2 jam | Bila >4 jam | Tidak perlu |
| **Komunikasi** | Grup darurat + halaman status + (bila perlu) broadcast in-app | Halaman status + grup on-call | Halaman status bila berdampak | Tidak perlu |
| **Postmortem** | Wajib ≤ 3 hari kerja | Wajib ≤ 5 hari kerja | Ringkas (opsional) | Tidak |

## Aturan main

1. **Bila ragu, naikkan satu tingkat.** Menurunkan SEV lebih murah daripada
   menaikkan terlambat.
2. **Uang selalu SEV1.** Setiap anomali dana (selisih ledger, double-credit,
   payout macet massal) = SEV1 tanpa kecuali, freeze rilis terkait sampai jelas.
3. **Keamanan selalu SEV1.** Indikasi akses tak sah, kebocoran PII, atau
   bypass auth = SEV1; jangan tulis detail serangan di kanal publik.
4. **Komunikasi publik tanpa PII.** Deskripsi insiden di `GET /v1/status`
   ditulis untuk publik — backend menolak pola nomor HP/email/NIK
   (`IncidentsController.assertNoPii`). Jangan sebut nama pengguna, nominal
   spesifik user, atau detail internal (nama tabel, IP).
5. **Satu komandan.** Tiap insiden SEV1/SEV2 punya satu incident commander
   (default: on-call) — semua keputusan mitigasi lewat dia.
6. **Mitigasi > root cause.** Rollback/scale/failover dulu; investigasi
   mendalam setelah layanan pulih.
7. **Catat timeline.** Semua aksi + jam dicatat di thread insiden; jadi bahan
   postmortem.

## Status insiden (di halaman `/status` admin & `/v1/status` publik)

`INVESTIGATING` → `IDENTIFIED` → `MONITORING` → `RESOLVED`.
Jangan loncat ke RESOLVED tanpa periode MONITORING untuk SEV1/SEV2
(minimal 30 menit observasi pasca-mitigasi).
