import { Injectable, BadRequestException, NotFoundException, Logger, ConflictException, InternalServerErrorException, PayloadTooLargeException, ServiceUnavailableException, UnsupportedMediaTypeException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { Readable } from 'stream';
import * as fs from 'fs';
import * as path from 'path';

import { customAlphabet } from 'nanoid';
import sharp from 'sharp';
import { UploadPurpose } from './dto/presigned-url.dto';
import { RedisService } from '../../redis/redis.service';
import { LocalStorageService } from './local-storage.service';
import { VideoProcessingService } from './video-processing.service';
import {
  SHOWCASE_IMAGE_THUMBNAIL_WIDTH,
  SHOWCASE_VIDEO_MAX_BYTES,
  SHOWCASE_VIDEO_MAX_DIMENSION_PX,
  SHOWCASE_VIDEO_MAX_DURATION_SEC,
  SHOWCASE_VIDEO_MIN_DURATION_SEC,
  SHOWCASE_VIDEO_THUMBNAIL_WIDTH,
} from '../../common/constants/app.constants';
import { encryptAES, decryptAES } from '../../common/utils/crypto.util';
import * as ErrorCodes from '../../common/constants/error-codes';
import { withSpan } from '../../common/tracing/tracing';
import { stripImageMetadata } from './utils/strip-image-metadata';
import { parseHttpRange } from './utils/http-range';
import { STORAGE_UNAVAILABLE_MESSAGE, describeStorageError } from '../../common/utils/storage-error.util';

const nanoid = customAlphabet('1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', 10);

// NOTE (batch 1A, ST-016): image/heic & image/heif DITERIMA untuk KYC, dokumen
// bisnis, bukti, dan lampiran chat — format default kamera iPhone tidak boleh
// ditolak. Magic-byte detection sudah mencakup brand ftyp HEIC/HEIF.
// AVATAR & SHOWCASE_IMAGE tetap tanpa HEIC: keduanya dirender langsung oleh
// browser/<Image> dan browser tidak merender HEIC — klaim itu tetap valid
// untuk konten yang tampil publik.
export const ALLOWED_CONTENT_TYPES: Record<UploadPurpose, string[]> = {
  [UploadPurpose.KYC_KTP]: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'],
  [UploadPurpose.KYC_SELFIE]: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'],
  [UploadPurpose.KYC_PASSPORT]: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'],
  [UploadPurpose.KYC_LIVENESS]: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'],
  // Dokumen badan usaha boleh PDF (NPWP/akta/SIUP umumnya dipindai sebagai PDF).
  [UploadPurpose.BUSINESS_DOCUMENT]: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'],
  // Section 3: gambar showcase tampil publik di feed, jadi hanya image raster.
  // PDF/SVG ditolak — tidak bisa dirender sebagai thumbnail kartu feed.
  [UploadPurpose.SHOWCASE_IMAGE]: ['image/jpeg', 'image/png', 'image/webp'],
  // Batch 19 TIM A (item 1): video showcase — mp4/mov/webm, magic-byte
  // terverifikasi di MAGIC_BYTES (ftyp brand spesifik / EBML).
  [UploadPurpose.SHOWCASE_VIDEO]: ['video/mp4', 'video/quicktime', 'video/webm'],
  [UploadPurpose.STORY_MEDIA]: ['image/jpeg', 'image/png', 'image/webp'],
  [UploadPurpose.STORY_HIGHLIGHT]: ['image/jpeg', 'image/png', 'image/webp'],
  [UploadPurpose.AVATAR]: ['image/jpeg', 'image/png', 'image/webp'],
  // BE-5: aset digital — PDF, gambar, video mp4 (tipe yang magic-byte-nya dikenal).
  [UploadPurpose.DIGITAL_ASSET]: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'video/mp4'],
  [UploadPurpose.CHAT_ATTACHMENT]: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf', 'video/mp4', 'video/quicktime', 'video/webm', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4'],
  [UploadPurpose.DISPUTE_EVIDENCE]: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf', 'video/mp4', 'video/quicktime', 'video/webm'],
  [UploadPurpose.REPORT_EVIDENCE]: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'],
  [UploadPurpose.DELIVERY_PROOF]: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'],
  // BFI-097: bukti milestone — foto/scan + PDF, privat.
  [UploadPurpose.MILESTONE_EVIDENCE]: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'],
  // Karir (Fase F2): CV pelamar — PDF SAJA (anti polyglot; ekstensi dari MIME terdeteksi).
  [UploadPurpose.CAREER_CV]: ['application/pdf'],
};

const MIN_FILE_SIZE = 1024;

// SH-S-001 (audit etalase 2026-09-27, P0 stored XSS): ekstensi file yang
// TERSIMPAN wajib diturunkan dari MIME yang terdeteksi via magic-byte
// (allowlist di bawah), BUKAN dari filename kiriman user. Sebelumnya
// `promo.html` ber-header JPEG valid lolos dan diserve nginx sebagai
// text/html di origin api.kahade.id → stored XSS. MIME di sini SELALU cocok
// dengan detectedMime (uploadDirectTx menolak bila tidak), jadi map ini
// harus mencakup semua MIME yang dikenal detectMimeFromBytes; MIME tanpa
// entri → upload ditolak (fail-closed).
const DETECTED_MIME_TO_EXTENSION: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/avif': '.avif',
  'application/pdf': '.pdf',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/ogg': '.ogg',
  'audio/mp4': '.m4a',
};

export const MAX_FILE_SIZE: Record<UploadPurpose, number> = {
  [UploadPurpose.KYC_KTP]: 5 * 1024 * 1024,
  [UploadPurpose.KYC_SELFIE]: 5 * 1024 * 1024,
  [UploadPurpose.KYC_PASSPORT]: 5 * 1024 * 1024,
  [UploadPurpose.KYC_LIVENESS]: 5 * 1024 * 1024,
  [UploadPurpose.BUSINESS_DOCUMENT]: 10 * 1024 * 1024,
  [UploadPurpose.SHOWCASE_IMAGE]: 5 * 1024 * 1024,
  // Batch 19 TIM A (item 1): 100 MiB (lihat SHOWCASE_VIDEO_MAX_BYTES).
  [UploadPurpose.SHOWCASE_VIDEO]: SHOWCASE_VIDEO_MAX_BYTES,
  [UploadPurpose.STORY_MEDIA]: 10 * 1024 * 1024,
  [UploadPurpose.STORY_HIGHLIGHT]: 10 * 1024 * 1024,
  [UploadPurpose.AVATAR]: 2 * 1024 * 1024,
  [UploadPurpose.DIGITAL_ASSET]: 50 * 1024 * 1024,
  [UploadPurpose.CHAT_ATTACHMENT]: 50 * 1024 * 1024,
  // SYS-C-303 (audit sistemik ronde 3, 2026-10-03): DISPUTE_EVIDENCE disamakan
  // dengan batas consumer (dispute-message.service.ts & disputes.service.ts:
  // 10 MB/file, controller menolak >10 MB). Sebelumnya 50 MiB — file 10–50 MB
  // lolos upload tapi pasti ditolak saat dipakai (bandwidth terbuang).
  [UploadPurpose.DISPUTE_EVIDENCE]: 10 * 1024 * 1024,
  [UploadPurpose.REPORT_EVIDENCE]: 10 * 1024 * 1024,
  [UploadPurpose.DELIVERY_PROOF]: 10 * 1024 * 1024,
  // BFI-097: bukti milestone — 10 MiB (sama seperti bukti laporan/pengiriman).
  [UploadPurpose.MILESTONE_EVIDENCE]: 10 * 1024 * 1024,
  // Karir (Fase F2): CV maks 5 MB.
  [UploadPurpose.CAREER_CV]: 5 * 1024 * 1024,
};

const CONFIRMED_KEY_TTL_SECONDS = 86_400;

