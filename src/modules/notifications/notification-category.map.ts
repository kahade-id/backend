import { NotificationType, NotificationCategory } from '@prisma/client';

const TRANSAKSI_TYPES: ReadonlySet<NotificationType> = new Set([
  NotificationType.ORDER_NEW,
  NotificationType.ORDER_ACCEPTED,
  NotificationType.ORDER_REJECTED,
  NotificationType.ORDER_CANCELLED_TIMEOUT,
  NotificationType.ORDER_CANCELLED,
  NotificationType.ORDER_PAYMENT_RECEIVED,
  NotificationType.ORDER_SHIPPED,
  NotificationType.ORDER_DEADLINE_REMINDER,
  NotificationType.ORDER_EXTENSION_REQUESTED,
  NotificationType.ORDER_EXTENSION_APPROVED,
  NotificationType.ORDER_EXTENSION_REJECTED,
  NotificationType.ORDER_COMPLETED,
  NotificationType.ORDER_AUTOCOMPLETED,
  NotificationType.ORDER_DELIVERED,
  NotificationType.DISPUTE_SUBMITTED,
  NotificationType.DISPUTE_ADMIN_JOINED,
  NotificationType.DISPUTE_DECISION,
  NotificationType.DISPUTE_EVIDENCE_SUBMITTED,
  NotificationType.DISPUTE_CLAIM_SUBMITTED,
  NotificationType.DISPUTE_ESCALATED,
  NotificationType.DISPUTE_MESSAGE_RECEIVED,
  NotificationType.DISPUTE_ESCALATION_SLA_WARNING,
  NotificationType.DISPUTE_ESCALATION_SLA_BREACHED,
  NotificationType.WALLET_TOPUP_SUCCESS,
  NotificationType.WALLET_TOPUP_FAILED,
  NotificationType.WALLET_WITHDRAW_SUCCESS,
  NotificationType.WALLET_WITHDRAW_FAILED,
  NotificationType.WALLET_FUNDS_RELEASED,
  NotificationType.WALLET_REFUND_RECEIVED,
  NotificationType.WALLET_TRANSFER_SENT,
  NotificationType.WALLET_TRANSFER_RECEIVED,
  // Audit 2026-10-10 (BE-20): dana menunggu rekening = urusan dana (TRANSAKSI),
  // bukan INFORMASI — tab Transaksi adalah tempat user mencarinya.
  NotificationType.ESCROW_HELD_NO_BANK,
  // GAP-C (G193): notifikasi tahap milestone escrow.
  NotificationType.MILESTONE_SUBMITTED,
  NotificationType.MILESTONE_REVISION_REQUESTED,
  NotificationType.MILESTONE_ACCEPTED,
  NotificationType.MILESTONE_RELEASED,
  NotificationType.MILESTONE_DEADLINE_REMINDER,
  NotificationType.MILESTONE_CANCELLED,
]);

const PROMOSI_TYPES: ReadonlySet<NotificationType> = new Set([
  NotificationType.SUBSCRIPTION_ACTIVATED,
  NotificationType.SUBSCRIPTION_EXPIRY_REMINDER,
  NotificationType.SUBSCRIPTION_EXPIRED,
  NotificationType.SUBSCRIPTION_RENEWED,
  NotificationType.REFERRAL_REWARD_RECEIVED,
  NotificationType.BADGE_AWARDED,
  NotificationType.RANK_UPGRADED,
  NotificationType.VOUCHER_ISSUED,
  NotificationType.CAMPAIGN_CASHBACK_CREDITED,
  NotificationType.TOPUP_BONUS_CREDITED,
]);

/**
 * GAP-F (G416/G417): tipe notifikasi moderasi laporan etalase.
 * Nilai enum baru (lihat fragment gap-F-A-schema.prisma) — ditulis sebagai
 * string agar file ini tetap dikompilasi sebelum `prisma generate` pasca-merge.
 */
const MODERATION_TYPE_NAMES: ReadonlySet<string> = new Set([
  'MODERATION_REPORT_UPDATE',
  'MODERATION_ITEM_TAKEDOWN',
  'MODERATION_APPEAL_DECIDED',
]);

export function getCategoryForType(type: NotificationType): NotificationCategory {
  if (TRANSAKSI_TYPES.has(type)) return NotificationCategory.TRANSAKSI;
  if (PROMOSI_TYPES.has(type)) return NotificationCategory.PROMOSI;
  if (MODERATION_TYPE_NAMES.has(type as string)) return NotificationCategory.INFORMASI;
  return NotificationCategory.INFORMASI;
}
