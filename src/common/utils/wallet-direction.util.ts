/**
 * ADM-007 — arah mutasi wallet diturunkan dari `WalletTransactionType`.
 *
 * `WalletTransaction.amount` selalu disimpan sebagai nominal POSITIF;
 * arah mutasi (menambah/mengurangi saldo) tersirat di `type`. UI yang
 * menebak arah dari tanda amount akan menampilkan semua transaksi sebagai
 * "+" hijau — kebalikan dari kenyataan untuk penarikan/fee/transfer keluar.
 * Satu-satunya sumber kebenaran: peta di bawah ini.
 *
 * Tipe yang TIDAK terdaftar di kedua set (mis. tipe baru dari migrasi
 * mendatang yang belum dipetakan) → 'UNKNOWN': UI harus merendernya
 * netral (tanpa tanda +/- dan tanpa warna hijau/merah). Menganggap tipe
 * tak dikenal sebagai CREDIT akan menampilkan tanda "+" hijau untuk
 * transaksi yang mungkin debit — itu kebohongan finansial.
 */

import { WalletTransactionType } from '@prisma/client';

/** Arah mutasi untuk satu tipe transaksi wallet. */
export type WalletTxDirection = 'DEBIT' | 'CREDIT' | 'UNKNOWN';

/**
 * Tipe transaksi yang MENGURANGI saldo wallet pemegang.
 */
export const DEBIT_WALLET_TX_TYPES: ReadonlySet<WalletTransactionType> =
  new Set([
    WalletTransactionType.WITHDRAW,
    WalletTransactionType.FEE_DEDUCT,
    WalletTransactionType.ADMIN_DEBIT,
    WalletTransactionType.TRANSFER_SENT,
    WalletTransactionType.ORDER_LOCK,
    WalletTransactionType.SUBSCRIPTION_PAYMENT,
  ]);

/**
 * Tipe transaksi yang MENAMBAH saldo wallet pemegang.
 */
export const CREDIT_WALLET_TX_TYPES: ReadonlySet<WalletTransactionType> =
  new Set([
    WalletTransactionType.TOP_UP,
    WalletTransactionType.ORDER_RELEASE,
    WalletTransactionType.ORDER_REFUND,
    WalletTransactionType.REFERRAL_REWARD,
    WalletTransactionType.ADMIN_CREDIT,
    WalletTransactionType.DISPUTE_RELEASE,
    WalletTransactionType.TRANSFER_RECEIVED,
    WalletTransactionType.CAMPAIGN_CASHBACK,
    WalletTransactionType.TOPUP_BONUS,
    WalletTransactionType.MILESTONE_RELEASE,
  ]);

/**
 * Tentukan arah mutasi dari tipe transaksi. Tipe tak dikenal → 'UNKNOWN'
 * (UI merender netral), bukan CREDIT.
 */
export function walletTxDirection(
  type: WalletTransactionType | string,
): WalletTxDirection {
  const t = type as WalletTransactionType;
  if (DEBIT_WALLET_TX_TYPES.has(t)) return 'DEBIT';
  if (CREDIT_WALLET_TX_TYPES.has(t)) return 'CREDIT';
  return 'UNKNOWN';
}
