# Chat — Trust & Safety dan fitur percakapan

Dokumen ini mencatat temuan audit internal 2026-09-13 pada modul chat beserta
keputusan yang diambil. Referensi kode: `src/modules/chat/`,
`src/modules/realtime/`, `src/modules/admin/chat/`, migration
`20260913_chat_trust_safety_and_features`.

---

## 1. Mengapa chat adalah permukaan berisiko tinggi di escrow

Nilai produk Kahade adalah dana ditahan di escrow sampai kedua pihak puas.
Begitu percakapan dan pembayaran pindah ke luar aplikasi, proteksi itu hilang
dan tiket dispute tidak bisa ditindaklanjuti. Karena itu, **circumvention di
chat bukan masalah etiket, melainkan risiko bisnis nomor satu**: ia menghapus
alasan pelanggan memakai Kahade sekaligus menghilangkan jejak yang dibutuhkan
untuk menyelesaikan sengketa.

Sebelum perubahan ini:

- teks pesan tidak difilter sama sekali (hanya lampiran yang divalidasi MIME);
- `deleteMessage()` tidak memeriksa status order, dan `content` di-null-kan
  permanen — pesan yang sedang disengketakan bisa dimusnahkan pengirimnya;
- `isEdited` dan `ChatRoom.isArchived` adalah kolom mati (tidak pernah ditulis);
- README menjanjikan "reactions" padahal tidak ada model maupun endpoint-nya;
- chat hanya bisa ada setelah order dibuat, sehingga tidak ada nego
  pra-transaksi.

---

## 2. Deteksi circumvention

Implementasi: `src/modules/chat/chat-moderation.util.ts` (pure function, tanpa
I/O, sehingga bisa diuji tanpa database). 41 unit test menutupi teknik
penghindaran sekaligus kalimat Bahasa Indonesia yang harus tetap lolos.

### Yang dideteksi

| Kategori | Contoh | Aksi |
|---|---|---|
| Nomor HP Indonesia | `081234567890`, `+6281234567890`, `0812-3456-7890` | **BLOCK** |
| Nomor diucapkan dengan kata | `nol delapan satu dua tiga …` | **BLOCK** |
| Tautan aplikasi obrolan | `wa.me/…`, `t.me/…`, `line.me`, `discord.gg` | **BLOCK** |
| Nama kanal (token utuh) | `whatsapp`, `telegram`, `tele`, `wechat` | **BLOCK** |
| Singkatan + konteks kontak | `wa saya`, `add line`, `pm aja` | **BLOCK** |
| Ajakan pindah platform | `di luar aplikasi`, `lanjut di wa`, `outside kahade` | **BLOCK** |
| Niat melewati escrow | `tanpa escrow`, `hindari fee`, `transfer langsung` | **BLOCK** |
| Minta OTP / PIN / password | `minta kode OTP`, `kirim PIN` | **BLOCK** |
| Email, handle, tautan pendek, tautan eksternal | `budi@contoh.com`, `s.id/…` | FLAG |
| Pola penipuan (undian, "transfer dulu") | `transfer dulu baru dikirim` | FLAG |
| Bahasa kasar berat | kata umpatan | REDACT |
| Bahasa kasar ringan | `anjir` | FLAG |

### Teknik penghindaran yang ditangani

Pencocokan tidak dilakukan pada teks mentah, melainkan pada beberapa *folded
view* yang tetap menyimpan pemetaan indeks ke teks asli (supaya bisa
disensor di tempat):

- karakter tak terlihat (ZWSP, soft hyphen, word joiner, BOM) dibuang;
- pemisah (spasi, titik, strip) dibuang untuk pencocokan frasa;
- leetspeak `0→o, 4→a, 3→e, 5→s, 1→i …`;
- pengulangan karakter 3+ dikecilkan (`anjiiing` → `anjing`);
- angka yang diucapkan dikonversi ke digit.

### Menghindari false positive

Pencocokan kata memakai **token utuh, bukan substring**. Ini krusial dalam
Bahasa Indonesia: `tai` ada di dalam `santai` dan `detail`, `tele` ada di dalam
`telepon`. Substring matching akan menyensor percakapan biasa dan membuat
fitur ini tidak dipercaya.

Penyesuaian lain:

- angka berbentuk nomor HP yang berada di dekat kosakata nominal
  (`rp`, `harga`, `total`, `ongkir`, …) diturunkan dari BLOCK menjadi FLAG —
  `transfer`/`bayar`/`tf` sengaja **tidak** masuk daftar itu, karena
  "transfer ke 0812…" justru kasus yang harus tetap diblokir;
