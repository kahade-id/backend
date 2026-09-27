import type { ReportStatus } from '@prisma/client';
import type {
  ModerationEventActionValue,
  ModerationReasonCodeValue,
} from './moderation-prisma.types';

/**
 * GAP-F (G401–G425): konstanta lifecycle moderasi pasca-final laporan etalase.
 */

// ---------------------------------------------------------------------------
// G424 — state machine eksplisit. SEMUA perubahan status laporan HARUS lewat
// `AdminShowcaseReportsService.transition()` yang memvalidasi map ini.
// ---------------------------------------------------------------------------
export const REPORT_STATUS_TRANSITIONS: Record<ReportStatus, ReportStatus[]> = {
  PENDING: ['UNDER_REVIEW', 'DISMISSED', 'RESOLVED_NO_ACTION', 'RESOLVED_ACTION_TAKEN'],
  UNDER_REVIEW: ['PENDING', 'DISMISSED', 'RESOLVED_NO_ACTION', 'RESOLVED_ACTION_TAKEN'],
  // Status final: satu-satunya jalan keluar adalah REOPEN → UNDER_REVIEW
  // (SUPER_ADMIN saja, G401).
  RESOLVED_ACTION_TAKEN: ['UNDER_REVIEW'],
  RESOLVED_NO_ACTION: ['UNDER_REVIEW'],
  DISMISSED: ['UNDER_REVIEW'],
} as Record<ReportStatus, ReportStatus[]>;

/** Status final — aksi review awal ditolak (idempotency guard, dipertahankan). */
export const MOD_FINAL_STATUSES: ReportStatus[] = [
  'RESOLVED_ACTION_TAKEN',
  'RESOLVED_NO_ACTION',
  'DISMISSED',
] as ReportStatus[];

/** Status non-final. */
export const MOD_OPEN_STATUSES: ReportStatus[] = ['PENDING', 'UNDER_REVIEW'] as ReportStatus[];

// ---------------------------------------------------------------------------
// G401/G422 — validasi alasan reopen.
// ---------------------------------------------------------------------------
export const REOPEN_REASON_MIN_LENGTH = 10;
export const REOPEN_REASON_MAX_LENGTH = 2000;

// ---------------------------------------------------------------------------
// G402 — catatan moderasi.
// ---------------------------------------------------------------------------
export const MODERATION_NOTE_MAX_LENGTH = 2000;

// ---------------------------------------------------------------------------
// G404 — banding.
// ---------------------------------------------------------------------------
export const APPEAL_REASON_MIN_LENGTH = 20;
export const APPEAL_REASON_MAX_LENGTH = 2000;
export const APPEAL_DECISION_NOTE_MIN_LENGTH = 10;

// ---------------------------------------------------------------------------
// G407 — jendela konflik kepentingan reviewer (hari).
// ---------------------------------------------------------------------------
export const REVIEWER_CONFLICT_WINDOW_DAYS = 90;

// ---------------------------------------------------------------------------
// G411 — bobot risiko per reason code (lihat fixes/docs/moderation-reason-codes.md).
// ---------------------------------------------------------------------------
export const REASON_CODE_RISK_WEIGHT: Record<ModerationReasonCodeValue, number> = {
  FRAUD_SUSPECTED: 30,
  PROHIBITED_ITEM: 30,
  NUDITY: 25,
  HARASSMENT: 20,
  IP_VIOLATION: 20,
  MISLEADING: 15,
  SPAM: 10,
  OTHER: 5,
};

/** Pemetaan reason string legacy (ShowcaseReport.reason) → reason code. */
const LEGACY_REASON_MAP: Record<string, ModerationReasonCodeValue> = {
  SPAM: 'SPAM',
  INAPPROPRIATE: 'NUDITY',
  COPYRIGHT: 'IP_VIOLATION',
  FRAUD: 'FRAUD_SUSPECTED',
  HARASSMENT: 'HARASSMENT',
};

export function toReasonCode(reason: string | null | undefined): ModerationReasonCodeValue {
  if (!reason) return 'OTHER';
  const key = reason.trim().toUpperCase();
  if ((Object.keys(REASON_CODE_RISK_WEIGHT) as string[]).includes(key)) {
    return key as ModerationReasonCodeValue;
  }
  return LEGACY_REASON_MAP[key] ?? 'OTHER';
}

/**
 * Skor risiko 0–100 = f(jumlah report item, kategori berat, reporter unik).
 *   min(40, 10 × totalReport) + min(30, 15 × reporterUnik) + bobot(reasonCode)
 */
export function computeRiskScore(
  totalReportsOnItem: number,
  uniqueReporters: number,
  reasonCode: ModerationReasonCodeValue,
): number {
  const volume = Math.min(40, 10 * Math.max(0, totalReportsOnItem));
  const spread = Math.min(30, 15 * Math.max(0, uniqueReporters));
  const severity = REASON_CODE_RISK_WEIGHT[reasonCode] ?? REASON_CODE_RISK_WEIGHT.OTHER;
  return Math.min(100, volume + spread + severity);
}

export function riskTier(score: number): 'HIGH' | 'MEDIUM' | 'LOW' {
  if (score >= 70) return 'HIGH';
  if (score >= 40) return 'MEDIUM';
  return 'LOW';
}

// ---------------------------------------------------------------------------
// G419 — SLA review.
// ---------------------------------------------------------------------------
export const SLA_HIGH_RISK_HOURS = 24;
export const SLA_NORMAL_HOURS = 72;

export function slaHoursForScore(score: number): number {
  return score >= 70 ? SLA_HIGH_RISK_HOURS : SLA_NORMAL_HOURS;
}

// ---------------------------------------------------------------------------
// G415 — jendela deteksi cluster duplikat.
// ---------------------------------------------------------------------------
export const CLUSTER_WINDOW_HOURS = 24;

// ---------------------------------------------------------------------------
// G423 — batas durasi RESTRICT_TEMPORARY (hari).
// ---------------------------------------------------------------------------
export const RESTRICT_MIN_DAYS = 1;
export const RESTRICT_MAX_DAYS = 30;

// ---------------------------------------------------------------------------
// G421 — export.
// ---------------------------------------------------------------------------
export const EXPORT_MAX_ROWS = 5000;
export const EXPORT_DESCRIPTION_TRUNCATE = 160;

// ---------------------------------------------------------------------------
// Tipe notifikasi moderasi (nilai enum NotificationType baru — lihat fragment
// schema; dipakai via string-cast agar tsc lolos sebelum `prisma generate`).
// ---------------------------------------------------------------------------
export const NOTIF_MODERATION_REPORT_UPDATE = 'MODERATION_REPORT_UPDATE';
export const NOTIF_MODERATION_ITEM_TAKEDOWN = 'MODERATION_ITEM_TAKEDOWN';
export const NOTIF_MODERATION_APPEAL_DECIDED = 'MODERATION_APPEAL_DECIDED';

/** Aksi event untuk keputusan final pertama (snapshot G409 disimpan di sini). */
export const FINAL_DECISION_EVENT_ACTIONS: ModerationEventActionValue[] = [
  'TAKEDOWN',
  'DISMISSED',
  'NO_ACTION',
];
