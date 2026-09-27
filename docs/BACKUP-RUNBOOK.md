# BACKUP RUNBOOK — Backup DB Terenkripsi (SEC-306)

> ⚠️ **STATUS: BUTUH EKSEKUSI MANUAL DI SERVER (15.232.109.186).**
> Semua perubahan di bawah ini hanya ada di repo. Sampai langkah §1–§3
> dijalankan di server, backup harian yang berjalan masih **plaintext**
> (`kahade_prod_*.dump` tanpa enkripsi) — celah SEC-306 tetap terbuka.
>
> Setelah deploy backend yang memuat commit ini, jalankan §1 (sekali saja),
> lalu §4 untuk verifikasi.

Skrip kanonis: `scripts/backup-db.sh` (repo) — `pg_dump --format=custom`
di-pipe ke `gpg --symmetric --cipher-algo AES256`, output
`/var/backups/kahade/kahade_prod_<ts>.dump.gpg`.

---

## §1. Setup awal di server (sekali saja, sebagai `ubuntu` lalu `kahade`)

```bash
# --- sebagai ubuntu ---
ssh -i ~/.ssh/id_ed25519 ubuntu@15.232.109.186

# Direktori backup: hanya owner yang bisa baca/tulis.
sudo mkdir -p /var/backups/kahade /var/log/kahade
sudo chown kahade:kahade /var/backups/kahade /var/log/kahade
sudo chmod 700 /var/backups/kahade

sudo su - kahade

# --- sebagai kahade ---
# 1a. Salin skrip dari rilis aktif (SUDAH termasuk commit fix SEC-306).
cp /var/www/kahade-current/scripts/backup-db.sh ~/backup-db.sh
cp /var/www/kahade-current/scripts/backup-retention.sh ~/backup-retention.sh
cp /var/www/kahade-current/scripts/verify-backup.sh ~/verify-backup.sh
chmod +x ~/backup-db.sh ~/backup-retention.sh ~/verify-backup.sh
bash -n ~/backup-db.sh && echo OK

# 1b. Buat passphrase file — 32 byte random, chmod 600, owner kahade.
#     PENTING: simpan salinan passphrase di vault offline (Bitwarden/1Password
#     tim ops). Kehilangan file ini = backup tidak bisa dibuka.
openssl rand -base64 32 | tr -d '\n' > ~/.kahade-backup.passphrase
chmod 600 ~/.kahade-backup.passphrase
stat -c '%a %U %G %n' ~/.kahade-backup.passphrase
# harus: 600 kahade kahade /home/kahade/.kahade-backup.passphrase
```

## §2. Kredensial DB untuk cron (tanpa password di crontab)

Password user `kahade_prod` jangan ditulis di crontab. Simpan di file env
khusus cron, chmod 600:

```bash
# --- sebagai kahade ---
cat > ~/.backup-cron.env <<'EOF'
KAHADE_BACKUP_PASSPHRASE_FILE=/home/kahade/.kahade-backup.passphrase
KAHADE_PG_BACKUP_PASSWORD='GANTI_DENGAN_PASSWORD_KAHADE_PROD'
EOF
chmod 600 ~/.backup-cron.env
```

Lalu pasang cron yang me-load file env tersebut:

```bash
crontab -e
```

```cron
0 2 * * * set -a; . /home/kahade/.backup-cron.env; set +a; /home/kahade/backup-db.sh >> /var/log/kahade/backup.log 2>&1
```

## §3. Uji coba manual (wajib sebelum mengandalkan cron)

```bash
# --- sebagai kahade ---
set -a; . ~/.backup-cron.env; set +a
~/backup-db.sh
# ekspektasi: "[...] Backup terenkripsi: /var/backups/kahade/kahade_prod_<ts>.dump.gpg (...)"

ls -la /var/backups/kahade/
# ekspektasi: -rw------- 1 kahade kahade ... kahade_prod_<ts>.dump.gpg

# Pastikan file benar-benar terenkripsi (bukan plaintext dump):
head -c 16 /var/backups/kahade/kahade_prod_*.dump.gpg | xxd | head -2
# ekspektasi: byte acak (header OpenPGP), BUKAN teks "PGDMP".
```

## §4. Verifikasi restore terenkripsi (test restore)

Jalankan **setelah** §3 sukses. Restore dilakukan ke database temporer
(`kahade_backup_verify_*`) di server verifikasi — JANGAN ke DB produksi
kecuali saat disaster recovery sungguhan.

