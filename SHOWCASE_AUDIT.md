# Audit Mendalam Modul Showcase (Etalase) — Backend Kahade

**Tanggal:** 26 September 2026
**Ruang lingkup:** `src/modules/showcase/` + CRUD owner di `src/modules/users/users.controller.ts` (`/users/me/showcase*`)
**Sifat:** Audit baca-saja. Tidak ada kode yang diubah.

---

## Ringkasan Eksekutif

Modul showcase secara umum dibangun dengan kualitas di atas rata-rata: validasi DTO kuat (harga negatif ditolak, panjang disamakan dengan schema DB), upload gambar memakai alur presigned + verifikasi magic-byte/ukuran/kepemilikan sehingga tidak ada risiko SSRF/hotlink, query memakai cursor-based pagination tanpa N+1, index database lengkap untuk pola feed, block-list dihormati di semua jalur baca dan tulis, like/unlike memakai atomic counter dengan guard anti-negatif, view counting di-dedupe via Redis, dan semua endpoint tulis punya rate limiting. Test cukup komprehensif (4 file, ±1732 baris).

Namun ditemukan **1 temuan KRITIS** pada `reportShowcase` (validasi hilang, audit log ditulis dengan kategori dan identitas yang salah, error ditelan `catch {}` kosong), **2 temuan TINGGI** (klaim "soft-delete" di dokumentasi vs hard delete permanen di implementasi; counter `commentCount` tidak akurat saat menghapus root comment yang sedang hidden), dan sejumlah temuan SEDANG/RENDAH (race condition limit item, replies tanpa batas per root, tidak ada share counter, dsb). Detail di bawah.

---

## Daftar Endpoint Lengkap

### `ShowcaseController` — `/v1/showcase` (permukaan sosial + discover)

| Method | Path | Auth | Throttle | Idempoten | Deskripsi |
|---|---|---|---|---|---|
| GET | `/v1/showcase/feed` | Publik | 60/mnt | – | Discover feed, cursor-based (`latest`/`popular`), filter category + search |
| PATCH | `/v1/showcase/comments/:commentId` | User | 20/mnt | Ya | Edit komentar sendiri |
| DELETE | `/v1/showcase/comments/:commentId` | User | 20/mnt | Ya | Hapus komentar (penulis atau pemilik etalase) |
| POST | `/v1/showcase/comments/:commentId/hide` | User | 20/mnt | Ya | Sembunyikan komentar (hanya pemilik item, `reason` wajib) |
| POST | `/v1/showcase/comments/:commentId/unhide` | User | 20/mnt | Ya | Tampilkan kembali komentar tersembunyi |
| GET | `/v1/showcase/:showcaseId/share` | Publik | 60/mnt | – | Payload share / deep link |
| GET | `/v1/showcase/:showcaseId/comments` | Publik | 60/mnt | – | Daftar komentar (root + 1 tingkat balasan) |
| POST | `/v1/showcase/:showcaseId/comments` | User | 20/mnt | Ya | Tulis komentar / balasan |
| POST | `/v1/showcase/:showcaseId/like` | User | 30/mnt | Ya | Like item |
| DELETE | `/v1/showcase/:showcaseId/like` | User | 30/mnt | Ya | Unlike item |
| GET | `/v1/showcase/:showcaseId` | Publik | 60/mnt | – | Detail item (+ viewCount dedupe per jam) |
| POST | `/v1/showcase/:showcaseId/report` | User | 5/jam | Ya | Laporkan item |

### `UsersController` — `/v1/users/me/showcase*` (CRUD milik owner)

