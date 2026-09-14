# Audit Fitur & Modul Backend — Kahade

**Lingkup:** NestJS 11 + Prisma 5 + PostgreSQL, 69 model, ~30 modul (`src/modules/*`).
**Metodologi:** pembacaan langsung source code (controller, service, DTO, schema Prisma) — bukan asumsi/template generik. Setiap temuan di bawah tertaut ke file/fungsi spesifik yang diperiksa.
**Fokus:** kelengkapan fitur, UX flow, edge case, dan konsistensi antar modul — bukan celah keamanan dasar (area itu sudah terlihat melalui banyak ronde audit sebelumnya, ditandai komentar `AUDIT-XX`/`B-XX` di kode).
**Catatan kejujuran cakupan:** ini bukan review baris-per-baris dari seluruh 793 file. Modul inti (Auth, Orders, Wallet, Chat, Disputes, KYC, Notifications, Admin) diperiksa mendalam; modul lain diperiksa di level controller/DTO/service kunci. Beberapa sudut yang lebih niche (mis. detail penuh Campaigns, Realtime edge case) belum tuntas 100%.

**Total temuan improvement: 51.** Daftar bug terpisah di bagian paling akhir.

---

## 1. AUTH

### 1.1 Verifikasi email — dead-end kalau app belum terinstal
**Lokasi:** `GET /auth/verify-email` (`auth.controller.ts`)
**Kondisi saat ini:** endpoint merender halaman HTML sukses dengan tombol yang membuka custom scheme `kahade://email-verified`.
**Kenapa perlu di-improve:** kalau link dibuka di device/browser tanpa app terinstal, tombol itu tidak melakukan apa-apa — user terjebak di halaman "berhasil" tanpa jalan lanjut. Ini skenario umum (link dibagikan ulang, dibuka di desktop, dsb).
**Saran:** fallback ke Play Store/App Store, atau manfaatkan universal link (`assetlinks.json` sudah ada) saat custom scheme gagal terbuka.

### 1.2 Tidak ada social login
**Lokasi:** `auth.controller.ts` — hanya phone-OTP & email/password (yang terakhir off by default).
**Kenapa perlu di-improve:** opsional (phone-OTP sudah cukup kredibel untuk platform finansial), tapi social login lazim dipakai kompetitor untuk turunkan friksi onboarding.
**Saran:** pertimbangkan sebagai opsi tambahan, prioritas rendah.

---

## 2. ORDER / ESCROW

### 2.1 Tidak ada lampiran referensi saat create order
**Lokasi:** `CreateOrderDto` (`modules/orders/dto/create-order.dto.ts`)
**Kondisi saat ini:** field yang ada hanya title, description, orderType, orderValue, deliveryDeadlineDays, feeResponsibility, voucherCode — tidak ada `attachments`.
**Kenapa perlu di-improve:** untuk order custom (jasa desain, barang custom), spesifikasi visual penting. User harus kirim gambar lewat chat terpisah setelah order dibuat, sehingga gambar acuan order gampang tercecer dari histori chat, tidak terikat ke record order.
**Saran:** tambahkan field lampiran opsional saat create order.

### 2.2 Filter riwayat order tidak ada rentang tanggal
**Lokasi:** `GetOrdersQueryDto` (`modules/orders/dto/get-orders-query.dto.ts`)
**Kondisi saat ini:** filter hanya `status`, `role`, `search`, `page`, `limit`. Modul Wallet (`/wallet/transactions`, `/wallet/topup-history`, `/wallet/withdraw-history`) sudah punya filter `from`/`to`.
**Kenapa perlu di-improve:** user yang ingin lihat "order bulan lalu" atau butuh riwayat untuk pembukuan tidak bisa — inkonsistensi API antar modul yang mirip fungsinya.
**Saran:** samakan pola filter tanggal seperti di Wallet.

### 2.3 Tidak ada opsi sorting di riwayat order
**Lokasi:** sama seperti 2.2.
**Kenapa perlu di-improve:** user tidak bisa urutkan berdasarkan nilai order atau deadline terdekat, hanya urutan default.
**Saran:** tambahkan `sortBy`/`sortOrder`.

### 2.4 Ambang KYC dicek per-transaksi, bukan akumulatif
**Lokasi:** `orders.service.ts` — pengecekan `dto.orderValue >= KYC_THRESHOLD_IDR`.
**Kondisi saat ini:** KYC wajib kalau **satu** order ≥ Rp 2.000.000. Tidak ada pengecekan akumulasi nilai order per periode untuk user yang belum KYC.
**Kenapa perlu di-improve:** secara teori user bisa memecah transaksi besar jadi beberapa order kecil di bawah ambang untuk menghindari KYC (structuring) — relevan untuk platform escrow finansial.
**Saran:** tambahkan monitoring akumulasi nilai transaksi per user per periode sebagai lapisan tambahan.

