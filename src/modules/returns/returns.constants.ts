/**
 * GAP-D retur — konstanta kebijakan, label Bahasa Indonesia, dan pemetaan
 * notifikasi.
 */
import { NotificationType } from '@prisma/client';
import type {
  ReturnReasonCode,
  ReturnRejectReasonCode,
  ReturnResolutionType,
  ReturnStatus,
} from './returns.types';

/** Default bila tidak ada ReturnPolicy aktif untuk (orderType, kategori). */
export const DEFAULT_RETURN_WINDOW_DAYS = 7; // G203
export const DEFAULT_SELLER_RESPONSE_HOURS = 72; // G208
export const DEFAULT_SHIP_BACK_WINDOW_DAYS = 7;
export const DEFAULT_CLARIFICATION_WINDOW_DAYS = 3;
export const DEFAULT_REQUIRE_RETURN_SHIPMENT = true; // G215

/** Retensi bukti (G222): lampiran disimpan 2 tahun, lalu di-purge terjadwal. */
export const RETURN_EVIDENCE_RETENTION_DAYS = 730;

/** Purpose upload untuk bukti retur.
 *
 * MEMAKAI pipeline bukti sengketa existing ('dispute-evidence') karena
 * `UploadService.verifyEvidenceFileKeysBatch` hanya menerima
 * 'dispute-evidence' | 'report-evidence' dan tidak ada UploadPurpose khusus
 * retur. FileKey berada di `uploads/dispute-evidence/<userId>/...` — frontend
 * mengunggah via POST /v1/upload/direct dengan purpose=DISPUTE_EVIDENCE lalu
 * /upload/confirm seperti bukti sengketa.
 */
export const RETURN_EVIDENCE_UPLOAD_PURPOSE = 'dispute-evidence';

/** Batas lampiran per pengajuan. */
export const MAX_RETURN_ATTACHMENTS = 5;

export const RETURN_STATUS_LABEL: Record<ReturnStatus, string> = {
  REQUESTED: 'Diajukan',
  SELLER_REVIEW: 'Ditinjau penjual',
  CLARIFICATION_NEEDED: 'Butuh klarifikasi',
  APPROVED: 'Disetujui',
  REJECTED: 'Ditolak',
  RETURN_SHIPPING: 'Barang dikirim balik',
  RECEIVED: 'Barang diterima penjual',
  RESOLVED_REFUND: 'Selesai — dana dikembalikan',
  RESOLVED_EXCHANGE: 'Selesai — barang ditukar',
  RESOLVED_REPAIR: 'Selesai — barang diperbaiki',
  ESCALATED: 'Dieskalasi ke sengketa',
  CANCELLED: 'Dibatalkan',
  EXPIRED: 'Kedaluwarsa',
};

export const RETURN_REASON_LABEL: Record<ReturnReasonCode, string> = {
  BARANG_RUSAK: 'Barang rusak/cacat',
  BARANG_TIDAK_SESUAI_DESKRIPSI: 'Tidak sesuai deskripsi',
  BARANG_TIDAK_LENGKAP: 'Barang tidak lengkap',
  BARANG_PALSU: 'Barang palsu/tidak asli',
  SALAH_KIRIM_VARIAN: 'Salah kirim varian',
  BARANG_KEDALUWARSA: 'Barang kedaluwarsa',
  KEMASAN_RUSAK_PARAH: 'Kemasan rusak parah',
  LAINNYA: 'Lainnya',
};

export const RETURN_REJECT_REASON_LABEL: Record<ReturnRejectReasonCode, string> = {
  MELEWATI_BATAS_WAKTU: 'Melewati batas waktu pengajuan',
  BARANG_TIDAK_RUSAK: 'Barang terbukti tidak rusak',
  KLAIM_TIDAK_VALID: 'Klaim tidak valid',
  BUKTI_TIDAK_CUKUP: 'Bukti tidak cukup',
  BARANG_SUDAH_DIGUNAKAN: 'Barang sudah dipakai',
  KERUSAKAN_AKIBAT_PEMBELI: 'Kerusakan akibat pembeli',
  DILUAR_CAKUPAN_KEBIJAKAN: 'Di luar cakupan kebijakan retur',
  LAINNYA: 'Lainnya',
};

export const RETURN_RESOLUTION_LABEL: Record<ReturnResolutionType, string> = {
  REFUND: 'Kembalikan dana',
  EXCHANGE: 'Tukar barang',
  REPAIR: 'Perbaiki barang',
  MUTUAL_AGREED: 'Kesepakatan bersama',
};

/**
 * G221 — pemetaan tahap retur ke NotificationType existing.
 *
 * Enum NotificationType di schema.prisma BELUM memiliki nilai RETURN_* (skema
 * append-only; koordinator menambahkan pasca-merge). Sementara itu baris
 * notifikasi dipersist dengan tipe existing terdekat + payload
 * `data.type = 'RETURN_*'` (string bebas) untuk realtime/push/deep-link.
 * Setelah merge, ganti peta ini dengan nilai RETURN_* yang sebenarnya.
 */
export const RETURN_STAGE_NOTIFICATION_TYPE: Record<string, NotificationType> = {
  RETURN_REQUESTED: NotificationType.SYSTEM_ANNOUNCEMENT,
  RETURN_SELLER_RESPOND_NEEDED: NotificationType.SYSTEM_ANNOUNCEMENT,
  RETURN_CLARIFICATION_NEEDED: NotificationType.SYSTEM_ANNOUNCEMENT,
  RETURN_APPROVED: NotificationType.SYSTEM_ANNOUNCEMENT,
  RETURN_REJECTED: NotificationType.SYSTEM_ANNOUNCEMENT,
  RETURN_SHIPPED_BACK: NotificationType.SYSTEM_ANNOUNCEMENT,
  RETURN_RECEIVED: NotificationType.SYSTEM_ANNOUNCEMENT,
  RETURN_ESCALATED: NotificationType.DISPUTE_ESCALATED,
  RETURN_EXPIRED: NotificationType.SYSTEM_ANNOUNCEMENT,
  RETURN_CANCELLED: NotificationType.SYSTEM_ANNOUNCEMENT,
  RETURN_REFUND_APPROVED: NotificationType.SYSTEM_ANNOUNCEMENT,
  // Refund yang benar-benar dieksekusi = uang kembali ke dompet buyer.
  RETURN_REFUND_EXECUTED: NotificationType.WALLET_REFUND_RECEIVED,
  RETURN_RESOLVED: NotificationType.SYSTEM_ANNOUNCEMENT,
  RETURN_NOTE_ADDED: NotificationType.SYSTEM_ANNOUNCEMENT,
};