| Method | Path | Auth | Throttle | Deskripsi |
|---|---|---|---|---|
| POST | `/v1/users/me/showcase/upload` | User | 10/mnt | Upload gambar langsung (multipart, maks 5 MB, jalur legacy) |
| GET | `/v1/users/me/showcase` | User | – | Daftar item milik sendiri (termasuk inactive/private) |
| POST | `/v1/users/me/showcase` | User | 10/mnt | Buat item baru (maks 20 item/user) |
| PUT | `/v1/users/me/showcase/:id` | User | – | Update item milik sendiri |
| POST | `/v1/users/me/showcase/:id/images` | User | 20/mnt | Lampirkan gambar (presigned key, maks 8/item) |
| PUT | `/v1/users/me/showcase/:id/images/order` | User | 20/mnt | Susun ulang urutan gambar |
| DELETE | `/v1/users/me/showcase/images/:imageId` | User | 20/mnt | Hapus satu gambar |
| DELETE | `/v1/users/me/showcase/:id` | User | – | Hapus item (hard delete + cascade) |

---

## Temuan

### KRITIS

#### K-1. `reportShowcase`: validasi hilang, audit log salah kategori & identitas, error ditelan
- **Lokasi:** `showcase.service.ts:1268-1295`, `showcase.controller.ts:231-240`
- **Masalah:**
  1. Controller memakai body inline `@Body() dto: { reason: string; description?: string }` — bukan class DTO — sehingga `ValidationPipe` tidak memvalidasi apa pun. `reason` bisa `undefined`, string kosong, atau sangat panjang tanpa batas.
  2. Service tidak memvalidasi `reason` sama sekali; langsung dipakai membangun string audit.
  3. `catch {}` kosong (baris 1279) menelan seluruh error pembuatan laporan tanpa log.
  4. Fallback menulis ke `adminAuditLog` dengan `action: 'SYSTEM_CONFIG_CHANGED'` — kategori yang salah untuk laporan konten user; merusak integritas audit trail (laporan user tercampur dengan perubahan konfigurasi sistem).
  5. `adminId` diisi dari `adminUser` pertama, atau **fallback ke `userId` pelapor** — user biasa tercatat sebagai "admin" di tabel audit admin.
  6. `ipAddress: 'system'` di-hardcode — informasi IP pelapor hilang.
  7. Tidak ada visibility check: user bisa melaporkan item PRIVATE / inactive / milik akun banned selama tahu ID-nya (jalur lain selalu memakai `findVisibleShowcase`).
  8. Tidak ada pengecekan duplikat — user bisa melaporkan item yang sama berulang kali (hanya dibatasi throttle 5/jam).
  9. Bentuk return inkonsisten: `{ reported, reportId }` vs `{ reported, showcaseId, reason }`.
  10. Tidak ada test untuk fungsi ini (grep `reportShowcase` di `tests/` kosong).
- **Dampak:** Audit trail admin tercemar data salah kategori/identitas; laporan tanpa alasan tetap masuk; potensi penyalahgunaan pelaporan.
- **Rekomendasi fix:**
  - Buat `ReportShowcaseDto` dengan `@IsString() @IsNotEmpty() @MaxLength(...)` untuk `reason` (sebaiknya enum kategori) dan `@MaxLength(1000)` untuk `description`.
  - Tambahkan `findVisibleShowcase` check sebelum menerima laporan (atau minimal cek item ada + aktif).
  - Tambahkan unique constraint `(showcaseId, reporterId)` atau cek duplikat eksplisit dengan error `ALREADY_REPORTED`.
  - Perbaiki audit: gunakan action `SHOWCASE_REPORTED` (atau kategori report yang benar), `adminId` = null / kolom reporter terpisah, `ipAddress` dari request.
  - Hapus `catch {}` kosong; log error dan lempar 500 yang benar bila gagal.
  - Tambah unit test.

---

### TINGGI