### 2.5 Status `EXPIRED` pada permintaan perpanjangan deadline tidak pernah dieksekusi
**Lokasi:** enum `DeadlineExtensionStatus` di schema; `order-extensions.service.ts`.
**Kondisi saat ini:** value `EXPIRED` ada di enum, tapi digrep di seluruh codebase — tidak pernah di-set di manapun (hanya `PENDING`/`APPROVED`/`REJECTED` yang benar-benar dipakai), dan tidak ada scheduler job yang menanganinya.
**Kenapa perlu di-improve:** kalau pihak lawan mendiamkan permintaan perpanjangan deadline, permintaan itu menggantung selamanya sebagai PENDING — tidak jelas nasib order-nya, berpotensi dana macet tanpa resolusi otomatis.
**Saran:** tambahkan job yang meng-auto-expire extension request yang tidak direspons, dengan default behavior yang jelas.

### 2.6 Room chat INQUIRY tidak tertaut ke Order yang lahir darinya
**Lokasi:** model `ChatRoom` (`orderId` unique+nullable, INQUIRY selalu null) & `CreateOrderDto` (tidak ada `inquiryRoomId`).
**Kondisi saat ini:** negosiasi pra-transaksi terjadi di room INQUIRY; begitu order dibuat, room ORDER baru dibuat terpisah total tanpa referensi ke room INQUIRY asal.
**Kenapa perlu di-improve:** konteks negosiasi (harga, spesifikasi yang disepakati) hilang begitu transaksi benar-benar dimulai — user harus ulang jelaskan atau bolak-balik dua thread chat berbeda.
**Saran:** simpan referensi `sourceInquiryRoomId` pada order/room baru, atau auto-archive+link room INQUIRY begitu order dibuat.

---

## 3. WALLET

### 3.1 Top-up minta PIN wallet tapi backend tidak pernah memverifikasinya
**Lokasi:** `TopupDto` (`modules/wallet/dto/topup.dto.ts`) — bahkan sudah diakui lewat komentar developer di file itu sendiri.
**Kondisi saat ini:** mobile mengumpulkan PIN 6 digit sebelum submit top-up, dikirim ke backend, tapi tidak pernah diverifikasi (top-up sudah diamankan lewat auth payment gateway/3DS/OTP bank).
**Kenapa perlu di-improve:** user mengalami friksi ekstra tanpa manfaat keamanan apapun — murni cost UX.
**Saran:** hapus prompt PIN dari flow top-up di mobile, atau verifikasi betulan di backend kalau memang mau dipertahankan.

### 3.2 Tiga endpoint export dengan format respons tidak konsisten
**Lokasi:** `GET /wallet/export`, `/wallet/export/csv`, `/wallet/export/pdf`.
**Kondisi saat ini:** `/export` men-stream file asli dengan header `Content-Disposition`. `/export/csv` return JSON `{csv, filename}` — bukan file, klien harus konversi manual. `/export/pdf` return JSON `{html, filename}` — isinya HTML, bukan PDF, meski nama endpoint & filename bilang "pdf".
**Kenapa perlu di-improve:** frontend harus menangani 3 cara berbeda untuk kasus yang konsepnya sama ("unduh laporan"); endpoint "pdf" yang isinya HTML berpotensi membingungkan.
**Saran:** satukan jadi satu pola respons (file stream + header download), atau generate PDF asli di backend.

### 3.3 Tidak ada saved/favorite recipient untuk transfer
**Lokasi:** `wallet.controller.ts` (`transfer`, `transfer/lookup`).
**Kondisi saat ini:** sudah ada pola search-lalu-konfirmasi (`lookup`) sebelum transfer, tapi tidak ada cara menyimpan kontak yang sering ditransfer.
**Kenapa perlu di-improve:** transfer berulang ke orang yang sama (split bill rutin, kirim uang keluarga) harus cari/masukkan ulang identifier penerima setiap kali.
**Saran:** tambahkan daftar kontak tersimpan/favorit untuk transfer cepat.

### 3.4 `SetPinDto.password` ditandai optional meski deskripsi bilang wajib
**Lokasi:** `modules/wallet/dto/wallet-pin.dto.ts`.
**Kondisi saat ini:** deskripsi API bilang "wajib saat ganti PIN", tapi decorator validasi menandainya `@IsOptional()`.
**Kenapa perlu di-improve:** skema OpenAPI/Swagger yang dihasilkan akan menampilkan field ini sebagai optional — developer frontend/SDK generator yang mengandalkan kontrak ini bisa salah asumsi dan tidak mengirim field wajib tsb.
**Saran:** kalau validasi kondisionalnya memang di service layer, tambahkan custom validator supaya tercermin akurat di schema.

---

## 4. WITHDRAWALS

