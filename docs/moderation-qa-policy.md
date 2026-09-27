# Kebijakan Moderasi Q&A Profil (G444)

> Dokumen kanonis moderasi platform untuk pertanyaan & komentar di profil
> pengguna (G426–G450). Bahasa: Indonesia. Terakhir diperbarui: 2026-09-26.
> Implementasi: `backend/src/modules/admin/qa-moderation/`,
> `backend/src/modules/users/qa-report.service.ts`,
> halaman admin `admin/src/app/(panel)/qa-moderation/`.

## 1. Ruang lingkup

Moderasi platform mencakup **pertanyaan profil** (`profile_questions`) dan
**komentar Q&A** (`profile_question_comments`). Ini TERPISAH dari moderasi
etalase (`showcase_reports`) — antrean, alasan, dan audit trail-nya sendiri.

## 2. Dua jalur moderasi (jangan dicampur)

| Jalur | Pelaku | Endpoint | Penanda |
|---|---|---|---|
| **Self-service pemilik** | Pemilik profil (receiver) | `POST /v1/users/questions/:id/hide` (dan unhide; komentar analog) | `hidden_by_type = OWNER` |
| **Moderator platform** | Admin (lihat §3) | `POST /v1/admin/qa-moderation/questions/:id/hide` (dan unhide; komentar analog) | `hidden_by_type = MODERATOR`, `hidden_by_admin_id` terisi |

Aturan keras:

- Moderator platform **tidak boleh** unhide konten yang di-hide pemilik
  profil (`OWNER`) — itu hak self-service pemilik. Service menolak dengan 403.
- Konten yang di-hide moderator **tidak bisa** di-unhide oleh pemilik profil;
  satu-satunya jalan adalah **keberatan (appeal)** — lihat §7.
- Endpoint admin memakai `JwtAdminGuard` (token admin `aud: kahade-admin-api`).
  Token user biasa **ditolak** — pemilik profil tidak bisa menyalahgunakan
  endpoint admin (G428).

## 3. Matriks RBAC (G447)

**Keputusan: TIDAK ada role moderator khusus dan TIDAK ada nilai baru di enum
`AdminRole`.** Moderator konten = `SUPER_ADMIN`, support = `CUSTOMER_SUPPORT`.

| Aksi | SUPER_ADMIN | CUSTOMER_SUPPORT | Role lain |
|---|---|---|---|
| Lihat antrean, detail, histori, metrik, kandidat spam | ✅ | ✅ | ❌ 403 |
| Hide / unhide (jalur moderator), redaksi PII | ✅ | ✅ | ❌ 403 |
| Bulk hide/unhide (maks 50, `confirm: true`) | ✅ | ✅ | ❌ 403 |
| Assign / handoff laporan, resolve laporan, review appeal | ✅ | ✅ | ❌ 403 |
| Request hapus permanen | ✅ | ❌ 403 | ❌ 403 |
| Approve / reject hapus permanen | ✅ (≠ requester) | ❌ 403 | ❌ 403 |
| Ekspor audit agregat CSV | ✅ | ❌ 403 | ❌ 403 |

Catatan: `CUSTOMER_SUPPORT` adalah garda depan (triage + hide cepat);
tindakan ireversibel (hapus permanen, ekspor) hanya `SUPER_ADMIN`.

## 4. Kode alasan moderator (G429)

`QaModerationReason`: `SPAM`, `PROFANITY`, `HARASSMENT`, `PII_LEAK`,
`SCAM_SUSPECTED`, `OFF_TOPIC`, `OTHER`. Alasan **wajib** di setiap hide
moderator dan **catatan internal** (`moderatorNote`) hanya terlihat admin —
tidak pernah dikirim ke user atau muncul di API publik.

Pemetaan ke kolom lama `hidden_reason` (`ContentHiddenReason`):
`SPAM→SPAM`, `PROFANITY→INAPPROPRIATE`, `HARASSMENT→HARASSMENT`, sisanya
`→OTHER`. Kode presisi selalu tersimpan di `qa_moderation_events.reason_code`.

## 5. Laporan pengguna (G431)

- Pengguna ter-autentikasi bisa melapor: `POST /v1/users/questions/:id/report`,
  `POST /v1/users/comments/:id/report` (body: `reasonCode`, `note` opsional).
- Tidak boleh melapor konten sendiri (400). Satu laporan **terbuka** per
  (pelapor, target) — duplikat ditolak 409 (partial unique index).
- Laporan masuk `qa_reports`, status awal `PENDING`; saat moderator mengambil
  aksi hide, laporan pending terkait otomatis menjadi `UNDER_REVIEW` dan
  ter-assign ke moderator tersebut.

