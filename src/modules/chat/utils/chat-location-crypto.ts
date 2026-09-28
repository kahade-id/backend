import { hmacSHA256 } from '../../../common/utils/crypto.util';
import { Logger } from '@nestjs/common';

/**
 * Enkripsi app-level koordinat lokasi pesan chat (SEC-D MEDIUM).
 *
 * KENDALA DESAIN (jujur): kolom `locationLat`/`locationLng` bertipe Float di
 * DB dan perubahan skema DILARANG pada batch ini (additive-only, code-only).
 * Ciphertext AES-GCM (string base64) tidak muat di kolom Float, sehingga
 * pola `encryptPii` tidak bisa dipakai langsung. Sebagai gantinya dipakai
 * **keyed coordinate blinding** — konstruksi yang jujur didokumentasikan di sini:
 *
 *   stored_lat = lat + padLat(messageId)
 *   stored_lng = lng + padLng(messageId)
 *
 * dengan pad = 2000 + U(0,1000) yang diturunkan dari HMAC-SHA256 memakai
 * secret HMAC server + konteks per-(messageId, axis). Sifat-sifatnya:
 *
 * - Reversibel HANYA dengan secret server (tanpa secret, isi DB/backups
 *   tidak bisa dikembalikan ke koordinat asli) — ancaman "DB bocor / backup
 *   dibaca pihak tak berwenang" tertutup.
 * - Pad unik per pesan: dua pesan dengan koordinat identik menghasilkan nilai
 *   tersimpan berbeda (tidak ada kebocoran kesetaraan).
 * - Nilai ter-blinding selalu > 900, sedangkan koordinat valid tidak pernah
 *   melebihi |180| — deteksi "sudah terenkripsi vs plaintext legacy" eksak,
 *   sehingga baca dua arah dengan fallback plaintext aman.
 * - Presisi: aritmetika double memberi galat ~1e-13 derajat (~0,01 mm).
 *
 * JALUR MIGRASI KE DEPAN: bila suatu saat kolom diubah ke teks via migrasi,
 * ganti konstruksi ini dengan `encryptPii(`${lat},${lng}`)` (AES-GCM) tanpa
 * mengubah kontrak fungsi di bawah.
 */

const logger = new Logger('chat-location-crypto');

// Koordinat valid (divalidasi di ChatService.validateLocationMessage).
const MAX_PLAINTEXT_MAGNITUDE = 180;
// Nilai ter-blinding selalu di atas ambang ini; plaintext tidak pernah sampai.
export const BLINDED_LOCATION_THRESHOLD = 900;
const PAD_BASE = 2000;
const PAD_SPAN = 1000;
const TWO_POW_64 = 18446744073709551616;

function padFor(messageId: string, axis: 'lat' | 'lng'): number {
  const hex = hmacSHA256(`kahade:chat-location:v1:${axis}:${messageId}`);
  // 64 bit pertama digest sebagai fraksi [0,1).
  const hi = parseInt(hex.slice(0, 8), 16);
  const lo = parseInt(hex.slice(8, 16), 16);
  const fraction = (hi * 4294967296 + lo) / TWO_POW_64;
  return PAD_BASE + fraction * PAD_SPAN;
}

/** True bila pasangan nilai tersimpan adalah hasil blinding (bukan plaintext). */
export function isBlindedLocation(storedLat: number | null, storedLng: number | null): boolean {
  return (
    typeof storedLat === 'number' &&
    typeof storedLng === 'number' &&
    storedLat > BLINDED_LOCATION_THRESHOLD &&
    storedLng > BLINDED_LOCATION_THRESHOLD
  );
}

function inValidRange(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -MAX_PLAINTEXT_MAGNITUDE &&
    lng <= MAX_PLAINTEXT_MAGNITUDE
  );
}

/**
 * Samarkan koordinat sebelum tulis ke DB. `messageId` harus id final baris
 * (ChatService men-generate cuid via createId() sebelum create).
 */
export function blindChatLocation(
  lat: number,
  lng: number,
  messageId: string,
): { lat: number; lng: number } {
  if (!inValidRange(lat, lng)) {
    throw new Error('blindChatLocation: coordinates out of valid range');
  }
  return {
    lat: lat + padFor(messageId, 'lat'),
    lng: lng + padFor(messageId, 'lng'),
  };
}

export interface ResolvedChatLocation {
  lat: number;
  lng: number;
}

/**
 * Kembalikan koordinat asli dari nilai tersimpan.
 * - Nilai ter-blinding → unblind + validasi rentang (fail-closed: di luar
 *   rentang = null + log, jangan tampilkan koordinat salah).
 * - Plaintext legacy → dipakai apa adanya (fallback dua arah).
 * - null/null → null.
 */
export function unblindChatLocation(
  storedLat: number | null,
  storedLng: number | null,
  messageId: string,
): ResolvedChatLocation | null {
  if (storedLat == null || storedLng == null) return null;
  if (!isBlindedLocation(storedLat, storedLng)) {
    // Fallback plaintext: data lama sebelum enkripsi.
    if (!inValidRange(storedLat, storedLng)) {
      logger.warn(`Chat location out of range for message ${messageId} — hiding`);
      return null;
    }
    return { lat: storedLat, lng: storedLng };
  }
  const lat = storedLat - padFor(messageId, 'lat');
  const lng = storedLng - padFor(messageId, 'lng');
  if (!inValidRange(lat, lng)) {
    // Kunci berubah / data korup: jangan bocorkan koordinat salah.
    logger.error(`[SECURITY] Failed to unblind chat location for message ${messageId}`);
    return null;
  }
  return { lat, lng };
}
