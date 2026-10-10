/**
 * Audit Notifikasi 2026-10-10 (BE-06/BE-07): SATU peta tipe notifikasi →
 * kelompok preferensi, dipakai bersama oleh:
 *   - push.service (gate `<kelompok>Push` sebelum kirim push),
 *   - notifications.service (gate `<kelompok>InApp` saat list/unread-count
 *     dan `isInAppEnabled` sebelum pembuat menulis baris).
 *
 * Sebelumnya ada dua daftar terpisah yang saling menyimpang: in-app tidak
 * mengenal MILESTONE_*, ESCROW_HELD_NO_BANK, QUESTION_UNANSWERED_REMINDER;
 * `NotificationsService.shouldSendPush` tidak mengenal DISPUTE_MESSAGE/SLA,
 * WALLET_REFUND, KYC_, SYSTEM_. Prefix-match di sini mengikuti keputusan
 * NCC-013 (RATING_* dan MILESTONE_* = kelompok order, selaras toggle lokal FE).
 *
 * Kelompok `security` (SECURITY_*, KYC_*, SYSTEM_*): push boleh digate
 * `securityPush` (selalu true — dipaksa server), in-app TIDAK PERNAH ditekan.
 */
export type PreferenceGroup =
  | 'order'
  | 'wallet'
  | 'security'
  | 'chat'
  | 'dispute'
  | 'ranking'
  | 'marketing';

export type PushPreferenceField = `${PreferenceGroup}Push`;
export type InAppPreferenceField = `${Exclude<PreferenceGroup, 'security'>}InApp`;

const MARKETING_TYPES: ReadonlySet<string> = new Set([
  'VOUCHER_ISSUED',
  'CAMPAIGN_CASHBACK_CREDITED',
  'TOPUP_BONUS_CREDITED',
  // Nudge non-kritis: boleh dimatikan user via preferensi marketing.
  'QUESTION_UNANSWERED_REMINDER',
]);

const RANKING_TYPES: ReadonlySet<string> = new Set([
  'RANK_UPGRADED',
  'REFERRAL_REWARD_RECEIVED',
  'BADGE_AWARDED',
]);

export function preferenceGroupForType(type: string | null | undefined): PreferenceGroup | null {
  if (!type) return null;
  if (type.startsWith('ORDER_')) return 'order';
  if (type.startsWith('MILESTONE_')) return 'order';
  if (type.startsWith('RATING_')) return 'order';
  if (type.startsWith('WALLET_')) return 'wallet';
  // Dana menunggu rekening = urusan dompet (sebelumnya tak terpetakan).
  if (type === 'ESCROW_HELD_NO_BANK') return 'wallet';
  if (type.startsWith('SECURITY_')) return 'security';
  if (type.startsWith('KYC_')) return 'security';
  if (type.startsWith('SYSTEM_')) return 'security';
  if (type.startsWith('CHAT_')) return 'chat';
  if (type.startsWith('DISPUTE_')) return 'dispute';
  if (type.startsWith('SUBSCRIPTION_')) return 'ranking';
  if (RANKING_TYPES.has(type)) return 'ranking';
  if (MARKETING_TYPES.has(type)) return 'marketing';
  return null;
}

/** Field `NotificationPreference` yang menggate PUSH untuk tipe ini; null = selalu kirim. */
export function pushPreferenceFieldForType(type: string | null | undefined): PushPreferenceField | null {
  const group = preferenceGroupForType(type);
  return group ? (`${group}Push` as PushPreferenceField) : null;
}

/** Field yang menggate IN-APP; null = tidak pernah ditekan (termasuk keamanan). */
export function inAppPreferenceFieldForType(type: string | null | undefined): InAppPreferenceField | null {
  const group = preferenceGroupForType(type);
  if (!group || group === 'security') return null;
  return `${group}InApp` as InAppPreferenceField;
}