### 4.1 Modul "Withdrawals" tidak berisi aksi withdraw yang sebenarnya
**Lokasi:** `withdrawals.controller.ts` vs `wallet.controller.ts`.
**Kondisi saat ini:** `/withdrawals/*` cuma untuk CRUD jadwal penarikan rutin (scheduled withdrawal). Aksi withdraw manual (`withdraw`, `confirm-otp`, `resend-otp`, `cancel`, `withdraw-history`) ada di `/wallet/*`.
**Kenapa perlu di-improve:** penamaan modul menyesatkan — siapapun yang mencari "endpoint tarik dana" wajar mengira ada di Withdrawals.
**Saran:** rename modul jadi `scheduled-withdrawals`, atau pindahkan semua fungsi withdraw ke sana.

---

## 5. KYC

### 5.1 Hanya menerima KTP — tidak ada dokumen alternatif untuk WNA
**Lokasi:** `SubmitKycDto` (`modules/kyc/dto/submit-kyc.dto.ts`) — field wajib NIK 16 digit.
**Kenapa perlu di-improve:** WNA yang mau pakai platform tidak punya jalur verifikasi (tidak ada opsi paspor). Kalau memang disengaja WNI-only, sebaiknya dikomunikasikan eksplisit, bukan cuma "field wajib NIK" yang gagal validasi.
**Saran:** tambah jalur paspor untuk akun non-WNI, atau perjelas positioning produk.

### 5.2 Tidak ada liveness check / foto pegang KTP
**Kondisi saat ini:** dua upload independen (`ktpFileKey`, `selfieFileKey`), tanpa liveness detection atau foto gabungan pegang KTP.
**Kenapa perlu di-improve:** pola ini lebih rentan disalahgunakan (submit foto KTP orang lain + selfie statis terpisah) dibanding platform sejenis yang mewajibkan liveness.
**Saran:** tambahkan liveness check sederhana atau foto pegang KTP sebagai lapisan anti-fraud.

### 5.3 Konstanta `MAX_KYC_ATTEMPTS` terduplikasi
**Lokasi:** `kyc.service.ts` baris ~190 (submit) dan ~355 (resubmit), masing-masing `= 10`.
**Kenapa perlu di-improve:** bukan bug aktif, tapi risiko maintenance — kalau limit diubah, mudah lupa update salah satu lokasi sehingga submit vs resubmit jadi tidak konsisten.
**Saran:** ekstrak jadi satu konstanta bersama.

---

## 6. BUSINESS VERIFICATION

### 6.1 Tidak ada limit percobaan resubmit (tidak seperti KYC)
**Lokasi:** `business-verification.service.ts` — di-grep untuk `MAX_ATTEMPTS`/`maxAttempts`, nihil hasil. Bandingkan dengan KYC yang eksplisit `MAX_KYC_ATTEMPTS = 10`.
**Kenapa perlu di-improve:** dua flow verifikasi yang strukturnya nyaris identik (submit → review → approve/reject → resubmit) punya kebijakan anti-abuse yang berbeda tanpa alasan jelas — berpotensi celah spam-submission di jalur Business Verification.
**Saran:** terapkan limit yang sama/konsisten seperti KYC, atau dokumentasikan kenapa berbeda.

---

## 7. NOTIFIKASI

### 7.1 Preferensi notifikasi tidak konsisten cakupan channel per kategori
**Lokasi:** `UpdatePreferencesDto` (`modules/notifications/dto/`).
**Kondisi saat ini:** kategori Order/Wallet/Security/Dispute punya toggle InApp+Push+Email lengkap. Kategori Chat & Ranking hanya InApp+Push (tanpa Email). Kategori Marketing cuma punya toggle Email (tanpa InApp/Push).
**Kenapa perlu di-improve:** user tidak punya kendali granular yang sama di semua kategori — tidak bisa matikan push promosi secara spesifik, padahal ini sering jadi concern kepatuhan (UU PDP).
**Saran:** samakan struktur toggle di semua kategori, atau dokumentasikan alasan bila memang disengaja.

### 7.2 Channel `WHATSAPP`/`SMS` terdaftar di enum tapi tidak pernah dipakai
**Lokasi:** enum `NotificationChannel` vs implementasi di `modules/notifications/` & `modules/queue/` (di-grep, nihil pemakaian di luar OTP yang pakai sistem terpisah).
**Kenapa perlu di-improve:** untuk notifikasi kritikal (dispute diputuskan, penarikan berhasil), kalau push gagal terkirim (device lama, battery optimization), tidak ada fallback SMS/WA meski skema data sudah disiapkan untuk itu.
**Saran:** implementasikan fallback SMS/WhatsApp untuk kategori kritikal, atau bersihkan enum yang tidak dipakai.

### 7.3 Tidak ada quiet hours / do-not-disturb
**Kenapa perlu di-improve:** notifikasi non-kritikal (follower baru, badge, promosi) tetap bisa mem-buzz HP user tengah malam, kontras dengan preferensi lain yang sudah sangat granular.
**Saran:** tambahkan jadwal quiet-hours per user, dengan pengecualian kategori kritikal.

