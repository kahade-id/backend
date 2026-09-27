/**
 * ADM-007 — arah mutasi wallet diturunkan dari tipe, bukan dari tanda amount.
 */
import { WalletTransactionType } from '@prisma/client';
import {
  CREDIT_WALLET_TX_TYPES,
  DEBIT_WALLET_TX_TYPES,
  walletTxDirection,
} from './wallet-direction.util';

describe('wallet-direction.util (ADM-007)', () => {
  it('menandai tipe penarikan/potongan/keluar sebagai DEBIT', () => {
    const debitTypes: WalletTransactionType[] = [
      'WITHDRAW',
      'FEE_DEDUCT',
      'ADMIN_DEBIT',
      'TRANSFER_SENT',
      'ORDER_LOCK',
      'SUBSCRIPTION_PAYMENT',
    ];
    for (const t of debitTypes) {
      expect(walletTxDirection(t)).toBe('DEBIT');
      expect(DEBIT_WALLET_TX_TYPES.has(t)).toBe(true);
    }
  });

  it('menandai tipe pemasukan sebagai CREDIT', () => {
    const creditTypes: WalletTransactionType[] = [
      'TOP_UP',
      'ORDER_RELEASE',
      'ORDER_REFUND',
      'REFERRAL_REWARD',
      'ADMIN_CREDIT',
      'DISPUTE_RELEASE',
      'TRANSFER_RECEIVED',
      'CAMPAIGN_CASHBACK',
      'TOPUP_BONUS',
      'MILESTONE_RELEASE',
    ];
    for (const t of creditTypes) {
      expect(walletTxDirection(t)).toBe('CREDIT');
      expect(CREDIT_WALLET_TX_TYPES.has(t)).toBe(true);
    }
  });

  it('fail-closed: tipe tak dikenal → UNKNOWN (UI merender netral, bukan tanda "+")', () => {
    expect(walletTxDirection('SOME_FUTURE_TYPE' as WalletTransactionType)).toBe(
      'UNKNOWN',
    );
  });

  it('setiap anggota enum WalletTransactionType dipetakan (tidak ada celah)', () => {
    for (const t of Object.values(WalletTransactionType)) {
      const dir = walletTxDirection(t);
      expect(['DEBIT', 'CREDIT']).toContain(dir);
    }
  });
});
