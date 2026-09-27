# Kontrak API — Batch 19 TIM A (backend media & discovery)

Dokumen kontrak untuk tim frontend. Backend: NestJS, base path `/v1`.
Semua timestamp ISO-8601, semua id string (cuid).

---

## 1. Upload VIDEO etalase

### `POST /v1/upload/direct` (diperluas, bukan endpoint baru)
Multipart: `file` (binary) + `purpose=SHOWCASE_VIDEO`.

| Aturan | Nilai |
|---|---|
| MIME diterima (server-side magic-byte, fail closed) | `video/mp4`, `video/quicktime` (.mov), `video/webm` |
| Ukuran | 1 KiB – **100 MiB** (multer guard kasar 105 MiB) |
| Durasi | **1 – 180 detik** (diukur server-side via `ffprobe`; ffprobe gagal parse → 400) |
| Visibilitas | **publik** — `uploads/showcase-videos/<userId>/…`, diserve nginx `https://api.kahade.id/uploads/…` dengan **HTTP Range** (seek normal) |

**Response 200** (field `fileKey`/`fileUrl` lama tetap; sisanya tambahan):
```json
{
  "fileKey": "uploads/showcase-videos/<userId>/1700000000-AbC1-x.mp4",
  "fileUrl": "https://api.kahade.id/uploads/showcase-videos/<userId>/1700000000-AbC1-x.mp4",
  "thumbnailFileKey": "uploads/showcase-images/<userId>/thumb-1700000000-AbC1.jpg",
  "thumbnailUrl": "https://api.kahade.id/uploads/showcase-images/<userId>/thumb-1700000000-AbC1.jpg",
  "durationSec": 12,
  "width": 1280,
  "height": 720
}
```
- Thumbnail JPEG (lebar 640px, frame ~detik ke-1) dibuat server-side via `ffmpeg`, dan
  **sudah terkonfirmasi** (`confirmed_upload` di-set server) — langsung bisa dipakai
  sebagai `thumbnailFileKey` media showcase tanpa langkah tambahan.
- Pilihan angka (didokumentasikan): 100 MiB ≈ video 720p ~2–3 menit pada bitrate wajar;
  180 detik = batas konten etalase pendek (bukan hosting video panjang). Keduanya
  fail-closed di server; multer 105 MiB hanya guard kasar agar request raksasa
  tidak memenuhi memori.

**Error codes**: `FILE_TOO_LARGE` (>100 MiB), `MIME_TYPE_MISMATCH` (bukan video valid /
konten ≠ klaim), `VIDEO_TOO_LONG` (>180 dtk), `VIDEO_UNPROCESSABLE` (ffprobe tidak
bisa membaca durasi), `UPLOAD_FAILED` (ffmpeg hilang di server — masalah infra, 500).

> ⚠️ Prasyarat deploy: `ffmpeg` + `ffprobe` **wajib terinstal di server**
> (saat ini BELUM ada di 15.232.109.186). Tanpa itu upload video → 500.

---

## 2. Media etalase: `kind` = image | video | spin360

### Create / Update etalase
`POST /v1/users/me/showcase` dan `PUT /v1/users/me/showcase/:id` menerima field
**baru opsional** `media[]` (field lama `imageFileKeys` tetap jalan, kind=image):

```json
{
  "title": "Tas kulit",
  "media": [
    { "fileKey": "uploads/showcase-images/u/…jpg", "kind": "image" },
    { "fileKey": "uploads/showcase-videos/u/…mp4",
      "kind": "video",
      "thumbnailFileKey": "uploads/showcase-images/u/thumb-….jpg",
      "durationSec": 12 },
    { "fileKey": "uploads/showcase-images/u/f1.jpg", "kind": "spin360",
      "groupKey": "spin-a1", "groupOrder": 0 },
    { "fileKey": "uploads/showcase-images/u/f2.jpg", "kind": "spin360",
      "groupKey": "spin-a1", "groupOrder": 1 }
  ]
}
```

Validasi (fail closed):
- `fileKey` harus upload confirmed milik user, purpose cocok
  (`image`/`spin360` → `SHOWCASE_IMAGE`, `video` → `SHOWCASE_VIDEO`).
- `video`: `thumbnailFileKey` harus confirmed `SHOWCASE_IMAGE` milik user
  (boleh pakai yang auto-generate dari upload); `durationSec` 1–180 bila diisi.
- `spin360`: **8–24 frame** per `groupKey`; `groupOrder` harus **0..n-1 kontinu**
  tanpa lompat; `groupKey` alnum/`-`/`_` maks 64 char; semua frame satu grup
  harus ada dalam request yang sama.

### Bentuk media di semua respons etalase (feed, detail, profil)
`images[]` kini berisi objek media (field lama `imageUrl`/`sortOrder` tetap):
```json
{
  "id": "…",
  "kind": "image",
  "imageUrl": "https://…",
  "thumbnailUrl": null,
  "durationSec": null, "width": null, "height": null,
  "groupKey": null, "groupOrder": null,
  "sortOrder": 0
}
```
- `kind="video"`: `imageUrl` = URL file video, `thumbnailUrl` = thumbnail,
  `durationSec`/`width`/`height` terisi.