### 7.4 Preferensi bahasa (id/en) tidak benar-benar dipakai untuk lokalisasi konten
**Lokasi:** `settings.service.ts` (`getLanguage`/`updateLanguage`) vs `src/templates/email/*.hbs` & `modules/queue/processors/notification.processor.ts`.
**Kondisi saat ini:** user bisa set `PUT /settings/language` ke `en`. Tapi seluruh 20+ template email hardcoded Bahasa Indonesia (tidak ada folder `en/`), tidak ada library i18n di `package.json`, dan field `language` di job notifikasi cuma disimpan sebagai metadata/log — tidak dipakai memilih versi konten.
**Kenapa perlu di-improve:** user yang eksplisit set preferensi ke English tetap menerima semua email/notifikasi dalam Bahasa Indonesia — setting yang secara fungsional tidak melakukan apa yang dijanjikan namanya.
**Saran:** implementasikan template multi-bahasa, atau untuk sementara nonaktifkan opsi "en" di pengaturan sampai infrastrukturnya siap agar tidak menyesatkan user.

---

## 8. DISPUTE

### 8.1 Tidak ada kategori/alasan terstruktur untuk dispute
**Lokasi:** `SubmitDisputeDto.claim` — free text (min 20, max 2000 karakter). Dicek juga di schema — tidak ada `DisputeReason`/`DisputeCategory`.
**Kenapa perlu di-improve:** admin tidak bisa triase/filter dispute berdasarkan penyebab, tidak ada analitik pola penyebab dispute — padahal model `Dispute` sudah punya SLA tracking (`slaHours`, `isSlaBreached`) yang menunjukkan tim sudah peduli operasional dispute.
**Saran:** tambahkan field kategori terstruktur saat submit dispute (lihat juga §11.1 — pola ini berulang di beberapa modul).

### 8.2 Evidence dispute tidak bisa berupa video
**Lokasi:** `SubmitDisputeDto.fileTypes` hanya `image/jpeg, image/png, image/webp, application/pdf`. Bandingkan dengan Chat yang mendukung video & voice note.
**Kenapa perlu di-improve:** bukti terkuat untuk dispute barang rusak/salah kirim seringkali video (unboxing). User terpaksa kirim lewat chat biasa, bukan sebagai evidence resmi di record dispute.
**Saran:** izinkan video (dengan limit durasi/ukuran) sebagai tipe evidence.

### 8.3 Tidak ada eskalasi manual dari sisi user
**Kondisi saat ini:** dari seluruh endpoint dispute (my, detail, evidence, claim, messages, call, mutual-resolution) tidak ada aksi "eskalasi ke admin sekarang" — eskalasi murni berbasis waktu lewat cron `auto-escalate-disputes`.
**Kenapa perlu di-improve:** user yang merasa proses berlarut-larut tidak punya cara aktif meminta perhatian lebih cepat.
**Saran:** tambahkan tombol eskalasi manual dengan rate limit wajar.

---

## 9. RATINGS

### 9.1 Tidak ada endpoint hapus rating milik sendiri
**Lokasi:** `ratings.controller.ts` — rute: create, get my, update, reply, update/delete reply. Tidak ada `DELETE /ratings/:ratingId`.
**Kenapa perlu di-improve:** user yang salah ketik/menyesal memberi rating tidak punya cara self-service menghapusnya, harus lewat support.
**Saran:** tambahkan delete (dalam window waktu terbatas, konsisten dengan `EDIT_WINDOW_DAYS` yang sudah ada untuk edit).

### 9.2 Tidak ada fitur "helpful/like" pada rating
**Kenapa perlu di-improve:** Showcase (post sosial) sudah punya like, tapi Ratings — yang jauh lebih krusial untuk keputusan transaksi user lain — tidak punya cara menandai ulasan paling membantu.
**Saran:** tambahkan helpful-vote sederhana pada rating.

---

## 10. BANK ACCOUNTS

### 10.1 Tidak bisa edit rekening bank tersimpan
**Lokasi:** `bank-accounts.controller.ts` — rute hanya list, create, set-primary, delete. Tidak ada update.
**Kenapa perlu di-improve:** kalau user salah ketik nama pemilik rekening, satu-satunya jalan hapus lalu tambah ulang.
**Saran:** tambahkan endpoint update (dengan re-verifikasi kalau field sensitif seperti nomor rekening berubah).

---

## 11. SUBSCRIPTIONS

### 11.1 Tidak ada jalur langsung ganti paket (upgrade/downgrade)
**Lokasi:** `subscriptions.service.ts::subscribe()` — eksplisit melempar `SUBSCRIPTION_ALREADY_ACTIVE` ("use renew instead") kalau user sudah punya subscription aktif.
**Kenapa perlu di-improve:** user yang mau upgrade/downgrade paket harus cancel dulu (berpotensi kehilangan sisa masa aktif tanpa proration jelas), baru subscribe ulang.
**Saran:** tambahkan jalur switch-plan dengan proration yang transparan ke user.

---

## 12. REFERRAL & VOUCHERS

