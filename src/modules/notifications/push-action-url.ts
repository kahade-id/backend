/**
 * Audit Notifikasi 2026-10-10 (BE-09): SATU helper turunan `actionUrl` dari
 * kunci payload push. Dulu `notification.processor` dan `push.service`
 * punya salinan masing-masing yang menyimpang (processor: `orderLinkToken →
 * /link/<t>` yang tidak dikenal klien, tanpa `milestoneId`; push.service:
 * tanpa `orderLinkToken`). Path di sini harus dikenali
 * `lib/notification-routing.ts` di aplikasi.
 */
export function derivePushActionUrl(
  data?: Record<string, string>,
  opts: { notificationFallback?: boolean } = {},
): string | undefined {
  if (!data) return undefined;
  if (data.actionUrl) return data.actionUrl;
  if (data.orderId) return `/order/${encodeURIComponent(data.orderId)}`;
  // Tautan order: rute klien `/order-link/[token]` (alias publik `/o/<token>`).
  if (data.orderLinkToken) return `/order-link/${encodeURIComponent(data.orderLinkToken)}`;
  const roomId = data.roomId ?? data.chatRoomId;
  if (roomId) return `/chat/${encodeURIComponent(roomId)}`;
  if (data.disputeId) return `/dispute/${encodeURIComponent(data.disputeId)}`;
  if (data.milestoneId) return `/milestones/${encodeURIComponent(data.milestoneId)}`;
  // Livechat support (SUPPORT_AGENT_REPLY) — sama dengan actionUrl baris notifikasinya.
  if (data.conversationId) return `/support/chat/${encodeURIComponent(data.conversationId)}`;
  const txId = data.transactionId ?? data.txId;
  if (txId) return `/wallet/transaction?id=${encodeURIComponent(txId)}`;
  if (opts.notificationFallback && data.notificationId) {
    return `/notifications?notificationId=${encodeURIComponent(data.notificationId)}`;
  }
  return undefined;
}