// B-36 (audit-fix): expand magic-byte coverage to include HEIC/AVIF (modern
// iPhone/Android camera default), and bump the inspection window so the
// ftyp-prefixed signatures can be matched. We deliberately do NOT add SVG --
// SVG is XML and can carry script payloads, and re-encoding it server-side
// is not in scope for this fix; SVG remains rejected by `detectMimeFromBytes`
// returning null.
// Each entry may declare MULTIPLE anchored byte-runs; every run must match.
// This matters for container formats (RIFF/WEBP, ISO-BMFF) where checking only
// the inner brand at a non-zero offset would let an attacker prepend arbitrary
// bytes (e.g. an HTML/JS polyglot) and still be classified as an image.
const MAGIC_BYTES: { mime: string; runs: { offset: number; bytes: number[] }[]; validate?: (header: Buffer) => boolean }[] = [
  { mime: 'image/jpeg', runs: [{ offset: 0, bytes: [0xFF, 0xD8, 0xFF] }] },
  { mime: 'image/png', runs: [{ offset: 0, bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] }] },
  // B-38 (audit-fix): WEBP is a RIFF container — the 'RIFF' tag at offset 0 was
  // NOT being checked, so any file with 'WEBP' at bytes 8..11 (arbitrary first
  // 8 bytes) passed as image/webp. Anchor both runs.
  {
    mime: 'image/webp',
    runs: [
      { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] }, // 'RIFF'
      { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] }, // 'WEBP'
    ],
  },
  { mime: 'application/pdf', runs: [{ offset: 0, bytes: [0x25, 0x50, 0x44, 0x46] }] },
  // ISO BMFF "ftyp" container variants: HEIC, HEIF, AVIF.
  // Bytes 4..7 == 'ftyp', bytes 8..11 carry the brand.
  // UPFV-04 (defense-in-depth): setiap entri ftyp juga memvalidasi 4 byte
  // pertama sebagai box-size yang waras (konsisten dengan threat model
  // anchoring B-38 untuk WebP) — lihat `isSaneFtypBoxSize`.
  { mime: 'image/heic', runs: [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63] }], validate: isSaneFtypBoxSize }, // ftypheic
  { mime: 'image/heic', runs: [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x78] }], validate: isSaneFtypBoxSize }, // ftypheix
  { mime: 'image/heif', runs: [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70, 0x6D, 0x69, 0x66, 0x31] }], validate: isSaneFtypBoxSize }, // ftypmif1
  { mime: 'image/heif', runs: [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70, 0x6D, 0x73, 0x66, 0x31] }], validate: isSaneFtypBoxSize }, // ftypmsf1
  { mime: 'image/avif', runs: [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66] }], validate: isSaneFtypBoxSize }, // ftypavif
  { mime: 'image/avif', runs: [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x73] }], validate: isSaneFtypBoxSize }, // ftypavis
  // Batch 19 TIM A (item 1): magic-byte video untuk purpose SHOWCASE_VIDEO.
  // ISO-BMFF "ftyp" + brand spesifik (offset 8..11) — HARUS setelah entri
  // heic/heif/avif di atas supaya brand-brand itu tidak salah terdeteksi mp4.
  { mime: 'video/mp4', runs: [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6F, 0x6D] }], validate: isSaneFtypBoxSize }, // ftypisom
  { mime: 'video/mp4', runs: [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6F, 0x32] }], validate: isSaneFtypBoxSize }, // ftypiso2
  // UMD-006: perlebar brand ftyp MP4 yang diterima — brand MP4 valid lain
  // (iso3/iso4/iso5/iso6 dari encoder modern, "M4V " uppercase ala Apple)
  // sebelumnya ditolak MIME_TYPE_MISMATCH padahal isi benar-benar MP4.
  { mime: 'video/mp4', runs: [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6F, 0x33] }], validate: isSaneFtypBoxSize }, // ftypiso3
  { mime: 'video/mp4', runs: [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6F, 0x34] }], validate: isSaneFtypBoxSize }, // ftypiso4
  { mime: 'video/mp4', runs: [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6F, 0x35] }], validate: isSaneFtypBoxSize }, // ftypiso5
  { mime: 'video/mp4', runs: [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6F, 0x36] }], validate: isSaneFtypBoxSize }, // ftypiso6
  { mime: 'video/mp4', runs: [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70, 0x4D, 0x34, 0x56, 0x20] }], validate: isSaneFtypBoxSize }, // ftypM4V␣ (uppercase)
  { mime: 'video/mp4', runs: [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70, 0x6D, 0x70, 0x34, 0x31] }], validate: isSaneFtypBoxSize }, // ftypmp41
  { mime: 'video/mp4', runs: [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70, 0x6D, 0x70, 0x34, 0x32] }], validate: isSaneFtypBoxSize }, // ftypmp42
  { mime: 'video/mp4', runs: [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x63, 0x31] }], validate: isSaneFtypBoxSize }, // ftypavc1
  { mime: 'video/mp4', runs: [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70, 0x6D, 0x34, 0x76, 0x20] }], validate: isSaneFtypBoxSize }, // ftypm4v␣
  { mime: 'video/mp4', runs: [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70, 0x64, 0x61, 0x73, 0x68] }], validate: isSaneFtypBoxSize }, // ftypdash
  { mime: 'video/quicktime', runs: [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20] }], validate: isSaneFtypBoxSize }, // ftypqt␣␣
  // WebM = EBML header (0x1A45DFA3). MKV juga EBML — dibedakan tidak di sini;
  // keduanya container video aman (ekstensi hasil mapping = .webm).
  { mime: 'video/webm', runs: [{ offset: 0, bytes: [0x1A, 0x45, 0xDF, 0xA3] }] },
  // UPFV-01 (audit-fix): signature audio — sebelumnya MAGIC_BYTES tidak punya
  // satu pun signature audio sehingga SEMUA audio (mp3/wav/ogg/m4a) ditolak
  // MIME_TYPE_MISMATCH walau ada di whitelist. Voice note & lampiran audio
  // mati total.
  // mp3: tag ID3v2 ("ID3") atau frame sync MPEG-1 Layer 3 (0xFF 0xFB).
  { mime: 'audio/mpeg', runs: [{ offset: 0, bytes: [0x49, 0x44, 0x33] }] }, // ID3
  { mime: 'audio/mpeg', runs: [{ offset: 0, bytes: [0xFF, 0xFB] }] }, // frame sync
  // wav: container RIFF — anchor ganda seperti WebP (B-38): 'RIFF' di offset
  // 0 dan 'WAVE' di offset 8.
  {
    mime: 'audio/wav',
    runs: [
      { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] }, // 'RIFF'
      { offset: 8, bytes: [0x57, 0x41, 0x56, 0x45] }, // 'WAVE'
    ],
  },
  // ogg: "OggS" di offset 0.
  { mime: 'audio/ogg', runs: [{ offset: 0, bytes: [0x4F, 0x67, 0x67, 0x53] }] }, // OggS
  // m4a: ISO-BMFF "ftyp" + brand "M4A " → dideteksi `audio/mp4`, konsisten
  // dengan konvensi server `.m4a ↔ audio/mp4` (DETECTED_MIME_TO_EXTENSION).
  // Ditempatkan SETELAH entri video/mp4 di atas (brand berbeda, tidak konflik).
  { mime: 'audio/mp4', runs: [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70, 0x4D, 0x34, 0x41, 0x20] }], validate: isSaneFtypBoxSize }, // ftypM4A␣
];

const MIME_HEADER_BYTES = 32;

/**
 * UPFV-04 (defense-in-depth): validasi 4 byte pertama entri ISO-BMFF "ftyp"
 * sebagai box-size yang waras — pasangan dari anchoring B-38 (WebP) untuk
 * threat model yang sama (byte arbitrer yang di-prepend, mis. polyglot
 * HTML/JS, tidak boleh tetap terklasifikasi sebagai container media).
 *
 * 4 byte pertama box ISO-BMFF = ukuran box (uint32 big-endian). ftyp yang
 * valid berukuran minimal 8 (header box); box ftyp asli hanya berisi daftar
 * brand sehingga tidak pernah besar — batas atas 4096 longgar untuk encoder
 * eksotis tapi menyingkirkan sampah (0, 1/"largesize", 0xFFFFFFFF, atau teks
 * arbitrer seperti `<htm…` yang ter-decode > 4096).
 *
 * Penilaian jujur: ini hardening, bukan penutup lubang aktif — exploitability
 * praktis tetap rendah karena ekstensi tersimpan diturunkan dari MIME
 * terdeteksi (SH-S-001) dan file diserve dengan `nosniff`.
 */
function isSaneFtypBoxSize(header: Buffer): boolean {
  if (header.length < 4) return false;
  const size = header.readUInt32BE(0);
  return size >= 8 && size <= 4096;
}

function detectMimeFromBytes(header: Buffer): string | null {
  for (const sig of MAGIC_BYTES) {
    const allRunsMatch = sig.runs.every((run) => {
      if (header.length < run.offset + run.bytes.length) return false;
      for (let i = 0; i < run.bytes.length; i++) {
        if (header[run.offset + i] !== run.bytes[i]) return false;
      }
      return true;
    });
    if (allRunsMatch && (!sig.validate || sig.validate(header))) return sig.mime;
  }
  return null;
}

/** Diekspor untuk test kontrak magic-byte (UPFV-01/UPFV-04). */
export { detectMimeFromBytes };

// B-37 (audit-fix): centralised filename sanitiser used by every code path
// that builds an R2 object-key from a user-supplied filename. Rules:
//   - allow only [a-zA-Z0-9._-]
//   - replace everything else with `_`
//   - strip leading dots (so we don't create ".env"-shaped keys)
//   - collapse runs of `_` and trim the length
//   - if the result is empty (e.g. caller passed "...") fall back to "file"
function sanitizeStoredFileName(rawFileName: string): string {
  let s = (rawFileName || '').replace(/[^a-zA-Z0-9._-]/g, '_');
  s = s.replace(/^\.+/, '');
  s = s.replace(/_+/g, '_');
  if (s.length > 120) s = s.slice(0, 120);
  if (!s || s === '.' || s === '_') s = 'file';
  return s;
}

const FILE_KEY_PATTERN = /^(?:uploads\/[a-z-]+\/[a-zA-Z0-9_-]+\/[\w.-]+|(?:avatars|headers)\/[a-zA-Z0-9_-]+\/[\w.-]+)$/;
// BFI-103: alternatif kedua = key avatar/header LEGACY tanpa prefix
// `uploads/` (avatars/<uid>/…, headers/<uid>/…) — kompatibilitas mundur:
// file lama di disk & URL lama tidak berubah, validator tetap menerima
// bentuk key yang tersimpan sebelum kanonisasi. Batasan traversal
// (`..`, `//`, `\`, `%`) tetap dicek terpisah di isSafeFileKey.

// B-39 (audit-fix): single guard that EVERY code path turning a client-supplied
// file key into an S3 operation must run. Previously only `confirmUpload()`
// performed the traversal + shape check; `cleanupFileKeys()` and
// `verifyEvidenceFileKeys*()` only asserted `segments[2] === userId`, so a key
// such as `uploads/dispute-evidence/<myId>/../../kyc-ktp/<victimId>/ktp.jpg`
// passed their ownership test and was handed straight to R2.
// SH-S-004: diekspor agar upload.controller (downloadOwnFile) bisa memakainya
// sebagai validasi bentuk key baris-pertama (400 terkontrol, bukan 500).
export function isSafeFileKey(fileKey: unknown): fileKey is string {
  if (typeof fileKey !== 'string') return false;
  if (fileKey.length === 0 || fileKey.length > 512) return false;
  if (fileKey.includes('..') || fileKey.includes('//') || fileKey.includes('\\') || fileKey.includes('%')) return false;
  return FILE_KEY_PATTERN.test(fileKey);
}

// Type-safe visibility declaration: any new UploadPurpose forces a TS error here
// (Record<UploadPurpose,...> is exhaustive). Public-by-default is no longer possible.
const PURPOSE_VISIBILITY: Record<UploadPurpose, 'private' | 'public'> = {
  [UploadPurpose.KYC_KTP]: 'private',
  [UploadPurpose.KYC_SELFIE]: 'private',
  [UploadPurpose.KYC_PASSPORT]: 'private',
  [UploadPurpose.KYC_LIVENESS]: 'private',
  [UploadPurpose.BUSINESS_DOCUMENT]: 'private',
  [UploadPurpose.SHOWCASE_IMAGE]: 'public',
  // Batch 19 TIM A (item 1): video showcase tampil publik di feed — diserve
  // nginx dengan HTTP Range (seek). Thumbnail-nya masuk SHOWCASE_IMAGE.
  [UploadPurpose.SHOWCASE_VIDEO]: 'public',
  [UploadPurpose.STORY_MEDIA]: 'private',
  [UploadPurpose.STORY_HIGHLIGHT]: 'private',
  [UploadPurpose.AVATAR]: 'public',
  // BE-5: aset digital privat — hanya pemilik & pembeli berbayar (signed URL).
  [UploadPurpose.DIGITAL_ASSET]: 'private',
  [UploadPurpose.CHAT_ATTACHMENT]: 'private',
  [UploadPurpose.DISPUTE_EVIDENCE]: 'private',
  [UploadPurpose.REPORT_EVIDENCE]: 'private',
  [UploadPurpose.DELIVERY_PROOF]: 'private',
  // BFI-097: bukti milestone — privat (signed URL kedaluwarsa).
  [UploadPurpose.MILESTONE_EVIDENCE]: 'private',
  // Karir (Fase F2): CV privat — nginx TIDAK serve prefix career-cvs/
  // (deploy/nginx.conf: hanya avatars/headers/showcase-images publik;
  // sisanya 404). Akses baca hanya via signed URL HMAC + guard SUPER_ADMIN.
  [UploadPurpose.CAREER_CV]: 'private',
};

const PURPOSE_FOLDER_MAP_INTERNAL: Record<UploadPurpose, string> = {
  [UploadPurpose.KYC_KTP]: 'kyc-ktp',
  [UploadPurpose.KYC_SELFIE]: 'kyc-selfie',
  [UploadPurpose.KYC_PASSPORT]: 'kyc-passport',
  [UploadPurpose.KYC_LIVENESS]: 'kyc-liveness',
  [UploadPurpose.BUSINESS_DOCUMENT]: 'business-documents',
  [UploadPurpose.SHOWCASE_IMAGE]: 'showcase-images',
  [UploadPurpose.SHOWCASE_VIDEO]: 'showcase-videos',
  [UploadPurpose.STORY_MEDIA]: 'story-media',
  [UploadPurpose.STORY_HIGHLIGHT]: 'story-highlights',
  [UploadPurpose.AVATAR]: 'avatars',
  [UploadPurpose.DIGITAL_ASSET]: 'digital-assets',
  [UploadPurpose.CHAT_ATTACHMENT]: 'chat-attachments',
  [UploadPurpose.DISPUTE_EVIDENCE]: 'dispute-evidence',
  [UploadPurpose.REPORT_EVIDENCE]: 'report-evidence',
  [UploadPurpose.DELIVERY_PROOF]: 'delivery-proof',
  // BFI-097: folder privat baru untuk bukti milestone.
  [UploadPurpose.MILESTONE_EVIDENCE]: 'milestone-evidence',
  // Karir (Fase F2): folder privat CV pelamar.
  [UploadPurpose.CAREER_CV]: 'career-cvs',
};