### 12.1 User tidak tahu sisa kuota kode referralnya
**Lokasi:** `referral.service.ts::getStats()` — return `totalReferrals`, `successfulReferrals`, `totalRewardEarned`, `pendingRewardCount`, tidak ada `remainingSlots` meski ada hard limit `MAX_REFERRALS_PER_CODE` (default 100).
**Kenapa perlu di-improve:** kode referral power-user bisa tiba-tiba berhenti bekerja begitu limit tercapai tanpa peringatan — orang yang direferensikan pun gagal apply tanpa tahu sebabnya.
*(Catatan positif: logic anti-fraud referral-nya sendiri — cegah self-referral, circular-referral, reward baru cair setelah transaksi pertama selesai — sudah cukup matang.)*
**Saran:** expose sisa kuota di response stats + notifikasi saat mendekati limit.

---

## 13. SEARCH

### 13.1 Pencarian global terfragmentasi
**Lokasi:** `search.controller.ts` — `ALLOWED_SEARCH_TYPES` cuma `users`, `orders`, `transactions`. Tidak mencakup Showcase & Help Center (yang masing-masing punya search sendiri terpisah).
**Kenapa perlu di-improve:** user harus tahu dan berpindah search bar berbeda tergantung apa yang dicari — pengalaman pencarian tidak terpusat.
**Saran:** satukan jadi satu endpoint dengan hasil terkategori, atau minimal beri sinyal "coba cari di Help Center" saat hasil utama kosong.

---

## 14. SUPPORT & HELP CENTER

### 14.1 Tidak ada close/reopen/rating kepuasan tiket dari sisi user
**Lokasi:** `support.controller.ts` — hanya list, create, detail, reply. Lifecycle status (`OPEN → IN_PROGRESS → RESOLVED → CLOSED`) sepenuhnya dikontrol admin.
**Kenapa perlu di-improve:** user yang masalahnya selesai sendiri tidak bisa menutup tiketnya; tidak ada CSAT pasca-resolusi sehingga tim support tidak dapat sinyal kualitas jawaban.
**Saran:** tambahkan aksi close mandiri + rating kepuasan singkat.

### 14.2 Tiket support tidak tertaut ke artikel Help Center yang relevan
**Lokasi:** `CreateTicketDto` — field: subject, message, category, orderId, attachments. Tidak ada `relatedArticleId`.
**Kenapa perlu di-improve:** tim tidak bisa lihat "user ini sudah baca FAQ X tapi tetap bikin tiket" — sinyal berharga untuk tahu FAQ mana yang gagal menjawab pertanyaan, hilang begitu saja.
**Saran:** kirim `relatedArticleId` opsional dari client saat create ticket (kalau user datang dari halaman artikel).

### 14.3 Artikel Help Center tidak punya feedback "apakah ini membantu?"
**Lokasi:** `help-center.controller.ts` — hanya `categories`, `categories/:slug`, `search`, `items/:id/view` (view tracking saja).
**Kenapa perlu di-improve:** tim konten tahu artikel mana yang DILIHAT, tapi tidak tahu artikel mana yang benar-benar MENYELESAIKAN masalah user — artikel bisa banyak dilihat tapi tidak efektif, dan itu tidak akan terlihat dari data yang ada.
**Saran:** tambahkan feedback helpful/not-helpful sederhana per artikel.

---

## 15. CHAT

### 15.1 Edit pesan tanpa batas waktu & tanpa riwayat versi lama
**Lokasi:** `chat.service.ts::editMessage()`.
**Kondisi saat ini:** hal yang sudah bagus — pesan otomatis terkunci total (tidak bisa edit/hapus) begitu order berstatus DISPUTED, melindungi integritas bukti selama sengketa aktif. Tapi SEBELUM dispute dibuka, pesan teks bisa diedit kapan saja tanpa batas waktu, hanya menyimpan flag `isEdited: true` tanpa histori isi sebelumnya.
**Kenapa perlu di-improve:** kalau dispute baru dibuka SETELAH pesan penting sempat diedit, isi aslinya hilang permanen — cuma tersisa flag "sudah diedit" tanpa detail apa yang berubah.
**Saran:** simpan histori versi pesan (bukan cuma boolean), dan/atau beri batas waktu edit wajar (mis. 15 menit).

### 15.2 Tidak ada tipe pesan VIDEO meski attachment video diizinkan
**Lokasi:** `UserChatMessageType` enum hanya `TEXT, IMAGE, FILE, VOICE` — padahal MIME type video (`video/mp4`, `video/quicktime`, `video/webm`) termasuk yang diizinkan diunggah.
**Kenapa perlu di-improve:** video terpaksa dikirim dengan `messageType: FILE`, kemungkinan besar tampil sebagai ikon dokumen generik di client, bukan player video inline.
**Saran:** tambahkan `VIDEO` sebagai messageType tersendiri.

