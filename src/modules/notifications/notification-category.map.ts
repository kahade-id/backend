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
  NotificationType.WALLET_TOPUP_SUCCESS,
  NotificationType.WALLET_TOPUP_FAILED,
  NotificationType.WALLET_WITHDRAW_SUCCESS,
  NotificationType.WALLET_WITHDRAW_FAILED,
  NotificationType.WALLET_FUNDS_RELEASED,
  NotificationType.WALLET_TRANSFER_SENT,
  NotificationType.WALLET_TRANSFER_RECEIVED,
]);

const PROMOSI_TYPES: ReadonlySet<NotificationType> = new Set([
  NotificationType.SUBSCRIPTION_ACTIVATED,
  NotificationType.SUBSCRIPTION_EXPIRY_REMINDER,
  NotificationType.SUBSCRIPTION_EXPIRED,
  NotificationType.SUBSCRIPTION_RENEWED,
  NotificationType.REFERRAL_REWARD_RECEIVED,
  NotificationType.BADGE_AWARDED,
  NotificationType.RANK_UPGRADED,
]);

export function getCategoryForType(type: NotificationType): NotificationCategory {
  if (TRANSAKSI_TYPES.has(type)) return NotificationCategory.TRANSAKSI;
  if (PROMOSI_TYPES.has(type)) return NotificationCategory.PROMOSI;
  return NotificationCategory.INFORMASI;
}