#### T-1. Dokumentasi mengklaim "soft-delete", implementasi hard delete permanen
- **Lokasi:** `showcase.service.ts:38-41` (komentar header), `showcase.service.ts:463-469` (`deleteShowcaseItem`)
- **Masalah:** Komentar prinsip file menyatakan *"Soft-delete / status akun: item hanya tampil publik bila …"* tetapi `deleteShowcaseItem` memanggil `prisma.userShowcase.delete()` — hard delete permanen. Berkat `onDelete: Cascade` di schema, seluruh likes, comments, dan images ikut hilang permanen.
- **Dampak:** Jika user/admin mengharapkan item terhapus bisa dipulihkan (sesuai klaim dokumentasi), data hilang permanen tanpa jalan kembali. Juga: riwayat interaksi (siapa me-like apa) ikut musnah.
- **Rekomendasi fix:** Putuskan salah satu — (a) implementasikan soft delete (`deletedAt`) + filter di semua query baca, atau (b) perbaiki dokumentasi dan konfirmasi ke user bahwa hapus = permanen. Opsi (a) lebih aman untuk produk sosial.

#### T-2. `commentCount` tidak akurat saat menghapus root comment yang sedang hidden
- **Lokasi:** `showcase.service.ts:1072-1090` (`deleteComment`)
- **Masalah:** Saat root comment di-hide, `commentCount` sudah di-decrement 1 (`setCommentHidden`). Saat root hidden tersebut kemudian dihapus, kode menghitung `removed = 1 + visibleReplies` — menghitung root-nya lagi padahal root sudah tidak termasuk dalam counter. Hasil: counter berkurang 1 lebih banyak dari seharusnya. Guard `gte: removed` mencegah nilai negatif, tetapi angka menjadi tidak akurat (lebih kecil dari jumlah komentar tampil yang sebenarnya).
- **Dampak:** Counter komentar di feed/detail tidak sinkron dengan daftar komentar yang tampil.
- **Rekomendasi fix:** Jika `existing.isHidden && existing.parentId === null`, `removed` harus = `visibleReplies` saja (tanpa +1). Tambah unit test untuk skenario hide → delete.

---

### SEDANG

#### S-1. `updateShowcaseItem`: where clause tanpa ownership check
- **Lokasi:** `showcase.service.ts:445`
- **Masalah:** Setelah `findOwnedShowcase(userId, itemId)`, update memakai `where: { id: itemId }` tanpa `userId`. Aman saat ini karena tidak ada mekanisme transfer ownership, tetapi melanggar prinsip defense-in-depth dan tidak konsisten dengan `removeImage` yang memakai filter `showcase: { userId }`.
- **Rekomendasi fix:** `where: { id: itemId, userId }`.

#### S-2. Race condition pada batas 20 item per user
- **Lokasi:** `showcase.service.ts:384-390` (`createShowcaseItem`)
- **Masalah:** Pola `count` → cek → `create` tanpa lock/transaksi. Dua request paralel bisa sama-sama lolos cek dan menghasilkan > 20 item. Throttle 10/menit mengurangi peluang tetapi tidak menghilangkan.
- **Rekomendasi fix:** Bungkus dalam transaksi dengan `SELECT ... FOR UPDATE` pada baris user, atau terima sebagai risiko rendah + tambah test konkurensi.

#### S-3. Balasan komentar tidak dibatasi jumlahnya per root
- **Lokasi:** `showcase.service.ts:922-931` (`listComments`)
- **Masalah:** Root dipaginasi (`take: safeLimit`), tetapi **seluruh** balasan untuk root di halaman diambil tanpa limit. Satu root viral dengan ribuan balasan menghasilkan response raksasa.
- **Rekomendasi fix:** Batasi balasan per root (mis. 20 terbaru/terlama + `replyCount`), atau paginasi balasan terpisah.

#### S-4. Tidak ada share counter
- **Lokasi:** `showcase.service.ts:1220-1255` (`getSharePayload`), schema `UserShowcase`
- **Masalah:** Tidak ada kolom/counter share. `GET /:showcaseId/share` hanya mengembalikan payload tanpa mencatat kejadian share. Jika produk membutuhkan analitik "berapa kali dibagikan", datanya tidak ada.
- **Rekomendasi fix:** Tambah `shareCount` + endpoint `POST /:showcaseId/share` (atau hitung saat deep link dibuka), bila dibutuhkan produk.