### 15.3 Tidak ada caption untuk pesan gambar/file
**Lokasi:** `send-message.dto.ts` — tidak ada field `caption` terpisah dari `content`.
**Kenapa perlu di-improve:** pola umum di aplikasi chat modern (WhatsApp, Telegram) adalah kirim gambar + teks penjelasan dalam satu pesan. Di sini user harus kirim dua pesan terpisah (gambar, lalu teks), yang bisa membuat konteks "gambar ini menjelaskan apa" jadi ambigu terutama di chat yang aktif.
**Saran:** izinkan `content` terisi bersamaan dengan attachment sebagai caption (kalau belum didukung secara implisit).

---

## 16. SHOWCASE

### 16.1 Tidak ada mekanisme report per-post
**Lokasi:** `showcase.controller.ts` — di-grep untuk "report", nihil hasil. Hanya ada `users/:userId/report` (report akun secara keseluruhan).
**Kenapa perlu di-improve:** kalau ada showcase post spesifik yang melanggar, user cuma bisa report akunnya secara umum, bukan flag post yang bermasalah — admin kehilangan konteks apa yang sebenarnya jadi masalah, kontras dengan Chat yang sudah punya `moderation-events` terstruktur.
**Saran:** tambahkan `POST showcase/:id/report`.

---

## 17. UPLOAD

### 17.1 Tidak ada pemindaian virus/malware
**Kondisi saat ini:** validasi upload sudah sangat matang dari sisi ukuran & tipe file (termasuk verifikasi `ContentLength` aktual di S3 untuk cegah bypass), tapi di-grep untuk "virus/malware/clamav/scan" di seluruh codebase — nihil.
**Kenapa perlu di-improve:** platform menerima upload dari banyak sumber sensitif (dokumen KYC, evidence dispute, lampiran chat & tiket support) yang nantinya dibuka pihak lain (admin, counterpart). File berbahaya yang lolos validasi tipe/ukuran tetap bisa diunduh & dibuka orang lain.
**Saran:** tambahkan content-scanning (ClamAV atau layanan pihak ketiga) sebelum file dianggap "confirmed".

---

## 18. PROFIL / USERS / SETTINGS

### 18.1 Trust score tidak ada breakdown faktor
**Lokasi:** `GET users/me/trust-score` cuma return `{ score, badge }`. `calculateTrustScore()` sendiri menghitung dari 8 faktor (order selesai/dibatalkan/disputed, rating rata-rata, jumlah rating, status KYC, status Kahade+, umur akun).
**Kenapa perlu di-improve:** user tidak tahu kenapa skornya segitu atau apa yang bisa diperbaiki — mirip masalah skor kredit yang opaque, memicu frustrasi kalau skor rendah tapi tidak actionable.
**Saran:** tambahkan breakdown per faktor + saran perbaikan konkret di response.

