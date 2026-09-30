/**
 * GAP-D retur — tipe domain.
 *
 * JEMBATAN SKEMA (penting): model/enum Prisma retur didefinisikan di
 * `prisma/schema-gap-d-returns.prisma` dan BELUM tergabung ke client yang
 * ter-generate. Sampai koordinator me-regenerate `@prisma/client` pasca-merge,
 * modul ini memakai union string lokal yang nilainya IDENTIK dengan enum
 * Prisma (sumber kebenaran = file skema gap-D). Setelah merge, ganti import
 * tipe di sini dengan `import { ReturnStatus, ... } from '@prisma/client'`
 * dan hapus file ini — tidak ada perubahan logika yang dibutuhkan.
 */

export type ReturnStatus =
  | 'REQUESTED'
  | 'SELLER_REVIEW'
  | 'CLARIFICATION_NEEDED'
  | 'APPROVED'
  | 'REJECTED'
  | 'RETURN_SHIPPING'
  | 'RECEIVED'
  | 'RESOLVED_REFUND'
  | 'RESOLVED_EXCHANGE'
  | 'RESOLVED_REPAIR'
  | 'ESCALATED'
  | 'CANCELLED'
  | 'EXPIRED';

export type ReturnReasonCode =
  | 'BARANG_RUSAK'
  | 'BARANG_TIDAK_SESUAI_DESKRIPSI'
  | 'BARANG_TIDAK_LENGKAP'
  | 'BARANG_PALSU'
  | 'SALAH_KIRIM_VARIAN'
  | 'BARANG_KEDALUWARSA'
  | 'KEMASAN_RUSAK_PARAH'
  | 'LAINNYA';

export type ReturnRejectReasonCode =
  | 'MELEWATI_BATAS_WAKTU'
  | 'BARANG_TIDAK_RUSAK'
  | 'KLAIM_TIDAK_VALID'
  | 'BUKTI_TIDAK_CUKUP'
  | 'BARANG_SUDAH_DIGUNAKAN'
  | 'KERUSAKAN_AKIBAT_PEMBELI'
  | 'DILUAR_CAKUPAN_KEBIJAKAN'
  | 'LAINNYA';

export type ReturnResolutionType = 'REFUND' | 'EXCHANGE' | 'REPAIR' | 'MUTUAL_AGREED';

export type RefundApprovalStatus = 'PENDING' | 'EXECUTING' | 'EXECUTED' | 'FAILED';

export type ReturnActorType = 'BUYER' | 'SELLER' | 'ADMIN' | 'SYSTEM';

/** Status terminal — tidak ada transisi keluar (kecuali audit). */
export const TERMINAL_RETURN_STATUSES: ReadonlySet<ReturnStatus> = new Set([
  'RESOLVED_REFUND',
  'RESOLVED_EXCHANGE',
  'RESOLVED_REPAIR',
  'CANCELLED',
  'EXPIRED',
]);

/**
 * BAI-049: ringkasan hasil refund DANA untuk satu retur (dari
 * DanaRefundAttempt via idempotencyKey `RETURN:<returnDbId>`).
 * Diekspos ke admin saja — buyer/seller tidak butuh detail referensi provider.
 */
export type RefundDanaInfo = {
  status: string;
  danaReferenceNo: string | null;
  partnerRefundNo: string;
  amountSen: string;
  updatedAt: Date;
} | null;

/** Bentuk baris return_requests yang dipakai modul ini. */
export interface ReturnRequestRow {  id: string;
  returnId: string;
  orderId: string;
  itemRef: string | null;
  buyerId: string;
  sellerId: string;
  status: ReturnStatus;
  reasonCode: ReturnReasonCode;
  reasonDetail: string | null;
  resolutionType: ReturnResolutionType | null;
  refundAmount: bigint | null;
  sellerRespondBy: Date | null;
  rejectReasonCode: ReturnRejectReasonCode | null;
  rejectNote: string | null;
  clarificationQuestion: string | null;
  returnInstructions: string | null;
  shipBy: Date | null;
  returnTrackingNumber: string | null;
  returnCourier: string | null;
  receivedAt: Date | null;
  receivedNote: string | null;
  disputeId: string | null;
  approvedAt: Date | null;
  rejectedAt: Date | null;
  resolvedAt: Date | null;
  cancelledAt: Date | null;
  expiredAt: Date | null;
  escalatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReturnPolicyRow {
  id: string;
  orderType: string;
  category: string | null;
  returnWindowDays: number;
  sellerResponseHours: number;
  shipBackWindowDays: number;
  clarificationWindowDays: number;
  requireReturnShipment: boolean;
  maxRefundBps: number | null;
  isActive: boolean;
}

export interface ReturnRefundApprovalRow {
  id: string;
  returnRequestId: string;
  idempotencyKey: string;
  amount: bigint;
  status: RefundApprovalStatus;
  approvedBy: string;
  approvedByRole: ReturnActorType;
  approvedAt: Date;
  executedAt: Date | null;
  failureReason: string | null;
  walletTxIds: string[];
}

/**
 * Delegasi Prisma generik untuk model retur. Dipakai agar modul terkompilasi
 * sebelum client Prisma di-regenerate. Implementasi runtime = client asli.
 */
export interface ReturnsModelDelegate<T> {
  findUnique(args: unknown): Promise<T | null>;
  findFirst(args: unknown): Promise<T | null>;
  findMany(args: unknown): Promise<T[]>;
  count(args: unknown): Promise<number>;
  create(args: unknown): Promise<T>;
  update(args: unknown): Promise<T>;
  updateMany(args: unknown): Promise<{ count: number }>;
}

export interface ReturnsDb {
  returnPolicy: ReturnsModelDelegate<ReturnPolicyRow>;
  returnRequest: ReturnsModelDelegate<ReturnRequestRow>;
  returnAttachment: ReturnsModelDelegate<Record<string, unknown>>;
  returnNote: ReturnsModelDelegate<Record<string, unknown>>;
  returnTimeline: ReturnsModelDelegate<Record<string, unknown>>;
  returnShipmentEvent: ReturnsModelDelegate<Record<string, unknown>>;
  returnRefundApproval: ReturnsModelDelegate<ReturnRefundApprovalRow>;
}
