/**
 * SP-010: source of truth backend untuk benefit Kahade Plus.
 *
 * Sebelumnya daftar benefit hanya hardcode di frontend (dan duplikat dalam
 * `getBenefits()`). Konstanta ini dipakai oleh:
 *  - `SubscriptionsService.getBenefits()` (detail benefit user berlangganan)
 *  - `SubscriptionsService.getPlans()` (field `benefits` aditif per plan)
 * agar frontend bisa membaca benefit dari backend, bukan hardcode.
 */
export interface SubscriptionBenefit {
  key: string;
  label: string;
  description: string;
}

export const KAHADE_PLUS_BENEFITS: SubscriptionBenefit[] = [
  {
    key: 'fee_savings',
    label: 'Fee Savings',
    description: 'Reduced platform fees on transactions',
  },
  {
    key: 'priority_support',
    label: 'Priority Support',
    description: 'Faster customer support response',
  },
  { key: 'badge', label: 'Kahade Plus Badge', description: 'Exclusive profile badge' },
];
