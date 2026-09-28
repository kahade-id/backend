# Wave 2 — Catatan Performa (2026-09-28)

## Metodologi & batasan (jujur)

- **Tidak ada pengukuran HTTP p95.** Mesin kerja tidak memiliki PostgreSQL/Redis
  aktif (`pg_isready` gagal, tidak ada port 5432/6379, repo hanya punya
  `.env.example`), dan tidak ada akses DB staging dari sesi ini. Angka latensi
  apa pun yang diklaim tanpa DB adalah fiksi — jadi tidak ada klaim angka.
- Yang dilakukan: **audit statis N+1 / query berlebih** pada jalur baca panas
  (feed showcase, komentar, notifikasi, search, chat, order, wallet) dengan
  pemindaian `await` di dalam loop + inspeksi manual jalur yang dicurigai.
- Untuk kode BARU di Wave 2, pola query dirancang hemat sejak awal (paralel,
  keyset, agregasi di SQL) — tidak ada "before" yang lambat untuk
  dibandingkan karena endpointnya baru.

## Temuan: tidak ada N+1 baru di jalur panas

Jalur yang diperiksa sudah dalam kondisi baik (sebagian besar dirapikan pada
gelombang audit sebelumnya):

| Jalur | Pola | Status |
|---|---|---|
| `getFeed` (latest/popular) — `showcase.service.ts:1399` | keyset pagination `(createdAt,id)` / `(hotViews,createdAt,id)`, `take: limit+1`, **tanpa `COUNT(*)` per scroll** | OK |
| `getForYouFeed` — `showcase.service.ts:1602` | 3 pool kandidat paralel, skor in-memory | OK |
| `serializeFeedPage` — `showcase.service.ts:1746` | `likedIds`/`savedIds`/`badgeMap`/`followedAuthorIds` masing-masing **1 batch query** per halaman | OK |
| Komentar + balasan — `showcase.service.ts:2211` | `groupBy` reply-count + `Promise.all` fetch balasan paralel + 1 batch seal-tier | OK |
| `listNotifications` — `notifications.service.ts:159` | `findMany` + `count` paralel | OK |
| `getUnreadCount` | `groupBy` kategori tunggal | OK |
| Search | raw SQL + `blockExclusionSql` (tanpa muat ribuan id ke payload) | OK |
| Scan 302 `await`-dalam-loop di semua `*.service.ts` | semuanya retry-loop (`attempt <= 3`), cron job, atau operasi tulis sekuensial yang memang harus berurutan | bukan N+1 baca |

## Yang diubah di Wave 2 (arah benar, belum terukur)

1. `getShippingReconciliation` (`courier.service.ts`): versi pertama memuat
   **seluruh** shipment ber-`actualCost` ke aplikasi lalu filter/paginasi
   in-memory. Diubah menjadi 2 query SQL paralel (`COUNT(*)` + page dengan
   `diff = actualCost − estimatedCost` dihitung di DB, `onlyMismatch` sebagai
   klausa `WHERE`). Kompleksitas per request: O(total tabel) → O(limit).
2. `listAdminProviders`: 2 query DB (`courierRegionFlag.findMany`,
   `courierService.groupBy`) dari sekuensial → `Promise.all`.
3. `listAdminShipments`: `count` + `findMany` paralel sejak awal.

## Sisa kerja performa (butuh DB)

- Ukur p95 riil endpoint di atas + feed/komentar di staging dengan data
  volume produksi (seed ≥10k shipment/showcase) sebelum klaim angka.
- Pertimbangkan indeks komposit `("actualCost")` parsial `WHERE "actualCost"
  IS NOT NULL` bila tabel shipments besar dan halaman rekonsiliasi lambat
  (keputusan setelah ada data `EXPLAIN ANALYZE`).
