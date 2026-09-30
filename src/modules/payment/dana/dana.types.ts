/**
 * Tipe kontrak integrasi DANA Enterprise (Gapura Payment Gateway +
 * Disbursement). Dipetakan dari:
 *   - https://dashboard.dana.id/api-docs-v2/api/payment-gateway/create-order-custom
 *   - SDK resmi dana-python (endpoint path + skema signature)
 *   - Fixture resmi dana-id/uat-script (resource/request/components/*.json)
 */

/** Kanal pembayaran Create Order yang dipakai Kahade. */
export type DanaPayKind = 'QRIS' | 'VA' | 'BALANCE';

/** payMethod SNAP untuk Create Order. */
export const DANA_PAY_METHOD = {
  QRIS: 'NETWORK_PAY',
  VA: 'VIRTUAL_ACCOUNT',
  BALANCE: 'BALANCE',
} as const;

/**
 * payOption untuk QRIS. VA memakai VIRTUAL_ACCOUNT_<BANK>, mis.
 * VIRTUAL_ACCOUNT_BRI / VIRTUAL_ACCOUNT_PANIN / VIRTUAL_ACCOUNT_CIMB /
 * VIRTUAL_ACCOUNT_BTPN (daftar sandbox; produksi dikonfirmasi ke DANA).
 */
export const DANA_PAY_OPTION_QRIS = 'NETWORK_PAY_PG_QRIS';

export interface DanaCreateOrderParams {
  kind: DanaPayKind;
  /**
   * Idempotency key di sisi DANA (merchantId + partnerReferenceNo).
   * MAKS 25 karakter untuk QRIS.
   */
  partnerReferenceNo: string;
  amountIdr: number;
  orderTitle?: string;
  /** VA only: kode bank, mis. 'BRI' → payOption VIRTUAL_ACCOUNT_BRI. */
  bankCode?: string;
  /** Menit kedaluwarsa (sandbox: maks 30). Default dari config. */
  expiryMinutes?: number;
  buyerExternalUserId?: string;
}

export interface DanaCreatedOrder {
  partnerReferenceNo: string;
  /** Transaction identifier di sistem DANA. */
  referenceNo: string;
  /**
   * QRIS → string QR EMVCo; VA → nomor/payment code (DANA auto-generate);
   * BALANCE → '' (tidak dipakai).
   */
  paymentCode: string;
  /** Hanya untuk skenario REDIRECT / non-QRIS-non-VA. */
  webRedirectUrl?: string;
  amountIdr: number;
  expiresAt: Date;
}

export type DanaOrderStatus =
  | 'PENDING'
  | 'SUCCESS'
  | 'FAILED'
  | 'EXPIRED'
  | 'UNKNOWN';

/** latestTransactionStatus pada FinishNotify: "00" = sukses. */
export const DANA_TX_STATUS_SUCCESS = '00';

export interface DanaOrderDetail {
  status: DanaOrderStatus;
  amountIdr: number | null;
  referenceNo: string;
  partnerReferenceNo: string;
}

export interface DanaRefundParams {
  partnerReferenceNo: string;
  /** Nomor refund unik di sisi merchant (idempoten). */
  partnerRefundNo: string;
  amountIdr: number;
  reason?: string;
}

export interface DanaRefundResult {
  partnerRefundNo: string;
  referenceNo: string;
  status: DanaOrderStatus;
}

/** Payload FinishNotify (webhook) yang sudah diparsing. */
export interface DanaFinishNotify {
  originalPartnerReferenceNo: string;
  originalReferenceNo: string;
  originalExternalId: string;
  merchantId: string;
  /** "00" = sukses. */
  latestTransactionStatus: string;
  transactionStatusDesc: string;
  amountIdr: number | null;
  paidAt: string | null;
  externalStoreId?: string;
}

/**
 * Payload Transfer to Bank Notify (webhook disbursement) yang sudah diparsing.
 * Dok: DANA API "Transfer to Bank Notify" — DANA mengirim update status
 * transfer bank ke endpoint merchant setelah pemrosesan bank selesai.
 * latestTransactionStatus: 00=sukses, 01/02/03=pending, 04-07=gagal.
 */
export interface DanaDisbursementNotify {
  originalPartnerReferenceNo: string;
  originalReferenceNo: string;
  /** "00"=sukses, "01"/"02"/"03"=pending, "04"-"07"=gagal. */
  latestTransactionStatus: string;
  transactionStatusDesc: string;
  amountIdr: number | null;
}

/** Disbursement → rekening bank. */
export interface DanaTransferToBankParams {
  partnerReferenceNo: string;
  beneficiaryAccountNumber: string;
  /** Kode bank SNAP, mis. '014' (BCA). */
  beneficiaryBankCode: string;
  beneficiaryAccountName?: string;
  amountIdr: number;
}

export interface DanaTransferResult {
  partnerReferenceNo: string;
  referenceNo: string;
  status: DanaOrderStatus;
}

/** Disbursement → akun DANA (e-money). */
export interface DanaTransferToDanaParams {
  partnerReferenceNo: string;
  /** Nomor HP akun DANA tujuan (format 628...). */
  customerNumber: string;
  amountIdr: number;
}

export interface DanaBankAccountInquiryParams {
  partnerReferenceNo: string;
  beneficiaryAccountNumber: string;
  beneficiaryBankCode: string;
  amountIdr?: number;
}

export interface DanaBankAccountInquiryResult {
  accountNumber: string;
  accountName: string | null;
  bankCode: string;
  /** true bila nama pemilik rekening terverifikasi oleh bank. */
  verified: boolean;
}

/** Disbursement → saldo DANA (produk "Disburse to Balance"; endpoint sama dengan topup). */
export interface DanaTopupToBalanceParams {
  partnerReferenceNo: string;
  /** Nomor HP akun DANA tujuan (format 628...). */
  customerNumber: string;
  amountIdr: number;
  /** Biaya topup (IDR) — dikirim terpisah sebagai feeAmount (fixture resmi). */
  feeAmountIdr?: number;
}

/** IPG Cashier Pay (redirection). */
export interface DanaCashierPayOrderParams {
  partnerReferenceNo: string;
  amountIdr: number;
  orderTitle?: string;
  expiryMinutes?: number;
}

export interface DanaCashierPayOrder {
  partnerReferenceNo: string;
  referenceNo: string;
  webRedirectUrl?: string;
  amountIdr: number;
  expiresAt: Date;
}