#### S-5. Laporan duplikat tidak dicegah
- **Lokasi:** `showcase.service.ts:1268`
- **Masalah:** Tidak ada unique constraint atau cek `(showcaseId, reporterId)`; satu user bisa melaporkan item yang sama berkali-kali (hanya throttle 5/jam yang membatasi).
- **Rekomendasi fix:** Sudah termasuk dalam rekomendasi K-1.

---

### RENDAH

#### R-1. `SHOWCASE_SEARCH_MIN_LENGTH` tidak dipakai (dead constant)
- **Lokasi:** `common/constants/app.constants.ts:139`
- **Masalah:** Konstanta `= 2` didefinisikan tetapi tidak direferensikan di mana pun; pencarian 1 karakter tetap diproses.
- **Rekomendasi fix:** Terapkan di `getFeed` (abaikan search < 2 karakter) atau hapus konstantanya.

#### R-2. `normalizeTitle` di update: hasil dibuang
- **Lokasi:** `showcase.service.ts:414`
- **Masalah:** `this.normalizeTitle(dto.title)` dipanggil hanya untuk validasi, hasilnya dibuang; baris 420 memakai `dto.title.trim()` lagi. Validasi tetap jalan, tetapi redundan dan rawan divergensi.
- **Rekomendasi fix:** `data.title = this.normalizeTitle(dto.title)`.

#### R-3. Update boleh mengosongkan gambar, create tidak
- **Lokasi:** `showcase.service.ts:432-447`, `dto/showcase-item.dto.ts`
- **Masalah:** `CreateShowcaseItemDto.imageFileKeys` wajib min 1 bila diisi; tetapi `UpdateShowcaseItemDto` mengizinkan `imageFileKeys: []` yang menghapus seluruh gambar — item tanpa gambar. Kebijakan tidak konsisten.
- **Rekomendasi fix:** Putuskan kebijakan (item boleh tanpa gambar atau tidak) dan samakan di kedua DTO + dokumentasi.

#### R-4. View tetap dihitung untuk item inactive milik owner
- **Lokasi:** `showcase.service.ts:226-243`, `648-667`
- **Masalah:** `findVisibleShowcase` mengizinkan owner melihat item `isActive=false` miliknya (untuk preview), tetapi `getShowcaseDetail` tetap memanggil `recordView` — viewCount naik untuk item nonaktif.
- **Rekomendasi fix:** Lewati `recordView` bila `isOwner && !row.isActive`.

#### R-5. Komentar dari user berprofil privat tetap tampil
- **Lokasi:** `showcase.service.ts:889-898` (`listComments` authorFilter)
- **Masalah:** Filter penulis komentar hanya cek `isActive/isBanned/deletedAt`, tidak `profileVisible`. Komentar user yang memprivatkan profil tetap tampil di item publik.
- **Rekomendasi fix:** Keputusan produk; bila ingin konsisten dengan feed, tambahkan `profileVisible: true` ke authorFilter.

#### R-6. `viewCount` respons adalah asumsi, bukan nilai aktual
- **Lokasi:** `showcase.service.ts:664`
- **Masalah:** `viewCount: visible.row.viewCount + 1` — nilai diambil sebelum increment; race dengan viewer lain membuat angka respons sedikit basi.
- **Rekomendasi fix:** Kembalikan nilai dari `updateMany` tidak mungkin (tidak return row); alternatif: baca ulang setelah increment, atau terima sebagai minor.

#### R-7. `unlikeShowcase` tidak mengecek relasi block
- **Lokasi:** `showcase.service.ts:820-847`
- **Masalah:** `likeShowcase` memanggil `assertNoBlockRelation`, `unlikeShowcase` tidak. Tidak ada dampak keamanan (hanya menghapus like milik sendiri), tetapi inkonsisten.
- **Rekomendasi fix:** Tambahkan check yang sama demi konsistensi, atau dokumentasikan alasannya.