## 6. Aksi moderator

- **Hide**: menyembunyikan dari Q&A publik seketika; mencatat event `HIDDEN`
  + notifikasi netral ke penulis (§9). Konten yang sudah hidden tidak bisa
  di-hide lagi (409).
- **Unhide**: hanya untuk hide `MODERATOR`; mencatat event `UNHIDDEN`.
- **Redaksi PII** (`POST /admin/qa-moderation/redact`): deteksi nomor HP
  Indonesia, email, NIK (16 digit), dan nomor rekening via regex; menyimpan
  `redacted_text` **tanpa mengubah teks original** (audit). Event `REDACTED`.
- **Bulk hide/unhide**: maks **50 ID per request**, wajib `confirm: true`
  (konfirmasi eksplisit dari UI), hasil **parsial per item** — satu item gagal
  tidak menggagalkan yang lain. Rate-limit: 10 request/menit per admin (G441).
- **Assignment/handoff**: laporan bisa di-assign ke admin (`UNDER_REVIEW`) atau
  di-handoff ke admin lain; `assigned_admin_id = null` melepas assignment (G446).

## 7. Keberatan / appeal (G436)

- Penulis konten **atau** pemilik profil bisa mengajukan keberatan atas hide
  `MODERATOR`: `POST /v1/users/qa/appeal` (alasan min. 10 karakter).
- Reviewer **wajib ≠ moderator yang melakukan hide** — ditegakkan di service
  (403 bila sama). Disetujui → konten di-unhide + event `APPEAL_APPROVED`;
  ditolak → keputusan moderasi tetap + event `APPEAL_REJECTED`.
- Target penyelesaian appeal: maks 3×24 jam (target operasional, bukan SLA
  kontrak).

## 8. Hapus permanen — dua langkah (G435)

1. `SUPER_ADMIN` mengajukan request (`.../delete-request`) dengan alasan.
2. `SUPER_ADMIN` **lain** (≠ requester — ditegakkan di service DAN constraint
   DB `qa_delete_requests_approver_differs`) menyetujui/menolak.
3. Disetujui → hard delete (komentar ikut terhapus via cascade untuk
   pertanyaan) + event `DELETED` + notifikasi ke penulis.
4. `qa_reports`, `qa_appeals`, `qa_moderation_events` memakai `target_id`
   tanpa FK sehingga **audit trail bertahan** walau target dihapus permanen.

## 9. Komunikasi ke pengguna (G443)

Notifikasi selalu **netral**: tidak menyebut pelapor, tidak menyebut detail
internal. Setiap notifikasi hide mencantumkan **cara banding**. Nada: informatif,
bukan menghakimi.

## 10. Deteksi spam lintas profil (G440)

Heuristik kandidat spam: teks identik (dinormalisasi) dari penulis yang sama
di **≥ N profil berbeda dalam 24 jam** (default N=3). Kandidat tampil di
antrean (`spamOnly`) dan endpoint `spam-candidates` — keputusan akhir tetap
manual oleh moderator.

## 11. Audit append-only (G437)

`qa_moderation_events`: hanya INSERT — tidak ada UPDATE/DELETE di tabel ini.
Setiap aksi (HIDE, UNHIDE, REDACTED, DELETED, APPEAL_SUBMITTED/APPROVED/REJECTED)
mencatat aktor, waktu, reason code, dan catatan internal. Detail admin
menampilkan histori lengkap + alasan terakhir (G438).

## 12. PII & privasi

- Daftar antrean: username **dimask parsial** (`bu•••`); **tanpa** nomor HP /
  email di list (G433).
- Ekspor audit (G448): CSV agregat — counts per reason/day. **Tanpa teks
  konten massal.** Hanya `SUPER_ADMIN`.
- Detail admin menampilkan teks penuh hanya bila diperlukan untuk peninjauan;
  gunakan redaksi (`redact`) sebelum membagikan ke pihak lain.

## 13. Metrik (G445)

`GET /admin/qa-moderation/metrics`: laporan open, under review, rata-rata
waktu penyelesaian (30 hari terakhir), distribusi reason code, jumlah hidden
per jalur (moderator vs owner). Target operasional: rata-rata penyelesaian
< 24 jam.

## 14. Retensi

- Laporan resolved, event audit, dan appeal: dipertahankan permanen (audit).
- Konten hard-delete: tidak dapat dipulihkan. Berbeda dari etalase (soft
  delete 30 hari) — penghapusan Q&A bersifat final dan karena itu butuh
  approval dua langkah.