// Reverse of PURPOSE_FOLDER_MAP_INTERNAL, derived rather than hand-written so a new
// UploadPurpose cannot be added to one map and forgotten in the other. Values are
// `UploadPurpose | undefined` because the folder segment comes from a client-supplied
// file key, so an unknown folder must be representable and rejected by the caller.
const PURPOSE_BY_FOLDER: Record<string, UploadPurpose | undefined> = Object.fromEntries(
  (Object.keys(PURPOSE_FOLDER_MAP_INTERNAL) as UploadPurpose[])
    .map((p) => [PURPOSE_FOLDER_MAP_INTERNAL[p], p]),
);

/**
 * UPI-02: nama folder tingkat-atas di DISK LOKAL untuk semua upload.
 * `LocalStorageService.resolvePath` men-strip prefix `uploads/` saat simpan,
 * jadi layout nyata adalah `<storage>/<folder>/<userId>/<file>`.
 * Dipakai janitor orphan agar tidak menyentuh `.chunks`, `smoke-test`,
 * `account-exports`/`admin-exports`, atau direktori non-upload lain.
 */
export const UPLOAD_DISK_FOLDER_NAMES: ReadonlySet<string> = new Set([
  ...Object.values(PURPOSE_FOLDER_MAP_INTERNAL),
  // Bukan UploadPurpose — dikelola users.service (avatar/header direct).
  'headers',
]);

// Derived from the typed visibility map — the source of truth is PURPOSE_VISIBILITY.
const PRIVATE_FOLDER_PREFIXES: string[] = (Object.keys(PURPOSE_VISIBILITY) as UploadPurpose[])
  .filter((p) => PURPOSE_VISIBILITY[p] === 'private')
  .map((p) => `uploads/${PURPOSE_FOLDER_MAP_INTERNAL[p]}/`);

// Batch 1A (ST-005): visibility classification yang di-ENFORCE. Sebelumnya
// `isPrivatePath()` adalah dead code (nol call site) — sekarang dipakai oleh
// generateDownloadUrl(), uploadDirect(), dan endpoint download terautentikasi.
export function isPrivateFileKey(fileKey: string): boolean {
  return PRIVATE_FOLDER_PREFIXES.some(prefix => fileKey.startsWith(prefix))
    || fileKey.startsWith('uploads/account-exports/')
    // GAP-E (G380): hasil ekspor CSV admin — privat + signed URL kedaluwarsa.
    || fileKey.startsWith('uploads/admin-exports/');
}

/** Prefix folder publik yang diserve langsung oleh nginx tanpa auth. */
export const PUBLIC_FOLDER_PREFIXES = ['uploads/avatars/', 'uploads/headers/', 'uploads/showcase-images/', 'uploads/showcase-videos/'];

export function isPublicFileKey(fileKey: string): boolean {
  return PUBLIC_FOLDER_PREFIXES.some(prefix => fileKey.startsWith(prefix));
}

/**
 * Batch 19 TIM A (item 1): hasil upload direct. Field tambahan (thumbnail,
 * durasi, dimensi) HANYA diisi untuk purpose SHOWCASE_VIDEO — respons purpose
 * lain tidak berubah bentuknya (aditif).
 *
 * PERF-FIX (NP-001): `thumbnailFileKey`/`thumbnailUrl` JUGA diisi untuk
 * purpose SHOWCASE_IMAGE (thumbnail JPEG ~640px via sharp) — respons tetap
 * aditif (field opsional yang sebelumnya selalu undefined untuk gambar).
 */
export interface DirectUploadResult {
  fileKey: string;
  fileUrl: string;
  /**
   * SHOWCASE_VIDEO: key thumbnail JPEG hasil ffmpeg (sudah terkonfirmasi).
   * SHOWCASE_IMAGE (PERF-FIX NP-001): key thumbnail JPEG hasil sharp (sudah
   * terkonfirmasi) — dilampirkan sebagai `thumbnailFileKey` saat membuat
   * media etalase supaya `thumbnailUrl` terisi di respons feed.
   */
  thumbnailFileKey?: string;
  /** SHOWCASE_VIDEO: URL publik thumbnail. SHOWCASE_IMAGE: URL publik thumbnail. */
  thumbnailUrl?: string;
  /** SHOWCASE_VIDEO: durasi detik (dibulatkan). */
  durationSec?: number;
  /** SHOWCASE_VIDEO: dimensi stream video pertama. */
  width?: number;
  height?: number;
}

/**
 * BFI-060/BFI-099 (audit integrasi 2026-09-30): exception file-kebesaran yang
 * SELALU 413 `PayloadTooLargeException` dengan kode terstruktur — dipakai
 * `uploadDirect` MAUPUN `chunked init` agar kode konsisten di semua jalur:
 * - SHOWCASE_VIDEO → `VIDEO_TOO_LARGE` + pesan Indonesia
 * - purpose lain   → `FILE_TOO_LARGE`
 * HttpExceptionFilter meneruskan `code` dari body, jadi FE tetap bisa
 * memetakan copy per kode (lihat VIDEO_UPLOAD_ERROR_COPY).
 */
export function fileTooLargeException(purpose: UploadPurpose | undefined, maxSize: number): PayloadTooLargeException {
  if (purpose === UploadPurpose.STORY_MEDIA) {
    return new PayloadTooLargeException({
      code: 'STORY_MEDIA_TOO_LARGE',
      message: 'Ukuran foto story maksimal 10 MB.',
    });
  }
  if (purpose === UploadPurpose.SHOWCASE_VIDEO) {
    return new PayloadTooLargeException({
      code: ErrorCodes.VIDEO_TOO_LARGE,
      message: `Ukuran video melebihi batas maksimal ${Math.round(maxSize / 1024 / 1024)} MB. Maksimal 100 MB / 180 detik.`,
    });
  }
  return new PayloadTooLargeException({
    code: ErrorCodes.FILE_TOO_LARGE,
    message: `File exceeds maximum allowed size of ${Math.round(maxSize / 1024 / 1024)} MB`,
  });
}

