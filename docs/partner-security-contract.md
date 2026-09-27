# Kontrak Keamanan Partner API & Webhook (G474)

> Kontrak keamanan mengikat untuk semua pengguna Kahade Public Partner API
> dan webhook keluar. Pelanggaran oleh mitra dapat berujung pada suspensi
> atau pencabutan akses (lihat § Penegakan).

## 1. Kredensial

1. **API key tampil sekali saja** — saat diterbitkan atau dirotasi oleh admin.
   Kahade menyimpan **hanya hash scrypt** (`$scrypt$N=32768,r=8,p=1$...`);
   plaintext tidak pernah disimpan di database, log, maupun audit trail.
2. **Webhook secret terenkripsi** AES-GCM di database dan tidak pernah
   di-return oleh API mana pun (admin maupun partner).
3. **Rotasi**: mitra disarankan merotasi key tiap ≤ 90 hari. Rotasi memberi
   jendela overlap **24 jam** di mana key lama dan key baru sama-sama valid
   (`validUntil`); setelah itu key lama otomatis tidak valid.
4. **Revoke instan**: admin dapat mencabut key kapan saja dengan alasan wajib
   (`revokeReason`); pencabutan berlaku seketika di semua guard, dan tercatat
   di `PartnerAuditLog` (`KEY_REVOKED`).
5. **Lingkungan terpisah**: key `kh_live_*` ≠ key `kh_sandbox_*`. Key sandbox
   hanya membuka `/v1/partner-sandbox/*` (data sintetis) dan **tidak pernah**
   menyentuh saldo atau data produksi.

## 2. Transport & anti-SSRF

1. API hanya dilayani via **HTTPS**.
2. URL webhook mitra wajib **HTTPS, port 443, tanpa kredensial di URL**.
3. Sebelum disimpan/diuji, hostname di-**resolve via DNS** dan **setiap IP
   hasil resolve** dicek terhadap rentang yang diblokir: private (`10/8`,
   `172.16/12`, `192.168/16`), loopback (`127/8`, `::1`), link-local
   (`169.254/16` — termasuk metadata cloud `169.254.169.254`), CGNAT
   (`100.64/10`), multicast, reserved, TEST-NET, dan hostname metadata
   (`metadata.google.internal`, dsb.). IP literal private langsung ditolak.
4. **`PARTNER_EGRESS_ALLOWLIST`** (env, opsional): daftar CIDR
   dipisah koma, mis. `PARTNER_EGRESS_ALLOWLIST=203.0.113.0/24,198.51.100.8/32`.
   Bila diset, hanya alamat dalam daftar yang boleh menjadi target webhook.
   Prosedur perubahan: ajukan ke tim platform → verifikasi kepemilikan CIDR
   oleh mitra → update env di `/var/www/kahade/apps/backend/.env` → `pm2 reload kahade-api`
   → uji `webhook.test` → catat di `PartnerAuditLog` (`EGRESS_ALLOWLIST_UPDATED`).
5. Redirect HTTP **tidak diikuti** oleh dispatcher webhook.

## 3. Integritas & anti-replay (G465)

Setiap delivery webhook membawa:

- `X-Kahade-Signature`: HMAC-SHA256 hex atas string
  `timestamp + "." + eventId + "." + rawBody`, dengan kunci = secret endpoint.
- `X-Kahade-Timestamp`: epoch millis saat pengiriman.
- `X-Kahade-Event-Id`: UUID unik per event — **idempotency key**.

Kewajiban penerima (mitra):

1. Hitung ulang signature dengan **perbandingan constant-time**; tolak bila
   tidak cocok.
2. **Tolak bila `|now - timestamp| > 5 menit`** (jendela anti-replay).
3. **Simpan `eventId` yang sudah diproses** (mis. 24–72 jam) dan abaikan
   duplikat — retry Kahade dan replay manual memakai `eventId` yang sama
   sehingga aman untuk diproses idempoten.
4. Jangan percaya field `version`/`eventType` sebelum signature valid.

Kahade menjamin: satu `eventId` tidak pernah dipakai ulang untuk event berbeda.

## 4. Rate limit, kuota, dan penyalahgunaan

- Default **100 req/menit** per client+endpoint dan **10.000 req/hari** per client;
  dapat diperketat/dilonggarkan per client oleh admin.
- Kelebihan → `429` + header `Retry-After` (detik).
- Pola trafik abnormal (spike 10× baseline, sapuan ID berurutan) memicu review
  manual dan dapat berujung suspensi sementara (`SUSPENDED`).

## 5. Data & privasi

- Lihat larangan di `docs/partner-api-product.md` §3: **tanpa PII pihak lain,
  tanpa PIN/password/OTP, tanpa saldo siapa pun, tanpa mutasi dana**.
- Delivery log di portal **tereduksi**: hanya `responseCode` + pesan error
  tanpa body respons mitra (G468).

## 6. Penghapusan client & retensi

1. Pencabutan client (`REVOKED`) menonaktifkan seluruh key dan endpoint seketika;
   pengiriman webhook yang tertunda dibatalkan.
2. Penghapusan permanen client menghapus cascade: key, endpoint, delivery,
   usage harian.
3. `PartnerAuditLog` dipertahankan untuk kebutuhan forensik sesuai kebijakan
   retensi perusahaan (tidak ikut terhapus bersama client).
4. Mitra wajib menghapus API key dan webhook secret dari sistemnya maksimal
   **7 hari** setelah kontrak berakhir.

## 7. Insiden

1. Bila mitra mencurigai kebocoran key/secret: hubungi tim platform segera;
   admin akan **revoke instan** dan menerbitkan key baru (rotasi darurat tanpa
   menunggu overlap bila diminta).
2. Bila Kahade mendeteksi anomali dari sisi platform (mis. pola akses tidak
   wajar), client dapat di-`SUSPENDED` terlebih dahulu, lalu mitra diberi tahu
   maksimal 1×24 jam.
3. Setiap insiden dicatat di `PartnerAuditLog` dan ditinjau dalam review
   keamanan berkala.

## 8. Penegakan

Pelanggaran kontrak ini — termasuk mem-bypass verifikasi signature, membagikan
key ke pihak ketiga, atau mencoba mengakses data di luar scope — berakibat
peringatan tertulis, suspensi, hingga pencabutan permanen akses Partner API.

---
Referensi: `docs/partner-api-product.md`, `docs/partner-api-v1.md` /
`docs/partner-api-v1.en.md`, `docs/partner-webhook-changelog.md`.