- singkatan `wa`, `line`, `ig`, `pm`, `dm` hanya memicu blokir bila berdampingan
  dengan kosakata kontak (`wa saya`, `add line`), supaya salam
  `wa'alaikumussalam` tidak ikut terblokir;
- nama file lampiran ikut dipindai, tetapi hasilnya hanya disensor (menolak
  seluruh upload karena nama file terlalu merugikan user).

### Saklar operasional

`CHAT_CIRCUMVENTION_ACTION` (`chat.circumventionAction`) memungkinkan operator
menurunkan ketegasan tanpa deploy:

| Nilai | Perilaku |
|---|---|
| `BLOCKED` (default) | Pesan ditolak; klien menerima `CHAT_MESSAGE_BLOCKED` + penjelasan Bahasa Indonesia. |
| `REDACTED` | Pola kontak disensor, pesan tetap terkirim, event dicatat. |
| `FLAGGED` | Hanya dicatat untuk ditinjau. |

---

## 3. Integritas bukti saat sengketa

| Aturan | Alasan |
|---|---|
| Pesan tidak bisa dihapus saat order `DISPUTED` (atau masih ada baris dispute belum `RESOLVED`) | Pesan yang paling menentukan tidak boleh hilang tepat saat dibutuhkan resolver. Kode error: `CHAT_MESSAGE_LOCKED_DISPUTE`. |
| Isi asli disimpan di `deletedContent` saat hapus | Soft delete tidak lagi berarti pemusnahan bukti. |
| Edit pesan juga dikunci saat dispute | Edit adalah jalur lain untuk mengubah bukti secara diam-diam. |
| Riwayat revisi di `ChatMessageEdit` | Resolver bisa melihat apa yang tertulis sebelum diedit. |
| `GET /admin/disputes/:disputeId/chat?includeDeleted=true` | Resolver/admin membaca percakapan termasuk konten terhapus; aksesnya mengikuti aturan assignment dispute dan dicatat di audit log. |
| `GET /admin/chat/rooms/:roomId/messages?includeDeleted=true` | Padanan untuk pemeriksaan moderasi. |

---

## 4. Antrean moderasi

Pesan yang diblokir **tidak pernah tersimpan**, sehingga tanpa jejak terpisah
kita tidak akan tahu berapa banyak percobaan circumvention yang dicegah atau
seberapa sering terjadi false positive. Karena itu setiap kecocokan dicatat di
`chat_moderation_events` (satu baris per matcher, lengkap dengan severity,
aksi, matcher id, dan potongan teks yang memicu).

Endpoint admin (`SUPER_ADMIN`, `DISPUTE_ADMIN`, `CUSTOMER_SUPPORT`):

- `GET /admin/chat/moderation-events` — antrean, bisa difilter status,
  severity, action, kind;
- `GET /admin/chat/moderation-events/stats` — ringkasan untuk dashboard;
- `GET /admin/chat/moderation-events/:id` — detail;
- `POST /admin/chat/moderation-events/:id/review`
  (`SUPER_ADMIN`, `DISPUTE_ADMIN`) — `REVIEWED` / `DISMISSED` / `ACTIONED`,
  setiap review masuk audit log admin;
- `GET /admin/chat/users/:userId/moderation-events` — pola berulang per user
  (sinyal yang jauh lebih kuat daripada satu pesan yang keblokir).

---

## 5. Fitur percakapan

| Fitur | Endpoint | Catatan keputusan |
|---|---|---|
| Reaksi emoji | `POST/DELETE /chat/rooms/:roomId/messages/:messageId/reactions[/:emoji]` | Menutup gap README. Satu (user, pesan, emoji) unik; satu user boleh memberi beberapa emoji berbeda pada pesan yang sama (model Slack). |
| Edit pesan | `PATCH /chat/rooms/:roomId/messages/:messageId` | `isEdited` akhirnya diisi; riwayat revisi disimpan; konten baru tetap dimoderasi agar detektor tidak bisa dilewati dengan "kirim polos lalu edit". |
| Arsip | `PUT /chat/rooms/:roomId/archive` | **Per user** (`ChatRoomMember`), bukan global: "saya arsipkan" tidak boleh menghilangkan percakapan dari daftar lawan bicara. Kolom lama `ChatRoom.isArchived` di-mirror (true hanya bila semua peserta mengarsipkan) supaya tidak jadi data mati. |
| Mute | `PUT /chat/rooms/:roomId/mute` | Per user, bisa berdurasi (maks 30 hari). |
| Cari dalam chat | `GET /chat/rooms/:roomId/search?q=` | ILIKE case-insensitive; didukung index trigram (`pg_trgm`) bila ekstensi tersedia. |
| Cari global | `GET /chat/search?q=` | Menyeberang semua percakapan user; menjawab "nomor resi itu dikirim di chat yang mana?". |
| Pin pesan | `POST/DELETE …/pin`, `GET /chat/rooms/:roomId/pins` | Untuk alamat kirim / nomor resi. Dibatasi 20 per percakapan (`CHAT_PIN_LIMIT_REACHED`). Pesan yang dihapus otomatis unpin. |
| Forward | `POST …/forward` | **Hanya ke room dengan lawan bicara yang sama** — mencegah kebocoran data pribadi antar transaksi (alamat buyer A tidak boleh sampai ke seller B). Pelanggaran → `CHAT_FORWARD_NOT_ALLOWED`. |
| Voice note | `messageType: VOICE` | Enum `ChatMessageType.VOICE` + `durationSeconds` (1–600 detik) + lampiran wajib ber-MIME `audio/*`. |
| Chat pra-transaksi | `POST /chat/inquiries` | Room `INQUIRY` tanpa order, untuk nego sebelum buyer membuat order dan mengunci dana. Pairing disimpan kanonik + partial unique index; dibatasi 30 room aktif per user dan di-throttle 10/jam untuk menekan spam; tetap tunduk pada block list dan moderasi. |