### 18.2 Fitur "report user" terduplikasi antara modul Users & Settings dengan perilaku berbeda
**Lokasi:** `POST /users/:userId/report` (rate limit 5×/**24 jam**, DTO `ReportUserDto`, evidence URL wajib domain CDN platform) vs `POST /settings/report` (rate limit 5×/**1 jam**, DTO `ReportUserSettingsDto` terpisah, evidence URL bebas domain HTTPS apa saja).
**Kenapa perlu di-improve:** ini dampaknya nyata — rate limit yang harusnya melindungi dari report-spam bisa dilewati begitu saja lewat endpoint Settings yang jendelanya 24× lebih longgar. Validasi evidence URL yang lebih longgar di Settings juga berarti admin yang meninjau laporan dari jalur ini bisa diarahkan klik link eksternal sembarangan.
**Saran:** satukan jadi satu implementasi (satu DTO, satu service, satu rate limit); deprecate salah satu endpoint. *(Lihat juga daftar bug di akhir dokumen.)*

### 18.3 Fitur "block user" terduplikasi dengan pola serupa
**Lokasi:** `POST/DELETE /users/:userId/block` vs `POST/DELETE /settings/block/:userId` — dua service terpisah, sementara daftar blocked-users (`GET blocked-users`) hanya ada di Settings.
**Kenapa perlu di-improve:** kalau nanti ada perubahan bisnis (mis. efek ke chat aktif saat blokir), risiko perubahan cuma diterapkan di satu jalur, bikin perilaku block tidak konsisten tergantung endpoint yang dipakai klien.
**Saran:** konsolidasi ke satu modul pemilik (disarankan Settings, karena sudah punya listing-nya).

### 18.4 "Sessions" dan "Users/me/devices" — dua tampilan keamanan yang tidak saling terhubung
**Lokasi:** `Sessions` module (model `UserSession`, login aktif yang bisa di-revoke) vs `Users/me/devices` (model `UserDevice` — tabel berbeda, histori perangkat & status trusted untuk 2FA).
**Kenapa perlu di-improve:** keduanya valid secara konsep tapi terpisah total di API. User yang mau memastikan "saya sudah logout total dari HP lama" harus cek dua tempat berbeda — revoke session tidak otomatis mengubah status trusted device terkait.
**Saran:** tampilkan referensi silang (device ini ↔ sesi aktifnya) di salah satu/kedua response.

---

## 19. ADMIN

### 19.1 Fraud escalation tidak benar-benar menotifikasi admin
**Lokasi:** `scheduler/services/fraud-challenge-escalation.service.ts` — komentar developer sendiri: *"Future enhancement: dispatch to all SUPER_ADMIN users"*.
**Kondisi saat ini:** pembayaran dengan status challenge/unknown yang menggantung >24 jam hanya `logger.error(...)` (masuk Sentry/log).
**Kenapa perlu di-improve:** dana user bisa menggantung tanpa keputusan, dan satu-satunya cara tim ops sadar adalah kalau ada yang aktif memantau Sentry — tidak ada notifikasi in-app/email aktif ke admin.
**Saran:** kirim notifikasi aktual ke admin SUPER_ADMIN saat threshold tercapai, sesuai yang sudah direncanakan di komentar tsb.

### 19.2 Tidak ada bulk actions di 17 sub-modul admin
**Kondisi saat ini:** di-grep "bulk" di seluruh controller admin (KYC, dispute, ratings, users, vouchers, dst) — nihil.
**Kenapa perlu di-improve:** admin yang review puluhan submission KYC/business-verification pending harus approve/reject satu-satu — beban operasional meningkat linear seiring pertumbuhan user.
**Saran:** tambahkan bulk-approve/reject minimal untuk antrian KYC & business verification.

### 19.3 Tidak ada fitur impersonation (login-as-user)
**Kenapa perlu di-improve:** saat user lapor "fitur X error di akun saya", admin/support tidak punya cara lihat langsung dari sudut pandang akun tsb — harus rekonstruksi dari log & query manual, memperlambat resolusi tiket.
**Saran:** tambahkan mode impersonation read-only dengan audit log ketat (siapa impersonate siapa, kapan, apa yang dilihat).

### 19.4 Admin analytics/dashboard/reports/finance tidak punya export CSV/Excel
**Kondisi saat ini:** dicek langsung ke source — tidak ada satupun endpoint unduh data di 4 modul ini.
**Kenapa perlu di-improve:** tim finance/ops yang butuh data untuk laporan bulanan harus copy-paste manual dari JSON API — kontras dengan modul Wallet (user-facing) yang justru sudah punya 3 opsi export.
**Saran:** tambahkan export CSV/XLSX minimal untuk finance summary & analytics overview.

### 19.5 Admin Campaigns — tidak bisa edit/pause, hanya activate/delete
**Lokasi:** `admin/campaigns/*.controller.ts` — rute: create, list, detail, activate, delete. Tidak ada update/pause.
**Kenapa perlu di-improve:** kalau campaign yang sudah jalan ternyata salah setting (mis. nominal diskon keliru), admin cuma bisa delete (destruktif, kehilangan data campaign) — tidak bisa pause sementara untuk perbaikan.
**Saran:** tambahkan update & pause/resume.

### 19.6 Analytics dibatasi SUPER_ADMIN saja meski ada role FINANCE_ADMIN dkk.
**Lokasi:** `admin-analytics.controller.ts` — `@AdminRoles('SUPER_ADMIN')`. Bandingkan dengan enum `AdminRole` yang punya 5 role granular: `SUPER_ADMIN`, `DISPUTE_ADMIN`, `KYC_ADMIN`, `FINANCE_ADMIN`, `CUSTOMER_SUPPORT`.
**Kenapa perlu di-improve:** modul RBAC-nya sendiri sudah dirancang granular per peran, tapi analytics (yang isinya termasuk data order/finance — hal yang relevan untuk peran FINANCE_ADMIN) malah dikunci total ke SUPER_ADMIN saja — jadi bottleneck operasional yang tidak konsisten dengan filosofi RBAC modul lain.
**Saran:** buka akses read-only analytics ke role terkait (FINANCE_ADMIN minimal), pertahankan SUPER_ADMIN untuk aksi sensitif lain.

### 19.7 `admin/analytics` dan `admin/dashboard` sama-sama punya `getUserGrowth` dengan hasil berbeda
**Lokasi:** `admin-analytics.service.ts::getUserGrowth()` mengelompokkan by `date_trunc('day', "createdAt")` (UTC/timezone database, tanpa konversi eksplisit). `dashboard.service.ts::getUserGrowth()` mengelompokkan by `("createdAt" AT TIME ZONE 'Asia/Jakarta')::date` (eksplisit dikonversi ke WIB).
**Kenapa perlu di-improve — ini bukan cuma soal kerapian kode:** metrik dengan nama sama ("pertumbuhan user per hari") akan menampilkan **angka berbeda** tergantung admin buka dari layar Analytics atau Dashboard, karena user yang daftar jam 2 pagi WIB (= 7 malam UTC hari sebelumnya) terhitung di TANGGAL BERBEDA di kedua laporan. Ini bisa bikin dua orang di tim ops dapat angka "signup hari ini" yang berbeda dan saling curiga data siapa yang salah.
**Saran:** satukan jadi satu implementasi/satu sumber kebenaran dengan timezone yang konsisten (disarankan Asia/Jakarta, sesuai konteks pasar). *(Juga masuk daftar bug di akhir dokumen — ini genuinely menghasilkan angka yang salah/kontradiktif, bukan cuma fitur yang kurang.)*

---

## 20. LINTAS MODUL / POLA YANG BERULANG

### 20.1 Free-text vs enum terstruktur — tidak konsisten diterapkan
**Bukti:** `RejectKycDto.reason` free text; `SubmitDisputeDto.claim` free text — sementara `CancelOrderDto.reason` di modul Orders justru sudah pakai enum terstruktur (`OrderCancelReason` dengan value spesifik seperti `TIMEOUT_PAYMENT`, `CHANGED_MIND`, dst).
**Kenapa perlu di-improve:** ini bukan soal satu modul — ini pola desain yang tidak konsisten diterapkan padahal contoh yang baik sudah ada di codebase yang sama. Setiap admin menulis alasan penolakan KYC dengan kalimatnya sendiri, sehingga tim produk tidak bisa menganalisis pola kegagalan secara agregat, dan kualitas penjelasan ke user jadi tidak konsisten tergantung admin mana yang menangani — padahal user KYC cuma dapat maksimal 10 kali percobaan.
**Saran:** terapkan pola enum yang sama seperti `OrderCancelReason` ke KYC/Business Verification/Dispute, dengan field notes bebas sebagai pelengkap opsional.

### 20.2 Tidak ada kapabilitas generate PDF asli di manapun dalam platform
**Bukti:** `package.json` di-grep untuk "pdf/puppeteer/playwright" — nihil, tidak ada library PDF generation. `wallet/export/pdf` mengembalikan HTML (lihat 3.2); `orders/:id/receipt` juga eksplisit mengembalikan HTML (setidaknya jujur soal ini di deskripsi API-nya, beda dengan wallet).
**Kenapa perlu di-improve:** untuk kebutuhan seperti invoice/bukti transaksi untuk pembukuan/pajak, user (terutama pengguna bisnis) sering butuh file PDF asli yang bisa disimpan/dilampirkan, bukan halaman HTML yang harus di-"print to PDF" manual di sisi client.
**Saran:** tambahkan kapabilitas PDF generation asli (mis. via headless browser/PDF library) untuk dokumen finansial yang sifatnya perlu diarsipkan.

---

# DAFTAR BUG (tambahan, bukan prioritas utama)

Berbeda dari 51 poin di atas (yang sifatnya kekurangan/ketidaklengkapan fitur), tiga hal berikut adalah **perilaku yang secara objektif salah/kontradiktif**, bukan sekadar "belum ada":

**Bug 1 — Data inconsistency: `getUserGrowth` menghasilkan angka berbeda di dua layar admin**
Lihat detail lengkap di §19.7. Root cause: dua implementasi terpisah dengan boundary timezone berbeda (UTC vs Asia/Jakarta) untuk metrik yang seharusnya identik.

**Bug 2 — Rate limit bypass: endpoint "report user" ganda dengan window berbeda 24×**
Lihat detail lengkap di §18.2. `POST /users/:userId/report` dibatasi 5×/24 jam, tapi `POST /settings/report` — yang secara fungsional melakukan hal yang sama (submit `UserReport`) — dibatasi 5×/**1 jam**. Siapapun yang tahu keduanya ada bisa pakai jalur kedua untuk melewati proteksi anti-spam-report yang dimaksudkan di jalur pertama.

**Bug 3 — Kontrak API self-contradictory di `SetPinDto`**
Lokasi: `modules/wallet/dto/wallet-pin.dto.ts`. Field `password` didekorasi `@IsOptional()` di level validasi, tapi `@ApiPropertyOptional` description menyatakan field ini wajib saat mengganti PIN yang sudah ada. Skema OpenAPI yang dihasilkan akan kontradiktif dengan dokumentasinya sendiri.

---

# RINGKASAN JUMLAH TEMUAN PER MODUL

| Modul | Jumlah Temuan |
|---|---|
| Auth | 2 |
| Order/Escrow | 6 |
| Wallet | 4 |
| Withdrawals | 1 |
| KYC | 3 |
| Business Verification | 1 |
| Notifikasi | 4 |
| Dispute | 3 |
| Ratings | 2 |
| Bank Accounts | 1 |
| Subscriptions | 1 |
| Referral & Vouchers | 1 |
| Search | 1 |
| Support & Help Center | 3 |
| Chat | 3 |
| Showcase | 1 |
| Upload | 1 |
| Profil/Users/Settings | 4 |
| Admin | 7 |
| Lintas Modul | 2 |
| **TOTAL** | **51** |

Plus 3 bug tambahan di akhir dokumen.