@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);

  constructor(
    private configService: ConfigService,
    private redis: RedisService,
    private localStorage: LocalStorageService,
    private videoProcessing: VideoProcessingService,
  ) {}

  // ── Batch 1A (ST-002/03-#1): signed URL HMAC untuk file privat ──
  // Menggantikan semantik presigned-URL R2: URL kedaluwarsa yang hanya bisa
  // dibuat server-side setelah otorisasi. Secret dari STORAGE_URL_SECRET
  // (opsional), fallback ke JWT_SECRET (wajib, ≥32 char).
  private getUrlSigningSecret(): string {
    const dedicated = this.configService.get<string>('STORAGE_URL_SECRET');
    if (dedicated && dedicated.trim().length >= 16) return dedicated.trim();
    const jwtSecret = this.configService.get<string>('jwt.secret') || this.configService.get<string>('JWT_SECRET');
    if (!jwtSecret) {
      throw new Error('URL signing secret unavailable: set STORAGE_URL_SECRET or JWT_SECRET');
    }
    return jwtSecret;
  }

  private buildSignedDownloadUrl(fileKey: string, expiresIn: number): string {
    const exp = Math.floor(Date.now() / 1000) + Math.max(60, expiresIn);
    const sig = createHmac('sha256', this.getUrlSigningSecret())
      .update(`${fileKey}:${exp}`)
      .digest('hex');
    const publicBase = (this.configService.get<string>('app.storagePublicUrl') || 'https://api.kahade.id/uploads').replace(/\/+$/, '');
    // Basis API = publicBase tanpa segmen /uploads terakhir.
    const apiBase = publicBase.replace(/\/uploads\/?$/, '') || publicBase;
    return `${apiBase}/v1/upload/s?key=${encodeURIComponent(fileKey)}&exp=${exp}&sig=${sig}`;
  }

  /**
   * G100: buat URL unduhan bertanda waktu on-demand untuk artefak ekspor.
   * Hanya untuk key privat yang aman; pemanggil wajib sudah mengotorisasi
   * kepemilikan (mis. SettingsService.downloadExportRequest).
   */
  createSignedDownloadUrl(fileKey: string, expiresInSeconds: number): { downloadUrl: string; expiresAt: Date } {
    if (!isSafeFileKey(fileKey) || !isPrivateFileKey(fileKey)) {
      throw new BadRequestException({ code: ErrorCodes.INVALID_FILE_TYPE, message: 'Invalid private file key' });
    }
    const downloadUrl = this.buildSignedDownloadUrl(fileKey, expiresInSeconds);
    const exp = Number(new URL(downloadUrl).searchParams.get('exp')) * 1000;
    return { downloadUrl, expiresAt: new Date(exp) };
  }

  /** Verifikasi query signed download. Kembalikan fileKey bila valid. */  verifySignedDownload(key: string, exp: string, sig: string): string | null {
    if (!isSafeFileKey(key) || !isPrivateFileKey(key)) return null;
    const expNum = Number(exp);
    if (!Number.isInteger(expNum) || expNum <= Math.floor(Date.now() / 1000)) return null;
    if (!/^[0-9a-f]{64}$/.test(sig)) return null;
    let expected: Buffer;
    try {
      expected = Buffer.from(
        createHmac('sha256', this.getUrlSigningSecret()).update(`${key}:${expNum}`).digest('hex'),
        'hex',
      );
    } catch {
      return null;
    }
    const actual = Buffer.from(sig, 'hex');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    return key;
  }

  /**
   * Stream byte file privat untuk endpoint download terautentikasi.
   *
   * UPV-01 (audit upload video 2026-10-03): mendukung header HTTP `Range`
   * (single-range `bytes=start-end`) sehingga video privat (chat/sengketa)
   * bisa di-seek seperti video showcase publik yang diserve nginx (206).
   * Auth + ownership check tetap di controller — fungsi ini tidak mengubah
   * otorisasi apa pun.
   *
   * - `contentRange` non-null → caller WAJIB balas 206 + `Content-Range`.
   * - `rangeUnsatisfiable` true → caller WAJIB balas 416 + `Content-Range: bytes *\/<size>`.
   * - Keduanya null/false → balas 200 penuh seperti sebelumnya.
   * - File ekspor terenkripsi (account/admin-exports): Range DIABAIKAN
   *   (dekripsi butuh file utuh; bukan video sehingga seek tak relevan).
   */
  async getPrivateFileStream(
    fileKey: string,
    rangeHeader?: string,
  ): Promise<{
    stream: Readable;
    contentType: string;
    size: number;
    contentRange: { start: number; end: number } | null;
    rangeUnsatisfiable: boolean;
  }> {
    if (!isSafeFileKey(fileKey) || !isPrivateFileKey(fileKey)) {
      throw new BadRequestException({ code: ErrorCodes.INVALID_FILE_TYPE, message: 'Invalid private file key' });
    }
    const size = await this.localStorage.getFileSize(fileKey);
    if (size === null) {
      throw new NotFoundException({ code: ErrorCodes.FILE_NOT_FOUND_OR_EXPIRED, message: 'File not found' });
    }
    const isEncryptedExport =
      fileKey.startsWith('uploads/account-exports/') || fileKey.startsWith('uploads/admin-exports/');
    let contentRange: { start: number; end: number } | null = null;
    let rangeUnsatisfiable = false;
    if (rangeHeader && !isEncryptedExport) {
      const parsed = parseHttpRange(rangeHeader, size);
      if (parsed === 'unsatisfiable') {
        rangeUnsatisfiable = true;
      } else if (parsed) {
        contentRange = parsed;
      }
    }
    let stream: Readable = this.localStorage.createReadStream(
      fileKey,
      contentRange ?? undefined,
    ) as Readable;
    // ST-019: export akun disimpan terenkripsi at-rest — dekripsi saat serve.
    // Fallback: file lama (sebelum enkripsi) yang sudah berupa JSON diserve
    // apa adanya agar masa transisi tidak merusak unduhan yang sedang berjalan.
    if (fileKey.startsWith('uploads/account-exports/') || fileKey.startsWith('uploads/admin-exports/')) {
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString('utf-8');
      let buf: Buffer;
      try {
        const decryptedB64 = await decryptAES(raw);
        buf = Buffer.from(decryptedB64, 'base64');
      } catch {
        if (raw.trimStart().startsWith('{')) {
          buf = Buffer.from(raw, 'utf-8');
        } else {
          throw new BadRequestException({ code: ErrorCodes.FILE_NOT_FOUND_OR_EXPIRED, message: 'Export file is unavailable or corrupted' });
        }
      }
      stream = Readable.from([buf]);
      // G098: arsip CSV dikemas sebagai ZIP — content-type mengikuti ekstensi.
      // GAP-E (G380): ekspor CSV admin → text/csv.
      const contentType = fileKey.startsWith('uploads/admin-exports/')
        ? 'text/csv; charset=utf-8'
        : fileKey.endsWith('.zip') ? 'application/zip' : 'application/json';
      // Ekspor terenkripsi selalu diserve penuh (Range diabaikan di atas).
      return { stream, contentType, size: buf.length, contentRange: null, rangeUnsatisfiable: false };
    }
    return {
      stream,
      contentType: this.localStorage.getContentType(fileKey),
      size,
      contentRange,
      rangeUnsatisfiable,
    };
  }

  // ── Self-hosted storage (2026-09-26): R2 diganti local disk. ──
  // getS3Client(), getBucket(), getBucketForKey() dihapus.

  async generatePresignedUrl(userId: string, purpose: UploadPurpose, fileName: string, contentType: string, fileSize: number): Promise<{ uploadUrl: string; fileKey: string; expiresIn: number; minFileSize: number; maxFileSize: number }> {
    // DEPRECATED 2026-09-26: R2 dihapus, storage self-hosted di disk server.
    // Tidak ada presigned URL lagi — gunakan POST /v1/upload/direct (multipart).
    throw new BadRequestException({
      code: 'DEPRECATED',
      message: 'Presigned URL upload is no longer supported. Use POST /v1/upload/direct instead.',
    });
  }

  async confirmUpload(userId: string, fileKey: string, sha256?: string): Promise<{ fileKey: string; confirmed: boolean; sha256?: string; verified?: boolean }> {
    let decodedKey: string;
    try {
      decodedKey = decodeURIComponent(fileKey);
    } catch {
      // Malformed percent-encoding (e.g. "%zz") makes decodeURIComponent throw a
      // URIError, which escaped as an unhandled 500 instead of a 400.
      throw new BadRequestException({
        code: ErrorCodes.INVALID_FILE_TYPE,
        message: 'Invalid file key encoding',
      });
    }

    if (!isSafeFileKey(decodedKey)) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_FILE_TYPE,
        message: 'Invalid file key format',
      });
    }

    const segments = decodedKey.split('/');
    if (segments.length !== 4 || segments[2] !== userId) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_FILE_TYPE,
        message: 'File key does not belong to this user',
      });
    }

    const folderName = segments[1];
    const detectedPurpose = PURPOSE_BY_FOLDER[folderName];
    // Reject unknown folders outright. Previously an unrecognised folder simply
    // skipped ALL content validation (`if (detectedPurpose)` below) and still
    // returned confirmed:true, marking the key as usable downstream.
    if (!detectedPurpose) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_FILE_TYPE,
        message: 'Invalid file key format',
      });
    }

    const redisKey = `confirmed_upload:${userId}:${decodedKey}`;
    const isNew = await this.redis.setNx(redisKey, '1', CONFIRMED_KEY_TTL_SECONDS);
    if (!isNew) {
      throw new ConflictException({
        code: ErrorCodes.UPLOAD_ALREADY_CONFIRMED,
        message: 'This file has already been confirmed. Use a fresh upload for a new submission.',
      });
    }

    const exists = await this.localStorage.fileExists(decodedKey);

    let storedContentType: string | undefined;
    if (!exists) {
      await this.redis.del(redisKey);
      this.logger.error(`Local storage file not found for key=${decodedKey}`);
      throw new NotFoundException({
        code: ErrorCodes.FILE_NOT_FOUND_OR_EXPIRED,
        message: 'File not found in storage. It may not have been uploaded or has expired.',
      });
    }
    const contentLength = await this.localStorage.getFileSize(decodedKey) ?? undefined;
    // storedContentType tidak tersedia di local storage — deteksi dari bytes di bawah (lebih kuat).

    if (detectedPurpose) {
      const allowedTypes = ALLOWED_CONTENT_TYPES[detectedPurpose];
      if (storedContentType && !allowedTypes.includes(storedContentType)) {
        await this.redis.del(redisKey);
        throw new BadRequestException({
          code: ErrorCodes.MIME_TYPE_MISMATCH,
          message: `Stored content type ${storedContentType} is not allowed for this upload slot`,
        });
      }

      if (contentLength !== undefined && contentLength < MIN_FILE_SIZE) {
        await this.redis.del(redisKey);
        throw new BadRequestException({
          code: ErrorCodes.INVALID_FILE_TYPE,
          message: `File is too small (${contentLength} bytes). Minimum size is ${MIN_FILE_SIZE} bytes`,
        });
      }

      const maxSize = MAX_FILE_SIZE[detectedPurpose];
      if (contentLength !== undefined && contentLength > maxSize) {
        await this.redis.del(redisKey);
        throw fileTooLargeException(detectedPurpose, maxSize);
      }

      try {
        // B-36 (audit-fix): widen the byte-range to cover the ISO BMFF brand
        // signatures at offset 4..11. 31-byte upper bound is plenty.
        const header = await this.localStorage.readFileRange(decodedKey, 0, MIME_HEADER_BYTES - 1);
        const detectedMime = detectMimeFromBytes(header);
        if (!detectedMime) {
          await this.redis.del(redisKey);
          throw new BadRequestException({
            code: ErrorCodes.MIME_TYPE_MISMATCH,
            message: 'Unable to identify file type from content. Upload rejected.',
          });
        }
        if (storedContentType && detectedMime !== storedContentType) {
          await this.redis.del(redisKey);
          throw new BadRequestException({
            code: ErrorCodes.MIME_TYPE_MISMATCH,
            message: `File content (${detectedMime}) does not match declared type (${storedContentType})`,
          });
        }
        if (!allowedTypes.includes(detectedMime)) {
          await this.redis.del(redisKey);
          throw new BadRequestException({
            code: ErrorCodes.MIME_TYPE_MISMATCH,
            message: `Actual file type ${detectedMime} is not allowed for this upload slot`,
          });
        }
      } catch (error) {
        if (error instanceof BadRequestException) throw error;
        this.logger.error(`Magic-byte check failed for key=${decodedKey}: ${(error as Error).message}`);
        await this.redis.del(redisKey);
        throw new BadRequestException({
          code: ErrorCodes.MIME_TYPE_MISMATCH,
          message: 'Unable to verify file content integrity. Please re-upload.',
        });
      }
    }

    const result: { fileKey: string; confirmed: boolean; sha256?: string; verified?: boolean } = {
      fileKey: decodedKey,
      confirmed: true,
    };

    if (sha256) {
      // B-40 (audit-fix): this block used to echo the CLIENT-supplied hash straight
      // back and set verified:true without ever hashing the stored object. The
      // client-side integrity check in
      // apps/mobile/lib/hooks/useOrderProofUpload.ts (`confirmResp.sha256 !==
      // localHash`) was therefore comparing a value to itself and could never
      // fail — a corrupted or swapped upload reported as "verified". Hash what we
      // actually stored. ContentLength is already bounded by MAX_FILE_SIZE for the
      // purpose above, so streaming the whole body is safe and never buffers it.
      let computed: string;
      try {
        const hash = createHash('sha256');
        const stream = this.localStorage.createReadStream(decodedKey);
        for await (const chunk of stream) {
          hash.update(chunk as Buffer);
        }
        computed = hash.digest('hex');
      } catch (error) {
        this.logger.error(`SHA-256 verification read failed for key=${decodedKey}: ${(error as Error).message}`);
        await this.redis.del(redisKey);
        throw new BadRequestException({
          code: ErrorCodes.UPLOAD_FAILED,
          message: 'Unable to verify uploaded file integrity. Please re-upload.',
        });
      }

      if (computed !== sha256.toLowerCase()) {
        this.logger.warn(`SHA-256 mismatch for key=${decodedKey} (expected client hash did not match stored object)`);
        await this.redis.del(redisKey);
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'Uploaded file checksum does not match the provided sha256 value. Please re-upload.',
        });
      }

      result.sha256 = computed;
      result.verified = true;
    }

    return result;
  }

  isConfirmedUploadKey(userId: string, fileKey: string): Promise<boolean> {
    if (!isSafeFileKey(fileKey)) return Promise.resolve(false);
    const segments = fileKey.split('/');
    if (segments.length !== 4 || segments[2] !== userId || !PURPOSE_BY_FOLDER[segments[1]]) {
      return Promise.resolve(false);
    }
    const redisKey = `confirmed_upload:${userId}:${fileKey}`;
    return this.redis.get(redisKey).then((val) => val !== null);
  }

  async verifyEvidenceFileKeys(userId: string, fileKeys: string[], evidenceType: 'dispute-evidence' | 'report-evidence' = 'dispute-evidence'): Promise<void> {
    const prefix = `uploads/${evidenceType}/${userId}/`;
    const purpose = evidenceType === 'dispute-evidence' ? UploadPurpose.DISPUTE_EVIDENCE : UploadPurpose.REPORT_EVIDENCE;
    const maxSize = MAX_FILE_SIZE[purpose];

    for (const key of fileKeys) {
      // B-39: shape/traversal check BEFORE the prefix check. `startsWith(prefix)`
      // alone accepts `uploads/dispute-evidence/<myId>/../../kyc-ktp/<victim>/x.jpg`.
      if (!isSafeFileKey(key) || !key.startsWith(prefix) || key.split('/').length !== 4) {
        throw new BadRequestException({
          code: ErrorCodes.FILE_ACCESS_DENIED,
          message: 'One or more files were not uploaded by you or are not valid evidence files',
        });
      }

      const isConfirmed = await this.isConfirmedUploadKey(userId, key);
      if (!isConfirmed) {
        throw new BadRequestException({
          code: ErrorCodes.UPLOAD_NOT_CONFIRMED,
          message: `File must be confirmed via /upload/confirm before use: ${key}`,
        });
      }

      const contentLength = await this.localStorage.getFileSize(key);
      if (contentLength === null) {
        throw new NotFoundException({
          code: ErrorCodes.FILE_NOT_FOUND_OR_EXPIRED,
          message: `Evidence file not found in storage: ${key}`,
        });
      }

      if (contentLength !== undefined && contentLength > maxSize) {
        // BFI-060: file kebesaran → 413 (bukan 400), kode tetap FILE_TOO_LARGE.
        throw new PayloadTooLargeException({
          code: ErrorCodes.FILE_TOO_LARGE,
          message: `Evidence file exceeds maximum allowed size of ${Math.round(maxSize / 1024 / 1024)} MB`,
        });
      }

      const consumeKey = `confirmed_upload:${userId}:${key}`;
      const consumed = await this.redis.consumeOnce(consumeKey, { throwOnError: true });
      if (!consumed) {
        throw new BadRequestException({
          code: ErrorCodes.UPLOAD_NOT_CONFIRMED,
          message: `File confirmation has already been consumed: ${key}`,
        });
      }
    }
  }

  async verifyEvidenceFileKeysBatch(
    userId: string,
    fileKeys: string[],
    fileTypes: string[],
    evidenceType: 'dispute-evidence' | 'report-evidence' = 'dispute-evidence',
  ): Promise<{ fileKey: string; fileType: string; status: 'ok' | 'error'; error?: string }[]> {
    const prefix = `uploads/${evidenceType}/${userId}/`;
    const purpose = evidenceType === 'dispute-evidence' ? UploadPurpose.DISPUTE_EVIDENCE : UploadPurpose.REPORT_EVIDENCE;
    const maxSize = MAX_FILE_SIZE[purpose];
    const allowedTypes = ALLOWED_CONTENT_TYPES[purpose];

    const results = await Promise.all(
      fileKeys.map(async (key, idx) => {
        const fileType = fileTypes[idx] || 'application/octet-stream';
        try {
          // B-39: see verifyEvidenceFileKeys — prefix match alone permits traversal.
          if (!isSafeFileKey(key) || !key.startsWith(prefix) || key.split('/').length !== 4) {
            return { fileKey: key, fileType, status: 'error' as const, error: 'File was not uploaded by you or is not a valid evidence file' };
          }

          if (!allowedTypes.includes(fileType)) {
            return { fileKey: key, fileType, status: 'error' as const, error: `File type not allowed: ${fileType}` };
          }

          const isConfirmed = await this.isConfirmedUploadKey(userId, key);
          if (!isConfirmed) {
            return { fileKey: key, fileType, status: 'error' as const, error: 'File must be confirmed via /upload/confirm before use' };
          }

          const contentLength = await this.localStorage.getFileSize(key);
          if (contentLength === null) {
            return { fileKey: key, fileType, status: 'error' as const, error: 'Evidence file not found in storage' };
          }

          if (contentLength !== undefined && contentLength > maxSize) {
            return { fileKey: key, fileType, status: 'error' as const, error: `File exceeds maximum allowed size of ${Math.round(maxSize / 1024 / 1024)} MB` };
          }

          const consumeKey = `confirmed_upload:${userId}:${key}`;
          const consumed = await this.redis.consumeOnce(consumeKey, { throwOnError: true });
          if (!consumed) {
            return { fileKey: key, fileType, status: 'error' as const, error: 'File confirmation has already been consumed' };
          }

          return { fileKey: key, fileType, status: 'ok' as const };
        } catch {
          return { fileKey: key, fileType, status: 'error' as const, error: 'Unexpected validation error' };
        }
      }),
    );

    return results;
  }

  /**
   * Validasi file key hasil upload presigned milik user: bentuk key, kepemilikan,
   * konfirmasi /upload/confirm, ukuran tersimpan, dan content type tersimpan.
   *
   * `opts.maxFiles`  — batas jumlah file (default 5, perilaku lama).
   * `opts.consume`   — konsumsi konfirmasi upload (default true). Set false bila
   *                    pemanggil masih bisa gagal SETELAH validasi ini dan file
   *                    harus tetap bisa dipakai ulang (pola business-verification).
   * `opts.label`     — kata benda untuk pesan error (default "Attachment").
   *
   * Bucket diturunkan dari `purpose` (PURPOSE_VISIBILITY), bukan hardcoded private,
   * supaya purpose public seperti SHOWCASE_IMAGE/AVATAR bisa lewat jalur yang sama.
   */
  async verifyUserFileKeys(
    userId: string,
    fileKeys: string[],
    purpose: UploadPurpose,
    opts?: { maxFiles?: number; consume?: boolean; label?: string },
  ): Promise<void> {
    const folder = UploadService.PURPOSE_FOLDER_MAP[purpose];
    const prefix = `uploads/${folder}/${userId}/`;
    const allowedTypes = ALLOWED_CONTENT_TYPES[purpose];
    const maxSize = MAX_FILE_SIZE[purpose];
    const maxFiles = opts?.maxFiles ?? 5;
    const shouldConsume = opts?.consume ?? true;
    const label = opts?.label ?? 'Attachment';
    if (!Array.isArray(fileKeys) || fileKeys.length > maxFiles) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: `Too many ${label.toLowerCase()} files (max ${maxFiles})` });
    }
    if (new Set(fileKeys).size !== fileKeys.length) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: `Duplicate ${label.toLowerCase()} file keys are not allowed` });
    }

    for (const fileKey of fileKeys) {
      if (!isSafeFileKey(fileKey) || !fileKey.startsWith(prefix) || fileKey.split('/').length !== 4) {
        throw new BadRequestException({ code: ErrorCodes.FILE_ACCESS_DENIED, message: `${label} file key is not owned by this user or has the wrong purpose` });
      }
      if (!(await this.isConfirmedUploadKey(userId, fileKey))) {
        throw new BadRequestException({ code: ErrorCodes.UPLOAD_NOT_CONFIRMED, message: `${label} must be confirmed before it can be attached` });
      }

      const contentLength = await this.localStorage.getFileSize(fileKey);
      if (contentLength === null || contentLength < MIN_FILE_SIZE) {
        throw new BadRequestException({ code: ErrorCodes.FILE_TOO_LARGE, message: `${label} file size is outside the allowed range` });
      }
      // Batas video etalase resmi (keputusan user 2026-09-28): 100MB / 180 detik.
      if (contentLength > maxSize) {
        throw fileTooLargeException(purpose, maxSize);
      }
      // Content type dideteksi dari bytes saat confirm — local storage tidak
      // menyimpan ContentType terpisah, jadi skip check ContentType di sini.
    }

    if (!shouldConsume) return;
    for (const fileKey of fileKeys) {
      const consumed = await this.redis.consumeOnce(`confirmed_upload:${userId}:${fileKey}`, { throwOnError: true });
      if (!consumed) {
        throw new ConflictException({ code: ErrorCodes.UPLOAD_NOT_CONFIRMED, message: `${label} confirmation has already been consumed` });
      }
    }
  }

  /**
   * URL publik untuk file di storage lokal (AVATAR / SHOWCASE_IMAGE / dll).
   * Diserve nginx dari STORAGE_PATH via https://api.kahade.id/uploads/.
   */
  buildPublicUrl(fileKey: string): string {
    return this.localStorage.getPublicUrl(fileKey);
  }

  /**
   * Batch 19 TIM A: kebalikan buildPublicUrl — kembalikan fileKey dari URL
   * publik, atau null bila URL tidak cocok dengan base storage. Dipakai untuk
   * cleanup thumbnail lama saat media etalase diganti (hanya thumbnailUrl yang
   * tersimpan di DB, bukan key-nya).
   */
  fileKeyFromPublicUrl(url: string): string | null {
    const publicBase = (this.configService.get<string>('app.storagePublicUrl') || 'https://api.kahade.id/uploads').replace(/\/+$/, '');
    if (typeof url !== 'string' || !url.startsWith(`${publicBase}/`)) return null;
    const fileKey = `uploads/${url.slice(publicBase.length + 1)}`;
    return isSafeFileKey(fileKey) ? fileKey : null;
  }

  /**
   * LOW (SEC-D): ekstrak fileKey dari URL yang tersimpan di DB — baik URL
   * publik (`.../uploads/<key>`) maupun signed URL privat
   * (`/v1/upload/s?key=<key>&exp=..&sig=..`). Tabel `chat_attachments` tidak
   * menyimpan fileKey (additive-only), jadi worker purge ephemeral memakai ini
   * untuk menghapus file fisik lampiran. Kembalikan null bila tidak dikenali.
   */
  fileKeyFromStoredUrl(url: string): string | null {
    if (typeof url !== 'string' || url.length === 0) return null;
    const fromPublic = this.fileKeyFromPublicUrl(url);
    if (fromPublic) return fromPublic;
    try {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/v1/upload/s')) {
        const key = parsed.searchParams.get('key');
        if (key && isSafeFileKey(key)) return key;
      }
    } catch {
      // Bukan URL absolut — tidak dikenali.
    }
    return null;
  }

  /**
   * LOW (SEC-D): hapus SATU file fisik by fileKey. Best-effort — kembalikan
   * false (bukan throw) bila key tidak aman atau penghapusan gagal, agar
   * worker purge bisa mencatat & me-retry tanpa menggagalkan batch.
   */
  async deleteStoredFile(fileKey: string): Promise<boolean> {
    if (!isSafeFileKey(fileKey)) {
      this.logger.warn(`[SECURITY] deleteStoredFile menolak fileKey tidak aman: ${String(fileKey).slice(0, 64)}`);
      return false;
    }
    return this.localStorage.deleteFile(fileKey);
  }

  /**
   * SH-B-007: konsumsi konfirmasi upload one-time TANPA validasi ulang.
   * Dipakai pemanggil yang sudah memvalidasi via `verifyUserFileKeys(...,
   * { consume: false })` dan baru boleh meng-consume SETELAH mutasi DB-nya
   * sukses — supaya kegagalan DB tidak membuat file yatim / user upload ulang.
   * Idempotent-safe: bila key sudah ter-consume (balapan), melempar 409.
   */
  async consumeUploadConfirmations(userId: string, fileKeys: string[]): Promise<void> {
    for (const fileKey of fileKeys) {
      const consumed = await this.redis.consumeOnce(`confirmed_upload:${userId}:${fileKey}`, { throwOnError: true });
      if (!consumed) {
        throw new ConflictException({
          code: ErrorCodes.UPLOAD_NOT_CONFIRMED,
          message: 'File confirmation has already been consumed or expired',
        });
      }
    }
  }

  async getFileSize(fileKey: string): Promise<number> {
    if (!isSafeFileKey(fileKey) || !this.isKnownStorageKey(fileKey)) throw new BadRequestException({ code: ErrorCodes.INVALID_FILE_TYPE, message: 'Invalid file key format' });
    return (await this.localStorage.getFileSize(fileKey)) ?? 0;
  }

  /**
   * URL unduh untuk fileKey.
   *
   * Batch 1A (03-#1, ST-002): file PUBLIK → URL publik langsung (disserve nginx).
   * File PRIVAT → signed URL HMAC ke `GET /v1/upload/s` dengan expiry sesuai
   * `expiresIn`. Sebelumnya selalu mengembalikan URL publik permanen dan
   * mengabaikan `expiresIn`.
   */
  async generateDownloadUrl(fileKey: string, expiresIn = 300): Promise<string> {
    if (!isSafeFileKey(fileKey) || !this.isKnownStorageKey(fileKey)) throw new BadRequestException({ code: ErrorCodes.INVALID_FILE_TYPE, message: 'Invalid file key format' });
    if (isPrivateFileKey(fileKey)) {
      return this.buildSignedDownloadUrl(fileKey, expiresIn);
    }
    return this.localStorage.getPublicUrl(fileKey);
  }

  /**
   * Stores a generated account export in local storage. This method is
   * intentionally not exposed by UploadController: users can request an
   * export through SettingsService, but cannot choose an arbitrary private key.
   *
   * Batch 1A (ST-019): konten dienkripsi AES-GCM at-rest. URL unduh adalah
   * signed URL kedaluwarsa (bukan URL publik permanen), dan file dihapus
   * otomatis oleh scheduler setelah 24 jam.
   */
  async uploadPrivateAccountExport(
    userId: string,
    content: Buffer,
    options?: { fileExtension?: 'json' | 'zip' },
  ): Promise<{ downloadUrl: string; expiresAt: Date; fileKey: string }> {
    const ext = options?.fileExtension === 'zip' ? 'zip' : 'json';
    const fileKey = `uploads/account-exports/${userId}/${nanoid()}.${ext}`;
    if (!isSafeFileKey(fileKey)) {
      throw new Error('Generated account export key failed storage safety validation');
    }
    const encrypted = await encryptAES(content.toString('base64'));
    await this.localStorage.saveFile(fileKey, Buffer.from(encrypted, 'utf-8'));

    const expiresIn = 900;
    return {
      downloadUrl: this.buildSignedDownloadUrl(fileKey, expiresIn),
      expiresAt: new Date(Date.now() + expiresIn * 1000),
      // G100: kunci artefak disimpan (bukan URL signed mentah); URL dibuat
      // on-demand saat riwayat ekspor diunduh ulang.
      fileKey,
    };
  }

  /**
   * UPV-03 (audit upload video 2026-10-03): varian `uploadDirect` untuk file
   * yang SUDAH ada di disk (hasil rakitan chunked upload). Menghilangkan
   * puncak RAM ~2× ukuran file di request handler:
   * - validasi ukuran via `stat`, magic-byte via baca header saja
   *   (32 byte, bukan `readFile` penuh);
   * - file dipindah dengan `rename` (atomic, satu filesystem) ke lokasi
   *   final — tanpa buffer kedua di memori.
   * Gambar tetap lewat buffer (butuh strip EXIF) — ukurannya kecil
   * (≤10 MiB) sehingga bukan masalah.
   *
   * Pemanggil bertanggung jawab atas file sumber: sukses → file sudah
   * pindah (atau dihapus bila gambar); gagal validasi → file sumber
   * DIBIARKAN (pemanggil yang membersihkan, mis. destroySession).
   */
  async uploadDirectFromPath(
    userId: string,
    purpose: UploadPurpose,
    fileName: string,
    contentType: string,
    sourcePath: string,
  ): Promise<DirectUploadResult> {
    const allowedTypes = ALLOWED_CONTENT_TYPES[purpose];
    if (!allowedTypes.includes(contentType)) {
      throw new BadRequestException({
        code: ErrorCodes.MIME_TYPE_MISMATCH,
        message: `Content type ${contentType} is not allowed for ${purpose}. Allowed: ${allowedTypes.join(', ')}`,
      });
    }

    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(sourcePath);
    } catch {
      throw new BadRequestException({
        code: ErrorCodes.UPLOAD_FAILED,
        message: 'Source file not found for upload',
      });
    }
    if (!stat.isFile()) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_FILE_TYPE,
        message: 'Source path is not a file',
      });
    }
    if (stat.size < MIN_FILE_SIZE) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_FILE_TYPE,
        message: `File is too small (${stat.size} bytes). Minimum size is ${MIN_FILE_SIZE} bytes`,
      });
    }
    const maxSize = MAX_FILE_SIZE[purpose];
    if (stat.size > maxSize) {
      throw fileTooLargeException(purpose, maxSize);
    }

    // Magic-byte: cukup baca header, tanpa memuat seluruh file.
    const header = await this.localStorage.readFileRangeByPath(sourcePath, 0, MIME_HEADER_BYTES - 1);
    const detectedMime = detectMimeFromBytes(header);
    if (!detectedMime) {
      throw new BadRequestException({
        code: ErrorCodes.MIME_TYPE_MISMATCH,
        message: 'Unable to identify file type from content. The file may be corrupted or unsupported.',
      });
    }
    if (detectedMime !== contentType) {
      throw new BadRequestException({
        code: ErrorCodes.MIME_TYPE_MISMATCH,
        message: `File content (${detectedMime}) does not match declared type (${contentType})`,
      });
    }

    const fileKey = this.buildStoredFileKey(userId, purpose, fileName, detectedMime);

    let imageBuffer: Buffer | undefined;
    if (detectedMime.startsWith('image/')) {
      // Gambar kecil: baca buffer untuk strip EXIF (jalur sama seperti
      // uploadDirectTx), lalu hapus file sumber.
      const fileBuffer = await fs.promises.readFile(sourcePath);
      const storedBuffer = stripImageMetadata(fileBuffer, detectedMime);
      try {
        await this.localStorage.saveFile(fileKey, storedBuffer);
      } catch (error) {
        this.logUploadStorageFailure('direct-from-path', fileKey, error);
        throw this.storageFailureException(error);
      }
      await fs.promises.unlink(sourcePath).catch(() => undefined);
      imageBuffer = fileBuffer;
    } else {
      // Pindahkan tanpa menyalin isi file (rename atomic — staging dan
      // storage di filesystem yang sama).
      const destPath = this.localStorage.resolvePath(fileKey);
      await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
      try {
        await fs.promises.rename(sourcePath, destPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
          await fs.promises.copyFile(sourcePath, destPath);
          await fs.promises.unlink(sourcePath).catch(() => undefined);
        } else {
          this.logUploadStorageFailure('move', fileKey, err);
          throw this.storageFailureException(err);
        }
      }
    }

    return withSpan(
      'upload.direct_from_path',
      async (span) => {
        const result = await this.finalizeDirectUpload(userId, purpose, fileKey, detectedMime, imageBuffer);
        span.setAttribute(
          'fileKeyHash',
          createHash('sha256').update(result.fileKey).digest('hex'),
        );
        return result;
      },
      {
        size: stat.size,
        mime: contentType,
        purpose,
      },
    );
  }

  /**
   * G481: span upload.direct — HANYA { fileKeyHash, size, mime, purpose }.
   * Tanpa isi file, tanpa nama file asli, tanpa userId mentah di atribut
   * (fileKey di-hash SHA-256 sebelum masuk span).
   */
  async uploadDirect(
    userId: string,
    purpose: UploadPurpose,
    fileName: string,
    contentType: string,
    fileBuffer: Buffer,
  ): Promise<DirectUploadResult> {
    return withSpan(
      'upload.direct',
      async (span) => {
        const result = await this.uploadDirectTx(userId, purpose, fileName, contentType, fileBuffer);
        span.setAttribute(
          'fileKeyHash',
          createHash('sha256').update(result.fileKey).digest('hex'),
        );
        return result;
      },
      {
        size: fileBuffer.length,
        mime: contentType,
        purpose,
      },
    );
  }

  private async uploadDirectTx(
    userId: string,
    purpose: UploadPurpose,
    fileName: string,
    contentType: string,
    fileBuffer: Buffer,
  ): Promise<DirectUploadResult> {
    const allowedTypes = ALLOWED_CONTENT_TYPES[purpose];
    if (!allowedTypes.includes(contentType)) {
      if (purpose === UploadPurpose.STORY_MEDIA) {
        throw new UnsupportedMediaTypeException({
          code: 'STORY_MEDIA_TYPE',
          message: 'Format foto story harus JPEG, PNG, atau WEBP.',
        });
      }
      throw new BadRequestException({
        code: ErrorCodes.MIME_TYPE_MISMATCH,
        message: `Content type ${contentType} is not allowed for ${purpose}. Allowed: ${allowedTypes.join(', ')}`,
      });
    }

    if (fileBuffer.length < (purpose === UploadPurpose.STORY_MEDIA ? 1 : MIN_FILE_SIZE)) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_FILE_TYPE,
        message: `File is too small (${fileBuffer.length} bytes). Minimum size is ${MIN_FILE_SIZE} bytes`,
      });
    }

    const maxSize = MAX_FILE_SIZE[purpose];
    if (fileBuffer.length > maxSize) {
      throw fileTooLargeException(purpose, maxSize);
    }

    const header = fileBuffer.subarray(0, MIME_HEADER_BYTES);
    const detectedMime = detectMimeFromBytes(header);
    if (!detectedMime) {
      if (purpose === UploadPurpose.STORY_MEDIA) {
        throw new UnsupportedMediaTypeException({
          code: 'STORY_MEDIA_TYPE',
          message: 'Foto story tidak valid.',
        });
      }
      throw new BadRequestException({
        code: ErrorCodes.MIME_TYPE_MISMATCH,
        message: 'Unable to identify file type from content. The file may be corrupted or unsupported.',
      });
    }
    if (detectedMime !== contentType) {
      if (purpose === UploadPurpose.STORY_MEDIA) {
        throw new UnsupportedMediaTypeException({
          code: 'STORY_MEDIA_TYPE',
          message: 'Isi file tidak sesuai dengan format foto yang dikirim.',
        });
      }
      throw new BadRequestException({
        code: ErrorCodes.MIME_TYPE_MISMATCH,
        message: `File content (${detectedMime}) does not match declared type (${contentType})`,
      });
    }

    // Story photos are re-encoded to metadata-free JPEG and resized server-side
    // to a 1600px longest edge. Other upload purposes keep their existing
    // lossless EXIF-stripping pipeline.
    let storedMime = detectedMime;
    let storedBuffer: Buffer;
    if (purpose === UploadPurpose.STORY_MEDIA) {
      try {
        storedMime = 'image/jpeg';
        storedBuffer = await sharp(fileBuffer)
          .rotate()
          .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 86, mozjpeg: true })
          .toBuffer();
      } catch {
        throw new UnsupportedMediaTypeException({
          code: 'STORY_MEDIA_TYPE',
          message: 'Foto story tidak dapat diproses. Gunakan JPEG, PNG, atau WEBP yang valid.',
        });
      }
    } else {
      // LOW (SEC-D): strip metadata EXIF/XMP (termasuk GPS) tanpa re-encode.
      storedBuffer = stripImageMetadata(fileBuffer, detectedMime);
    }
    const fileKey = this.buildStoredFileKey(userId, purpose, fileName, storedMime);

    try {
      await this.localStorage.saveFile(fileKey, storedBuffer);
    } catch (error) {
      this.logUploadStorageFailure('direct', fileKey, error);
      throw this.storageFailureException(error);
    }

    return this.finalizeDirectUpload(
      userId,
      purpose,
      fileKey,
      storedMime,
      purpose === UploadPurpose.SHOWCASE_IMAGE ? fileBuffer : undefined,
    );
  }

  /**
   * Bug #2 (2026-10-07): log kegagalan penyimpanan dengan errno + sinyal
   * kapasitas supaya insiden disk penuh / FS read-only di
   * /var/www/kahade-storage bisa didiagnosis & di-alert dari log produksi.
   */
  private logUploadStorageFailure(stage: string, fileKey: string, error: unknown): void {
    const info = describeStorageError(error);
    this.logger.error(
      `[storage] ${stage} gagal fileKey=${fileKey} errno=${info.errno ?? 'n/a'} ` +
        `capacity=${info.capacity} unavailable=${info.unavailable} — ${(error as Error).message}`,
      error instanceof Error ? error.stack : undefined,
    );
  }

  /**
   * Kegagalan penyimpanan sisi server (disk penuh/kuota/FS read-only) → 503
   * `UPLOAD_STORAGE_UNAVAILABLE` (retryable, memicu alert 5xx). Kegagalan lain
   * (mis. bug kode) tetap 400 `UPLOAD_FAILED` seperti sebelumnya.
   */
  private storageFailureException(error: unknown): BadRequestException | ServiceUnavailableException {
    const info = describeStorageError(error);
    if (info.unavailable) {
      return new ServiceUnavailableException({
        code: ErrorCodes.UPLOAD_STORAGE_UNAVAILABLE,
        message: STORAGE_UNAVAILABLE_MESSAGE,
      });
    }
    return new BadRequestException({
      code: ErrorCodes.UPLOAD_FAILED,
      message: 'Failed to upload file to storage. Please try again.',
    });
  }

  /**
   * UPV-03: bangun fileKey penyimpanan yang aman — diekstrak dari
   * `uploadDirectTx` agar dipakai ulang oleh `uploadDirectFromPath`.
   * SH-S-001: ekstensi SELALU dari MIME terdeteksi, bukan filename user.
   */
  private buildStoredFileKey(
    userId: string,
    purpose: UploadPurpose,
    fileName: string,
    detectedMime: string,
  ): string {
    const sanitizedFileName = sanitizeStoredFileName(fileName);
    // SH-S-001: buang ekstensi asli dari filename user SEPENUHNYA, ganti dengan
    // ekstensi dari MIME terdeteksi. `promo.html` ber-magic JPEG tersimpan
    // sebagai `.jpg` — nginx tidak akan pernah menyajikannya sebagai text/html.
    const detectedExtension = DETECTED_MIME_TO_EXTENSION[detectedMime];
    if (!detectedExtension) {
      throw new BadRequestException({
        code: ErrorCodes.MIME_TYPE_MISMATCH,
        message: `Detected file type ${detectedMime} has no safe stored extension`,
      });
    }
    const baseName = sanitizedFileName.includes('.')
      ? sanitizedFileName.slice(0, sanitizedFileName.lastIndexOf('.'))
      : sanitizedFileName;
    const storedFileName = `${baseName || 'file'}${detectedExtension}`;
    const timestamp = Date.now();
    const randomSuffix = nanoid();
    const folder = UploadService.PURPOSE_FOLDER_MAP[purpose];
    return `uploads/${folder}/${userId}/${timestamp}-${randomSuffix}-${storedFileName}`;
  }

  /**
   * UPV-03: langkah akhir uploadDirect yang SAMA untuk kedua varian
   * (buffer & from-path): tandai terkonfirmasi, pasca-pemrosesan
   * video/gambar, bangun fileUrl. `imageBuffer` = buffer asli untuk
   * `processShowcaseImage` (hanya relevan bila purpose SHOWCASE_IMAGE).
   */
  private async finalizeDirectUpload(
    userId: string,
    purpose: UploadPurpose,
    fileKey: string,
    detectedMime: string,
    imageBuffer?: Buffer,
  ): Promise<DirectUploadResult> {
    const redisKey = `confirmed_upload:${userId}:${fileKey}`;
    // 2026-10-07: fail-open bila Redis down — confirmed flag hanya optimasi
    // untuk janitor orphan-cleanup, bukan syarat kebenaran upload. Tanpa ini,
    // Redis down = file sudah tersimpan tapi user dapat 500 + file yatim.
    try {
      await this.redis.setNx(redisKey, '1', CONFIRMED_KEY_TTL_SECONDS);
    } catch (err) {
      this.logger.warn(`Redis setNx failed for ${redisKey} — continuing upload (fail-open): ${err instanceof Error ? err.message : String(err)}`);
    }

    // Batch 19 TIM A (item 1): SHOWCASE_VIDEO — validasi durasi + thumbnail.
    // Fail closed: video yang tidak lolos dihapus dari storage dan upload
    // ditolak; tidak ada file setengah-jadi yang bertahan.
    let videoMeta: Pick<DirectUploadResult, 'thumbnailFileKey' | 'thumbnailUrl' | 'durationSec' | 'width' | 'height'> | undefined;
    if (purpose === UploadPurpose.SHOWCASE_VIDEO) {
      videoMeta = await this.processShowcaseVideo(userId, fileKey);
    }

    // UPV-07: lampiran video privat (chat/sengketa/bukti) — thumbnail
    // best-effort FAIL-OPEN: gagal → upload tetap sukses, thumbnailUrl kosong
    // (FE fallback ke ikon seperti sebelumnya). Disimpan di folder privat
    // milik user yang sama sehingga lolos validateOwnership + signed URL.
    let chatVideoThumbMeta: Pick<DirectUploadResult, 'thumbnailFileKey' | 'thumbnailUrl'> | undefined;
    if (
      detectedMime.startsWith('video/') &&
      (purpose === UploadPurpose.CHAT_ATTACHMENT ||
        purpose === UploadPurpose.DISPUTE_EVIDENCE ||
        purpose === UploadPurpose.DELIVERY_PROOF ||
        purpose === UploadPurpose.MILESTONE_EVIDENCE)
    ) {
      this.logger.log(`[finalize] thumbnail video privat (best-effort) fileKey=${fileKey}`);
      chatVideoThumbMeta = await this.processChatVideoThumbnail(userId, fileKey).catch((err) => {
        this.logger.warn(`UPV-07: thumbnail video chat gagal untuk ${fileKey}: ${(err as Error).message}`);
        return undefined;
      });
    }

    // PERF-FIX (NP-001): SHOWCASE_IMAGE — thumbnail JPEG ~640px via sharp.
    // Sengaja FAIL-OPEN (beda dengan video): thumbnail foto adalah optimasi
    // kuota, bukan persyaratan kontrak — upload foto tidak boleh gagal hanya
    // karena pembuatan thumbnail bermasalah. Kegagalan dicatat di log dan
    // field thumbnail tetap undefined (frontend fallback ke imageUrl penuh).
    let imageThumbMeta: Pick<DirectUploadResult, 'thumbnailFileKey' | 'thumbnailUrl'> | undefined;
    if (purpose === UploadPurpose.SHOWCASE_IMAGE && imageBuffer) {
      imageThumbMeta = await this.processShowcaseImage(userId, fileKey, imageBuffer);
    }

    // Batch 1A (ST-004): purpose PRIVAT (KYC/dokumen/bukti) mendapat signed URL
    // kedaluwarsa, bukan URL publik permanen. Purpose publik (avatar/showcase)
    // tetap mendapat URL publik via nginx.
    const fileUrl = isPrivateFileKey(fileKey)
      ? this.buildSignedDownloadUrl(fileKey, 900)
      : this.localStorage.getPublicUrl(fileKey);

    return { fileKey, fileUrl, ...videoMeta, ...chatVideoThumbMeta, ...imageThumbMeta };
  }

  /**
   * Batch 19 TIM A (item 1): pasca-pemrosesan video showcase.
   *
   * 1. Cek ffmpeg/ffprobe tersedia (prasyarat deploy di server).
   * 2. Probe durasi + dimensi via ffprobe — gagal parse = bukan video valid.
   * 3. Tolak bila durasi di luar [MIN, MAX] (UPV-04: juga tolak bila dimensi
   *    maksimum > SHOWCASE_VIDEO_MAX_DIMENSION_PX).
   * 4. Generate thumbnail JPEG (lebar 640px) via ffmpeg, disimpan di folder
   *    SHOWCASE_IMAGE milik user yang sama dan DITANDAI terkonfirmasi
   *    (confirmed_upload) supaya langsung bisa dipakai sebagai media showcase.
   *
   * Setiap kegagalan menghapus file video yang sudah tersimpan (fail closed —
   * tidak ada artefak yatim) lalu melempar error yang sesuai.
   */
  private async processShowcaseVideo(
    userId: string,
    fileKey: string,
  ): Promise<Pick<DirectUploadResult, 'thumbnailFileKey' | 'thumbnailUrl' | 'durationSec' | 'width' | 'height'>> {
    const startedAt = Date.now();
    const discardVideo = async (): Promise<void> => {
      await this.localStorage.deleteFile(fileKey).catch(() => undefined);
    };

    /**
     * Bug #2 (video showcase "Memproses video..." menggantung): logging
     * berjenjang per tahap supaya status pipeline bisa dibaca dari log
     * produksi tanpa mereproduksi upload — termasuk durasi tiap tahap
     * (probe vs thumbnail) agar bottleneck terlihat.
     */
    const stage = (name: string, detail: string): void => {
      this.logger.log(
        `[showcase-video] ${name} fileKey=${fileKey} user=${userId} elapsed=${Date.now() - startedAt}ms ${detail}`,
      );
    };
    let videoBytes: number | null = null;
    try {
      videoBytes = (await fs.promises.stat(this.localStorage.resolvePath(fileKey))).size;
    } catch {
      videoBytes = null;
    }
    stage('mulai', `size=${videoBytes ?? '?'}B`);

    if (!this.videoProcessing.isAvailable()) {
      await discardVideo();
      stage('gagal', 'ffmpeg/ffprobe tidak tersedia — file dihapus (fail-closed)');
      // 500: kesalahan konfigurasi server (ffmpeg belum diinstal) — bukan
      // kesalahan input user. Prasyarat deploy tercatat di laporan batch.
      throw new InternalServerErrorException({
        code: ErrorCodes.UPLOAD_FAILED,
        message: 'Video processing is temporarily unavailable on the server',
      });
    }

    let probe: { durationSec: number; width: number; height: number };
    try {
      probe = await this.videoProcessing.probeVideo(this.localStorage.resolvePath(fileKey));
    } catch (err) {
      await discardVideo();
      stage('gagal', `probe ffprobe gagal (${(err as Error).message}) — file dihapus`);
      throw new BadRequestException({
        code: ErrorCodes.VIDEO_UNPROCESSABLE,
        message: 'File is not a valid video or its duration cannot be determined',
      });
    }
    stage(
      'probe-ok',
      `duration=${probe.durationSec.toFixed(3)}s dim=${probe.width}x${probe.height}`,
    );

    if (probe.durationSec > SHOWCASE_VIDEO_MAX_DURATION_SEC) {
      await discardVideo();
      stage('gagal', `durasi ${probe.durationSec.toFixed(1)}s > ${SHOWCASE_VIDEO_MAX_DURATION_SEC}s — file dihapus`);
      throw new BadRequestException({
        code: ErrorCodes.VIDEO_TOO_LONG,
        message: `Durasi video melebihi batas maksimal ${SHOWCASE_VIDEO_MAX_DURATION_SEC} detik. Maksimal 100 MB / 180 detik.`,
      });
    }
    if (probe.durationSec < SHOWCASE_VIDEO_MIN_DURATION_SEC) {
      await discardVideo();
      stage('gagal', `durasi ${probe.durationSec.toFixed(1)}s < ${SHOWCASE_VIDEO_MIN_DURATION_SEC}s — file dihapus`);
      throw new BadRequestException({
        code: ErrorCodes.VIDEO_UNPROCESSABLE,
        message: 'Video duration is too short or the file is corrupted',
      });
    }
    // UPV-04: tolak resolusi absurd (mis. 8K) — fail-closed seperti durasi.
    if (
      Math.max(probe.width, probe.height) > SHOWCASE_VIDEO_MAX_DIMENSION_PX
    ) {
      await discardVideo();
      stage(
        'gagal',
        `dimensi ${probe.width}x${probe.height} > ${SHOWCASE_VIDEO_MAX_DIMENSION_PX}px — file dihapus`,
      );
      throw new BadRequestException({
        code: ErrorCodes.VIDEO_RESOLUTION_TOO_HIGH,
        message: `Resolusi video melebihi batas maksimal ${SHOWCASE_VIDEO_MAX_DIMENSION_PX}p.`,
      });
    }

    // Thumbnail: key mengikuti pola fileKey aman (lolos isSafeFileKey), folder
    // SHOWCASE_IMAGE milik user yang sama supaya bisa dilampirkan sebagai
    // media showcase tanpa langkah konfirmasi tambahan.
    const thumbKey = `uploads/showcase-images/${userId}/${Date.now()}-thumb-${nanoid()}.jpg`;
    try {
      const destPath = this.localStorage.resolvePath(thumbKey);
      await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
      stage('thumbnail-mulai', `dest=${path.basename(thumbKey)}`);
      await this.videoProcessing.generateThumbnail(
        this.localStorage.resolvePath(fileKey),
        destPath,
        Math.min(1, probe.durationSec / 2),
        SHOWCASE_VIDEO_THUMBNAIL_WIDTH,
      );
    } catch (err) {
      await discardVideo();
      await this.localStorage.deleteFile(thumbKey).catch(() => undefined);
      stage('gagal', `thumbnail ffmpeg gagal (${(err as Error).message}) — video & thumbnail dihapus`);
      throw new InternalServerErrorException({
        code: ErrorCodes.UPLOAD_FAILED,
        message: 'Failed to generate video thumbnail',
      });
    }

    // Tandai thumbnail sebagai confirmed (dibuat server-side, bukan oleh user).
    // Bug #2: fail-open seperti finalizeDirectUpload — Redis down tidak boleh
    // membatalkan upload yang videonya SUDAH diproses & tersimpan (dulu throw
    // di sini = 500 tanpa jejak yang jelas setelah semua kerja ffmpeg selesai).
    try {
      await this.redis.setNx(`confirmed_upload:${userId}:${thumbKey}`, '1', CONFIRMED_KEY_TTL_SECONDS);
    } catch (err) {
      this.logger.warn(
        `[showcase-video] setNx confirmed_upload gagal untuk ${thumbKey} — lanjut (fail-open): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    stage('selesai', `thumbnail=${path.basename(thumbKey)}`);

    return {
      thumbnailFileKey: thumbKey,
      thumbnailUrl: this.localStorage.getPublicUrl(thumbKey),
      durationSec: Math.round(probe.durationSec),
      width: probe.width,
      height: probe.height,
    };
  }

  /**
   * UPV-07 (audit upload video 2026-10-03): thumbnail best-effort untuk video
   * lampiran privat (chat/sengketa/bukti kirim/milestone).
   *
   * BEDA dengan `processShowcaseVideo`:
   * - FAIL-OPEN: gagal (ffmpeg tak tersedia / file aneh) → return undefined,
   *   upload video TETAP sukses. Pemanggil (finalizeDirectUpload) menelan
   *   error dan mencatat warning.
   * - TANPA validasi durasi/dimensi — chat tidak terikat aturan konten etalase.
   * - Disimpan di folder privat `chat-attachments/{userId}/` (bukan
   *   showcase-images) supaya `validateOwnership` di chat.service lolos dan
   *   URL-nya berupa signed URL kedaluwarsa seperti file induknya.
   */
  private async processChatVideoThumbnail(
    userId: string,
    fileKey: string,
  ): Promise<Pick<DirectUploadResult, 'thumbnailFileKey' | 'thumbnailUrl'> | undefined> {
    if (!this.videoProcessing.isAvailable()) return undefined;
    const startedAt = Date.now();
    const thumbKey = `uploads/chat-attachments/${userId}/${Date.now()}-thumb-${nanoid()}.jpg`;
    const destPath = this.localStorage.resolvePath(thumbKey);
    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
    try {
      // Frame detik ke-1 (atau tengah bila video < 2 dtk — probe best-effort).
      let atSecond = 1;
      try {
        const probe = await this.videoProcessing.probeVideo(this.localStorage.resolvePath(fileKey));
        atSecond = Math.min(1, probe.durationSec / 2);
      } catch {
        // Probe gagal → coba thumbnail di detik 0; generateThumbnail yang
        // menentukan fail-open final.
      }
      await this.videoProcessing.generateThumbnail(
        this.localStorage.resolvePath(fileKey),
        destPath,
        atSecond,
        SHOWCASE_VIDEO_THUMBNAIL_WIDTH,
      );
    } catch (err) {
      await this.localStorage.deleteFile(thumbKey).catch(() => undefined);
      this.logger.warn(
        `[chat-video-thumb] gagal (fail-open) fileKey=${fileKey} elapsed=${Date.now() - startedAt}ms error=${(err as Error).message}`,
      );
      return undefined;
    }
    try {
      await this.redis.setNx(`confirmed_upload:${userId}:${thumbKey}`, '1', CONFIRMED_KEY_TTL_SECONDS);
    } catch (err) {
      this.logger.warn(
        `[chat-video-thumb] setNx gagal untuk ${thumbKey} — lanjut (fail-open): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.logger.log(
      `[chat-video-thumb] selesai fileKey=${fileKey} thumb=${path.basename(thumbKey)} elapsed=${Date.now() - startedAt}ms`,
    );
    return {
      thumbnailFileKey: thumbKey,
      thumbnailUrl: this.buildSignedDownloadUrl(thumbKey, 900),
    };
  }

  /**
   * PERF-FIX (NP-001): pasca-pemrosesan foto showcase — thumbnail JPEG
   * ~640px via sharp.
   *
   * Alur (cerminan `processShowcaseVideo`, disesuaikan untuk foto):
   * 1. Resize buffer ASLI (`fileBuffer`, bukan hasil strip metadata) supaya
   *    `.rotate()` bisa menerapkan orientasi EXIF — file yang tersimpan
   *    sudah kehilangan tag orientasi (SEC-D strip EXIF lossless).
   * 2. Thumbnail disimpan di folder SHOWCASE_IMAGE milik user yang sama dan
   *    DITANDAI terkonfirmasi (confirmed_upload), supaya langsung bisa
   *    dilampirkan sebagai `thumbnailFileKey` media etalase.
   * 3. Thumbnail juga bebas metadata (sharp tidak menyalin EXIF ke output
   *    bila tidak diminta) — tidak ada kebocoran GPS lewat varian kecil.
   *
   * FAIL-OPEN (disengaja): bila sharp gagal, upload FOTO TETAP BERHASIL
   * tanpa thumbnail — kegagalan dicatat di log. Berbeda dengan video yang
   * fail-closed karena thumbnail-nya persyaratan kontrak. Tidak ada file
   * setengah-jadi yang bertahan: thumbnail yang gagal ditulis dihapus.
   */
  private async processShowcaseImage(
    userId: string,
    fileKey: string,
    fileBuffer: Buffer,
  ): Promise<Pick<DirectUploadResult, 'thumbnailFileKey' | 'thumbnailUrl'>> {
    const thumbKey = `uploads/showcase-images/${userId}/${Date.now()}-thumb-${nanoid()}.jpg`;
    try {
      const destPath = this.localStorage.resolvePath(thumbKey);
      await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
      await sharp(fileBuffer)
        .rotate() // terapkan orientasi EXIF ke piksel (lihat docblock)
        .resize({ width: SHOWCASE_IMAGE_THUMBNAIL_WIDTH, withoutEnlargement: true })
        .jpeg({ quality: 80, mozjpeg: true })
        .toFile(destPath);
    } catch (error) {
      this.logger.warn(
        `Gagal membuat thumbnail foto showcase untuk key=${fileKey}; upload dilanjutkan tanpa thumbnail`,
        error instanceof Error ? error.message : error,
      );
      await this.localStorage.deleteFile(thumbKey).catch(() => undefined);
      return {};
    }

    // Tandai thumbnail sebagai confirmed (dibuat server-side, bukan oleh user).
    await this.redis.setNx(`confirmed_upload:${userId}:${thumbKey}`, '1', CONFIRMED_KEY_TTL_SECONDS);

    return {
      thumbnailFileKey: thumbKey,
      thumbnailUrl: this.localStorage.getPublicUrl(thumbKey),
    };
  }

  async cleanupFileKeys(userId: string, fileKeys: string[]): Promise<{ deleted: number; errors: { fileKey: string; reason: string }[] }> {
    let deleted = 0;
    const errors: { fileKey: string; reason: string }[] = [];

    for (const fileKey of fileKeys) {
      // B-39: this was the weakest of the three key-consuming paths — it took
      // fileKeys straight from the request body (`CleanupFilesDto` only declares
      // `@IsString({ each: true })`) and asserted nothing but `segments[2] === userId`.
      // `uploads/x/<myId>/../../avatars/<victim>/a.jpg` satisfied that and reached
      // DeleteObjectCommand, so a caller could delete objects they do not own.
      if (!isSafeFileKey(fileKey)) {
        errors.push({ fileKey: String(fileKey).slice(0, 128), reason: 'invalid file key' });
        continue;
      }

      const segments = fileKey.split('/');
      if (segments.length !== 4 || segments[2] !== userId) {
        errors.push({ fileKey, reason: 'not owned by user' });
        continue;
      }

      try {
        const deletedFromStorage = await this.localStorage.deleteFile(fileKey);
        if (!deletedFromStorage) {
          this.logger.warn(`Storage declined deletion for file key=${fileKey}`);
          errors.push({ fileKey, reason: 'storage deletion failed' });
          continue;
        }

        const redisKey = `confirmed_upload:${userId}:${fileKey}`;
        await this.redis.del(redisKey);
        deleted++;
      } catch (error) {
        this.logger.warn(`Failed to delete file key=${fileKey}`, error instanceof Error ? error.message : error);
        errors.push({ fileKey, reason: 'storage deletion failed' });
      }
    }

    return { deleted, errors };
  }

  private isKnownStorageKey(fileKey: string): boolean {
    const parts = fileKey.split('/');
    return parts.length === 4 && (Boolean(PURPOSE_BY_FOLDER[parts[1]]) || parts[1] === 'account-exports' || parts[1] === 'admin-exports');
  }

  private static readonly PURPOSE_FOLDER_MAP: Record<UploadPurpose, string> = PURPOSE_FOLDER_MAP_INTERNAL;
}
