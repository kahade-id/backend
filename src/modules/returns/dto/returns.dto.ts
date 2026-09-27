/**
 * GAP-D retur — DTO validasi (class-validator). Pesan user-facing Bahasa Indonesia.
 */
import {
  IsString, IsNotEmpty, IsOptional, IsIn, IsInt, Min, Max, MaxLength,
  IsArray, ArrayMaxSize, IsBoolean, Matches,
} from 'class-validator';
import { Type } from 'class-transformer';
import type {
  ReturnReasonCode,
  ReturnRejectReasonCode,
  ReturnResolutionType,
  ReturnStatus,
} from '../returns.types';

export const RETURN_REASON_CODES: ReturnReasonCode[] = [
  'BARANG_RUSAK',
  'BARANG_TIDAK_SESUAI_DESKRIPSI',
  'BARANG_TIDAK_LENGKAP',
  'BARANG_PALSU',
  'SALAH_KIRIM_VARIAN',
  'BARANG_KEDALUWARSA',
  'KEMASAN_RUSAK_PARAH',
  'LAINNYA',
];

export const RETURN_REJECT_REASON_CODES: ReturnRejectReasonCode[] = [
  'MELEWATI_BATAS_WAKTU',
  'BARANG_TIDAK_RUSAK',
  'KLAIM_TIDAK_VALID',
  'BUKTI_TIDAK_CUKUP',
  'BARANG_SUDAH_DIGUNAKAN',
  'KERUSAKAN_AKIBAT_PEMBELI',
  'DILUAR_CAKUPAN_KEBIJAKAN',
  'LAINNYA',
];

export const RETURN_RESOLUTION_TYPES: ReturnResolutionType[] = [
  'REFUND',
  'EXCHANGE',
  'REPAIR',
  'MUTUAL_AGREED',
];

export class ReturnAttachmentDto {
  @IsString()
  @IsNotEmpty({ message: 'Kunci file lampiran wajib diisi.' })
  @MaxLength(512)
  @Matches(/^[^\u0000-\u001f]+$/, { message: 'Kunci file tidak valid.' })
  fileKey!: string;

  @IsString()
  @IsNotEmpty({ message: 'Nama file wajib diisi.' })
  @MaxLength(255)
  @Matches(/^[^\\/\u0000-\u001f]+$/, { message: 'Nama file tidak valid.' })
  fileName!: string;

  @IsString()
  @IsNotEmpty({ message: 'Tipe file wajib diisi.' })
  @MaxLength(100)
  fileType!: string;

  @IsInt({ message: 'Ukuran file harus bilangan bulat.' })
  @Min(1)
  @Max(10 * 1024 * 1024, { message: 'Ukuran file maksimal 10 MB.' })
  fileSize!: number;
}

/** G203/G204/G205 — buyer mengajukan retur. */
export class CreateReturnDto {
  /** orderId PUBLIK (format ORD-...) — server memetakan ke Order.id. */
  @IsString()
  @IsNotEmpty({ message: 'ID pesanan wajib diisi.' })
  @MaxLength(64)
  orderId!: string;

  /** Referensi item untuk retur parsial; kosong = seluruh pesanan. */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  itemRef?: string;

  @IsIn(RETURN_REASON_CODES, { message: 'Kode alasan tidak dikenal.' })
  reasonCode!: ReturnReasonCode;

  @IsOptional()
  @IsString()
  @MaxLength(2000, { message: 'Deskripsi maksimal 2000 karakter.' })
  reasonDetail?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5, { message: 'Maksimal 5 lampiran.' })
  @Type(() => ReturnAttachmentDto)
  attachments?: ReturnAttachmentDto[];

  @IsOptional()
  @IsIn(RETURN_RESOLUTION_TYPES, { message: 'Preferensi penyelesaian tidak dikenal.' })
  resolutionPreference?: ReturnResolutionType;
}

/** G207 — respons seller: terima / tolak+alasan / minta klarifikasi. */
export class SellerRespondDto {
  @IsIn(['APPROVE', 'REJECT', 'CLARIFY'] as const, { message: 'Keputusan harus APPROVE, REJECT, atau CLARIFY.' })
  decision!: 'APPROVE' | 'REJECT' | 'CLARIFY';