#### R-8. Pesan error delete comment menyesatkan
- **Lokasi:** `showcase.service.ts:1082-1086`
- **Masalah:** Pesan *"You can only delete your own comment"* padahal pemilik showcase juga boleh menghapus.
- **Rekomendasi fix:** Ubah pesan menjadi *"You can only delete your own comment or comments on your showcase"*.

---

## Yang Sudah Baik (tidak perlu diubah)

1. **Validasi input kuat:** harga negatif ditolak (`@Min(0)`), judul wajib (DTO + `normalizeTitle`), panjang disamakan dengan schema DB (`VarChar(100/500/60)`), `priceMin <= priceMax` ditegakkan, kategori dinormalisasi lowercase.
2. **Upload aman:** gambar hanya via presigned key purpose `SHOWCASE_IMAGE` + `verifyUserFileKeys` (bentuk key, kepemilikan folder=userId, konfirmasi upload, ukuran & content-type tersimpan, magic-byte di `UploadService`); tidak ada penerimaan URL bebas → tidak ada SSRF/hotlink. Jalur multipart legacy dibatasi 5 MB dan lewat `UploadService` yang sama.
3. **SQL injection:** semua query via Prisma parameterized; free-text search di-escape via `escapeLikePattern` (`%`, `_`, `\` diperlakukan literal).
4. **Like idempoten:** unique constraint `(userId, showcaseId)` + penanganan `P2002` → 409 `SHOWCASE_ALREADY_LIKED`; unlike memakai `deleteMany` + guard `likeCount: { gt: 0 }`; interceptor idempotency me-replay respons untuk retry dengan key sama.
5. **Counter aman:** semua increment/decrement atomic dalam transaksi yang sama dengan mutasi baris; guard `gt/gte 0` mencegah negatif.
6. **Feed:** cursor-based (keyset) — tidak ada masalah duplikat/lompatan offset; tidak ada N+1 (`include` + 1 query `isLiked`); index DB lengkap (`[visibility, isActive, createdAt, id]`, `[visibility, isActive, likeCount, id]`, `[category]`, `[showcaseId, parentId, createdAt, id]`).
7. **Privasi & blokir:** `findVisibleShowcase` menegakkan visibility PRIVATE, `isActive`, `profileVisible`, banned/deleted, dan block dua arah di semua jalur baca; `assertNoBlockRelation` menolak interaksi (403 `USER_BLOCKED`) sebelum like/komentar.
8. **Otorisasi owner:** seluruh CRUD memakai `findOwnedShowcase(userId, …)` / filter `showcase: { userId }` — tidak ditemukan endpoint yang memungkinkan user A mengubah item milik user B.
9. **View counting:** dedupe Redis `SET NX` per viewer per jam (IP di-hash SHA-256 untuk anonim).
10. **Rate limiting:** semua endpoint tulis dilindungi (`UserThrottleGuard` + `@Throttle`): like/unlike 30/mnt, komentar 20/mnt, report 5/jam, create 10/mnt, feed 60/mnt.
11. **Error handling:** input invalid → 400 dengan kode error terstruktur; tidak ada 500 untuk input invalid pada jalur yang diaudit.
12. **Moderasi komentar:** hide/unhide oleh pemilik item dengan alasan kategori wajib (`ContentHiddenReason`), `commentCount` disesuaikan, komentar hidden tetap terlihat oleh pemilik beserta alasannya.
13. **Test:** 4 file (±1732 baris) mencakup feed (visibility, block, filter, sort, cursor), like/unlike, komentar (CRUD, moderasi, depth), throttle controller, dan owner CRUD + images + view counter. Satu-satunya fungsi tanpa test adalah `reportShowcase`.

---

## Prioritas Fix yang Disarankan

1. **K-1** (`reportShowcase`) — perbaiki dulu; menyentuh integritas audit.
2. **T-2** (counter comment) — fix kecil, dampak akurasi angka.
3. **T-1** (soft-delete vs hard delete) — butuh keputusan produk sebelum kode.
4. **S-1, S-2, S-3** — hardening bertahap.
5. **R-1 s/d R-8** — polish; bisa digabung dalam satu batch.