- `kind="spin360"`: `groupKey` + `groupOrder` terisi; viewer 360° = semua media
  dengan `groupKey` sama, diurut `groupOrder` naik, drag horizontal = frame
  berurutan dengan wrap-around (frame terakhir → frame 0).
- `coverImageUrl` (tetap ada): media pertama; bila video → pakai `thumbnailUrl`-nya.

---

## 3. Likers & Savers etalase

### Save (fitur baru — prasyarat endpoint savers)
- `POST /v1/showcase/:id/save` → `200 { "saved": true, "saveCount": n }`
  (sudah save → `409 SHOWCASE_ALREADY_SAVED`; item tak terlihat → `404`).
- `DELETE /v1/showcase/:id/save` → `200 { "saved": false, "saveCount": n }`
  (belum save → `404 SHOWCASE_NOT_SAVED`).

### Daftar
- `GET /v1/showcase/:id/likers?page=1&limit=20` — **publik** (limit maks 100).
  Item PRIVATE / tak terlihat → `404 SHOWCASE_NOT_FOUND`.
- `GET /v1/showcase/:id/savers?page=1&limit=20` — **hanya pemilik produk**.
  Belum login → `401`; login tapi bukan pemilik → **`403 SHOWCASE_FORBIDDEN`**
  ("Hanya pemilik produk yang dapat melihat daftar penyimpan").

Response (keduanya, offset pagination):
```json
{
  "data": [{ "userId": "…", "username": "budi", "fullName": "Budi",
             "avatarUrl": "https://…", "likedAt": "2026-…" }],
  "total": 42, "page": 1, "limit": 20,
  "totalPages": 3, "hasNext": true, "hasPrev": false
}
```
(`savers` memakai `savedAt` sebagai ganti `likedAt`.)

Tambahan di payload etalase (aditif): `saveCount` (int) dan `isSaved` (bool, viewer).

---

## 4. Highlight etalase

### Milik user login — `POST /v1/highlights`
```json
{ "title": "Koleksi Lebaran", "coverMediaId": "…(opsional)",
  "productIds": ["showcaseId1", "showcaseId2"] }
```
- `title`: 1–80 char. `coverMediaId`: id media milik **salah satu etalase milikku**
  (fail closed; `null`/absen → cover = media pertama produk pertama).
- `productIds`: maks **50**, unik, semuanya etalase **milikku** & belum dihapus.
- Maks **20 highlight per user** (`409 HIGHLIGHT_LIMIT_REACHED` bila lewat).

**Response 201**:
```json
{ "id": "…", "title": "Koleksi Lebaran",
  "coverMediaId": "…", "coverMediaUrl": "https://…",
  "sortOrder": 0,
  "products": [{ "id": "…", "title": "…", "coverImageUrl": "https://…" }],
  "productCount": 2, "createdAt": "2026-…" }
```

### Lainnya (milikku, auth)
- `GET /v1/highlights` → `{ "highlights": [ …ringkas + productCount… ] }`
  (termasuk highlight yang produknya private — ini tampilan pemilik).
- `GET /v1/highlights/:id` → detail penuh (milikku saja; milik orang → 404).
- `PATCH /v1/highlights/:id` → `{ title?, coverMediaId? (null = hapus cover), productIds? }`
  (`productIds` = replace penuh bila diisi).
- `DELETE /v1/highlights/:id` → `200 { "deleted": true }`.

### Publik — `GET /v1/users/:username/highlights`
- Hanya highlight yang punya **≥1 produk PUBLIC + aktif + tidak dihapus**;
  produk private/takedown **tidak diekspos** di payload publik.
- `username` tak ada / profil private / banned → `404 USER_NOT_FOUND`
  (konsisten dengan pola profil).

---

## 5. Breakdown rating

`GET /v1/users/:username/ratings` — **semua field existing tidak berubah**;
ditambah:
```json
{
  "distribution": { "1": 3, "2": 1, "3": 5, "4": 12, "5": 40 },
  "averageRating": 4.5,
  …
}
```
- `distribution` = jumlah rating **visible** per bintang (receiver + tidak hidden +
  pemberi sehat) — **tidak** dipengaruhi `?filter=positive|neutral|negative`.
- `averageRating` sudah ada sebelumnya (counter denormalisasi profil).

---

## 6. Filter feed

`GET /v1/showcase/feed?...` — dua filter baru (filter lama `minPrice`/`maxPrice`
tetap: irisan rentang harga seperti sebelumnya):

| Param | Nilai | Arti |
|---|---|---|
| `condition` | `baru` \| `bekas` | Kondisi barang (case-insensitive) |
| `minSellerRating` | `0`–`5` (desimal boleh, mis. `4.0`) | Hanya item yang `averageRating` pemilik ≥ nilai |

- Enum kondisi (Prisma `ShowcaseCondition`): **`BARU`** = barang baru,
  **`BEKAS`** = barang bekas/second. Kolom nullable — item lama tanpa kondisi
  tetap muncul bila filter tidak dipakai.
- `POST /v1/users/me/showcase` & `PUT …` menerima `"condition": "baru"|"bekas"`
  (opsional; respons etalase menyertakan `condition: "BARU"|"BEKAS"|null`).
- `minSellerRating`: `averageRating` pemilik adalah kolom non-nullable (default 0),
  jadi `minSellerRating=0` tidak memfilter apa pun. Berlaku untuk semua `sort`
  (latest/popular/foryou).