```bash
# --- sebagai kahade ---
set -a; . ~/.backup-cron.env; set +a

# Opsional tapi disarankan: verifikasi otomatis (restore ke DB temp +
# integrity check tabel/constraint), file temp di-shred setelahnya.
KAHADE_VERIFY_ADMIN_URL='postgresql://ADMIN_USER:ADMIN_PASS@127.0.0.1:5432/postgres' \
  ~/verify-backup.sh /var/backups/kahade/kahade_prod_<ts>.dump.gpg
# ekspektasi akhir: "[verify-backup] Backup verification PASSED (...)"
```

Restore manual (disaster recovery):

```bash
gpg --batch --quiet --pinentry-mode loopback \
  --passphrase-file /home/kahade/.kahade-backup.passphrase \
  --decrypt /var/backups/kahade/kahade_prod_<ts>.dump.gpg \
  | pg_restore --clean --if-exists --no-owner \
      -h 127.0.0.1 -U kahade_prod -d kahade_prod
```

## §5. Rotasi passphrase (berkala / saat personel berubah)

Passphrase gpg adalah symmetric key — rotasi = dekripsi ulang dengan
passphrase baru. Lakukan di server sebagai `kahade`:

```bash
set -a; . ~/.backup-cron.env; set +a
OLD="$KAHADE_BACKUP_PASSPHRASE_FILE"
NEW="$HOME/.kahade-backup.passphrase.new"

# 5a. Generate passphrase baru.
openssl rand -base64 32 | tr -d '\n' > "$NEW"
chmod 600 "$NEW"

# 5b. Re-enkripsi SEMUA backup yang masih dipertahankan (14 hari).
for f in /var/backups/kahade/kahade_prod_*.dump.gpg; do
  tmp="$(mktemp /tmp/reenc-XXXXXX.dump.gpg)"
  gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$OLD" \
    --decrypt --output - -- "$f" | \
  gpg --batch --yes --pinentry-mode loopback --symmetric --cipher-algo AES256 \
    --passphrase-file "$NEW" --output "$tmp" -
  chmod 600 "$tmp"
  mv "$tmp" "$f"
  echo "re-encrypted: $f"
done

# 5c. Validasi satu file dengan passphrase BARU (sampel terbaru).
LATEST="$(ls -t /var/backups/kahade/kahade_prod_*.dump.gpg | head -1)"
KAHADE_BACKUP_PASSPHRASE_FILE="$NEW" \
KAHADE_VERIFY_ADMIN_URL='postgresql://ADMIN_USER:ADMIN_PASS@127.0.0.1:5432/postgres' \
  ~/verify-backup.sh "$LATEST"
# HARUS "PASSED" sebelum lanjut.

# 5d. Ganti file aktif + update vault offline, lalu hancurkan yang lama.
mv "$NEW" "$OLD"
shred -u "$HOME/.kahade-backup.passphrase.new" 2>/dev/null || true
echo "Simpan passphrase baru ke vault offline SEKARANG, lalu hapus salinan lama dari vault."
```

## §6. Checklist operasional

- [ ] `stat /var/backups/kahade` → `700 kahade kahade`
- [ ] `stat ~/.kahade-backup.passphrase` → `600 kahade kahade`
- [ ] Cron 02:00 berjalan; `/var/log/kahade/backup.log` berisi "Backup terenkripsi"
- [ ] `verify-backup.sh` PASSED untuk backup terbaru (ulangi tiap bulan)
- [ ] Salinan passphrase ada di vault offline (aturan 3-2-1: 1 salinan offsite)
- [ ] Backup lama plaintext (`kahade_prod_*.dump` tanpa `.gpg`) sudah di-`shred -u`
      setelah masa transisi (jangan biarkan plaintext & terenkripsi hidup berdampingan lama)
- [ ] Permission `/var/www/kahade/apps/backend/.env` = 600 (SEC-511)

## Referensi

- `scripts/backup-db.sh` — skrip backup terenkripsi
- `scripts/backup-retention.sh` — retensi (14 DB / 5 dist / 14 schema), validasi `.dump.gpg` via dekripsi-ke-pipe
- `scripts/verify-backup.sh` — test restore ke DB temporer + integrity check
- Temuan audit: `audit-2026-09-26/fixes/security-audit-scratch/data-secret-audit.md` (SEC-306)
