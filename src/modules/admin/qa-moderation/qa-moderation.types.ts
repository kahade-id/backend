/**
 * GAP-F (G426–G450): Moderasi platform Q&A profil — tipe bersama.
 *
 * Enum-enum ini mencerminkan fragment schema
 * `fixes/fragments/gap-F-B-schema.prisma`. Karena prisma client belum
 * di-generate ulang, service memakai raw SQL ($queryRaw/$executeRaw) dan
 * string literal di bawah ini sebagai nilai enum DB.
 */

export const QA_MODERATION_REASONS = [
  'SPAM',
  'PROFANITY',
  'HARASSMENT',
  'PII_LEAK',
  'SCAM_SUSPECTED',
  'OFF_TOPIC',
  'OTHER',
] as const;
export type QaModerationReason = (typeof QA_MODERATION_REASONS)[number];

export const QA_HIDDEN_BY_TYPES = ['OWNER', 'MODERATOR'] as const;
export type QaHiddenByType = (typeof QA_HIDDEN_BY_TYPES)[number];

export const QA_REPORT_TARGETS = ['QUESTION', 'COMMENT'] as const;
export type QaReportTarget = (typeof QA_REPORT_TARGETS)[number];

export const QA_REPORT_STATUSES = ['PENDING', 'UNDER_REVIEW', 'DISMISSED', 'ACTION_TAKEN'] as const;
export type QaReportStatus = (typeof QA_REPORT_STATUSES)[number];

export const QA_APPEAL_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;
export type QaAppealStatus = (typeof QA_APPEAL_STATUSES)[number];

export const QA_EVENT_ACTIONS = [
  'HIDDEN',
  'UNHIDDEN',
  'REDACTED',
  'DELETED',
  'APPEAL_SUBMITTED',
  'APPEAL_APPROVED',
  'APPEAL_REJECTED',
] as const;
export type QaEventAction = (typeof QA_EVENT_ACTIONS)[number];

export const QA_DELETE_APPROVAL_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;
export type QaDeleteApprovalStatus = (typeof QA_DELETE_APPROVAL_STATUSES)[number];

/** Baris mentah dari qa_reports (snake_case, sesuai $queryRaw). */
export interface QaReportRow {
  id: string;
  target_type: QaReportTarget;
  target_id: string;
  reporter_id: string;
  reporter_username: string | null;
  reason_code: QaModerationReason;
  note: string | null;
  status: QaReportStatus;
  assigned_admin_id: string | null;
  assigned_admin_name: string | null;
  resolved_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** Baris mentah dari qa_appeals. */
export interface QaAppealRow {
  id: string;
  target_type: QaReportTarget;
  target_id: string;
  appellant_id: string;
  appellant_username: string | null;
  reason: string;
  status: QaAppealStatus;
  reviewer_admin_id: string | null;
  reviewer_admin_name: string | null;
  reviewed_at: Date | null;
  review_note: string | null;
  created_at: Date;
}

/** Baris mentah dari qa_moderation_events. */
export interface QaModerationEventRow {
  id: string;
  target_type: QaReportTarget;
  target_id: string;
  actor_admin_id: string;
  actor_admin_name: string | null;
  action: QaEventAction;
  reason_code: QaModerationReason | null;
  note: string | null;
  created_at: Date;
}

/** Baris mentah dari qa_delete_requests. */
export interface QaDeleteRequestRow {
  id: string;
  target_type: QaReportTarget;
  target_id: string;
  requested_by_admin_id: string;
  requester_admin_name: string | null;
  approved_by_admin_id: string | null;
  approver_admin_name: string | null;
  status: QaDeleteApprovalStatus;
  reason: string | null;
  created_at: Date;
  decided_at: Date | null;
}

/** Masking username parsial untuk list antrean (G433): "budi123" → "bu•••". */
export function maskUsername(username: string | null | undefined): string | null {
  if (!username) return null;
  const visible = username.slice(0, 2);
  return `${visible}•••`;
}