  /** Wajib saat APPROVE — opsi penyelesaian G209. */
  @IsOptional()
  @IsIn(RETURN_RESOLUTION_TYPES, { message: 'Jenis penyelesaian tidak dikenal.' })
  resolutionType?: ReturnResolutionType;

  /** Nominal refund (sen). Wajib bila resolutionType=REFUND. */
  @IsOptional()
  @IsInt({ message: 'Nominal refund harus bilangan bulat (sen).' })
  @Min(1, { message: 'Nominal refund minimal Rp1.' })
  refundAmountSen?: number;

  /** Wajib saat REJECT — G223 reason code konsisten. */
  @IsOptional()
  @IsIn(RETURN_REJECT_REASON_CODES, { message: 'Kode alasan penolakan tidak dikenal.' })
  rejectReasonCode?: ReturnRejectReasonCode;

  @IsOptional()
  @IsString()
  @MaxLength(2000, { message: 'Catatan maksimal 2000 karakter.' })
  note?: string;

  /** Instruksi kirim balik — hanya dipakai saat APPROVE (G212). */
  @IsOptional()
  @IsString()
  @MaxLength(2000, { message: 'Instruksi maksimal 2000 karakter.' })
  returnInstructions?: string;
}

/** G216 — catatan negosiasi dua pihak. */
export class AddReturnNoteDto {
  @IsString()
  @IsNotEmpty({ message: 'Pesan tidak boleh kosong.' })
  @Matches(/\S/, { message: 'Pesan tidak boleh kosong.' })
  @MaxLength(2000, { message: 'Pesan maksimal 2000 karakter.' })
  message!: string;
}

/** G213 — buyer melapor nomor resi retur (terpisah dari resi awal). */
export class ShipReturnDto {
  @IsString()
  @IsNotEmpty({ message: 'Nomor resi wajib diisi.' })
  @MaxLength(64, { message: 'Nomor resi maksimal 64 karakter.' })
  trackingNumber!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  courier?: string;
}

/** G215 — seller mengonfirmasi barang retur diterima. */
export class ConfirmReceiptDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  /** Kondisi barang saat diterima: BAIK | RUSAK_SESUAI_KLAIM | BERBEDA_DARI_KLAIM */
  @IsOptional()
  @IsIn(['BAIK', 'RUSAK_SESUAI_KLAIM', 'BERBEDA_DARI_KLAIM'] as const)
  condition?: 'BAIK' | 'RUSAK_SESUAI_KLAIM' | 'BERBEDA_DARI_KLAIM';
}

/** G217 — eskalasi ke sengketa. */
export class EscalateReturnDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}

/** G219 — filter antrean admin. */
export class ReturnQueueQueryDto {
  @IsOptional()
  @IsString()
  status?: string;

  /** Filter umur kasus (jam). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minAgeHours?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxAgeHours?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  search?: string;
}

/** Aksi admin atas satu case retur. */
export class AdminReturnActionDto {
  @IsIn(['APPROVE', 'REJECT', 'ESCALATE', 'FORCE_RESOLVE_REFUND', 'FORCE_RESOLVE_EXCHANGE', 'FORCE_RESOLVE_REPAIR'] as const)
  action!: 'APPROVE' | 'REJECT' | 'ESCALATE' | 'FORCE_RESOLVE_REFUND' | 'FORCE_RESOLVE_EXCHANGE' | 'FORCE_RESOLVE_REPAIR';

  @IsOptional()
  @IsIn(RETURN_RESOLUTION_TYPES)
  resolutionType?: ReturnResolutionType;

  @IsOptional()
  @IsInt()
  @Min(1)
  refundAmountSen?: number;

  @IsOptional()
  @IsIn(RETURN_REJECT_REASON_CODES)
  rejectReasonCode?: ReturnRejectReasonCode;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;

  @IsOptional()
  @IsBoolean()
  skipShipmentRequired?: boolean;
}

/** Query daftar retur milik user. */
export class ListReturnsQueryDto {
  @IsOptional()
  @IsString()
  role?: 'buyer' | 'seller';

  @IsOptional()
  @IsString()
  status?: ReturnStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