### Online / last seen

`showOnlineStatus` kini benar-benar dipakai: daftar room dan
`GET /chat/rooms/:roomId/presence` melaporkan `isOnline: false` dan
`lastSeenAt: null` bila lawan bicara menonaktifkan status online. "Terakhir
dilihat" disimpan di Redis dengan TTL 7 hari (bukan kolom baru di `users`),
supaya tidak menambah jejak pelacakan jangka panjang.

---

## 6. Indikator mengetik (typing)

Gejala: indikator "sedang mengetik" lawan bicara tidak pernah muncul.

Dua penyebab di sisi server:

1. **Salah alamat.** Broadcast dikirim hanya ke `order:<orderId>`, padahal
   klien chat bergabung lewat `join-room`. Room `chat:<roomId>` (satu-satunya
   alamat yang ada untuk room INQUIRY) tidak pernah dikirimi apa pun.
2. **Rate limit membuang event secara diam-diam.** Batas lama 5 event / 3 detik
   hampir selalu terlampaui oleh heartbeat mengetik; event yang kelebihan kuota
   di-`return` tanpa apa pun, sehingga timer auto-stop tidak pernah di-arm ulang
   dan indikator bisa macet menyala.

Perubahan:

- typing kini dikelola sebagai **state**, bukan aliran event: heartbeat hanya
  memperpanjang timer, broadcast di-throttle ke sekali per 2,5 detik, dan
  `typing.stop` selalu dikirim tepat satu kali (klien berhenti, timer habis
  setelah 8 detik, atau socket terputus);
- event dikirim ke `chat:<roomId>` **dan** `order:<orderId>`;
- payload memuat `userId`, `fullName`, `isTyping`, dan `expiresAt` sehingga
  klien bisa mematikan indikator sendiri walau paket `typing.stop` hilang;
- `join-room` berlangganan kedua room dan `leave-room` meninggalkan keduanya
  sekaligus menghapus status mengetik.

Regresi dikunci di `src/modules/realtime/tests/realtime.gateway.spec.ts`.

---

## 7. Pertanyaan produk yang masih terbuka

**Voice/video call buyer–seller.** Saat ini `dispute.call_*` hanya tersedia
untuk dispute; komunikasi buyer–seller normal tetap berbasis teks. Rekomendasi
kami: **pertahankan teks saja** dan sebutkan secara eksplisit di kebijakan
produk, dengan alasan:

1. percakapan yang tidak tercatat tidak bisa dipakai sebagai bukti dispute;
2. panggilan adalah jalur yang paling sering dipakai untuk menyepakati
   "transfer langsung";
3. biaya moderasi rekaman suara jauh lebih tinggi daripada teks.

Bila produk tetap menginginkan panggilan, minimum yang harus dipenuhi:
persetujuan kedua pihak yang tercatat, notifikasi bahwa percakapan dapat
direkam/dicatatan untuk dispute, dan banner peringatan escrow di dalam layar
panggilan. Keputusan ini perlu dikonfirmasi pemilik produk sebelum
diimplementasikan — tidak ada kode yang disiapkan untuk itu saat ini.

**Konversi inquiry → order.** Room `INQUIRY` belum otomatis terhubung ke order
yang dibuat kemudian dari percakapan itu. Penghubungnya (mis. `inquiryRoomId`
di order) sengaja ditunda sampai ada desain alur "buat order dari chat" di sisi
klien.
