"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCategoryForType = getCategoryForType;
const client_1 = require("@prisma/client");
const TRANSAKSI_TYPES = new Set([
    client_1.NotificationType.ORDER_NEW,
    client_1.NotificationType.ORDER_ACCEPTED,
    client_1.NotificationType.ORDER_REJECTED,
    client_1.NotificationType.ORDER_CANCELLED_TIMEOUT,
    client_1.NotificationType.ORDER_CANCELLED,
    client_1.NotificationType.ORDER_PAYMENT_RECEIVED,
    client_1.NotificationType.ORDER_SHIPPED,
    client_1.NotificationType.ORDER_DEADLINE_REMINDER,
    client_1.NotificationType.ORDER_EXTENSION_REQUESTED,
    client_1.NotificationType.ORDER_EXTENSION_APPROVED,
    client_1.NotificationType.ORDER_EXTENSION_REJECTED,
    client_1.NotificationType.ORDER_COMPLETED,
    client_1.NotificationType.ORDER_AUTOCOMPLETED,
    client_1.NotificationType.ORDER_DELIVERED,
    client_1.NotificationType.DISPUTE_SUBMITTED,
    client_1.NotificationType.DISPUTE_ADMIN_JOINED,
    client_1.NotificationType.DISPUTE_DECISION,
    client_1.NotificationType.WALLET_TOPUP_SUCCESS,
    client_1.NotificationType.WALLET_TOPUP_FAILED,
    client_1.NotificationType.WALLET_WITHDRAW_SUCCESS,
    client_1.NotificationType.WALLET_WITHDRAW_FAILED,
    client_1.NotificationType.WALLET_FUNDS_RELEASED,
    client_1.NotificationType.WALLET_TRANSFER_SENT,
    client_1.NotificationType.WALLET_TRANSFER_RECEIVED,
]);
const PROMOSI_TYPES = new Set([
    client_1.NotificationType.SUBSCRIPTION_ACTIVATED,
    client_1.NotificationType.SUBSCRIPTION_EXPIRY_REMINDER,
    client_1.NotificationType.SUBSCRIPTION_EXPIRED,
    client_1.NotificationType.SUBSCRIPTION_RENEWED,
    client_1.NotificationType.REFERRAL_REWARD_RECEIVED,
    client_1.NotificationType.BADGE_AWARDED,
    client_1.NotificationType.RANK_UPGRADED,
]);
function getCategoryForType(type) {
    if (TRANSAKSI_TYPES.has(type))
        return client_1.NotificationCategory.TRANSAKSI;
    if (PROMOSI_TYPES.has(type))
        return client_1.NotificationCategory.PROMOSI;
    return client_1.NotificationCategory.INFORMASI;
}
