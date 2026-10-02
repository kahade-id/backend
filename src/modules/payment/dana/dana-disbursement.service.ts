import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError } from 'axios';
import {
  DanaBankAccountInquiryParams,
  DanaBankAccountInquiryResult,
  DanaOrderStatus,
  DanaTopupToBalanceParams,
  DanaTransferResult,
  DanaTransferToBankParams,
  DanaTransferToDanaParams,
} from './dana.types';
import { buildDanaHeaders, jakartaTimestamp, signSnapRequest } from './dana-snap.util';
import { sanitizeProviderError } from '../../../common/utils/sanitize-provider-error';
import { mapDanaTxStatus, parseDanaAmount, toDanaAmount } from './dana-payment.service';

/**
 * DANA Enterprise — Disbursement (uang KELUAR).
 *
 * Dipakai untuk:
 *   - Withdrawal / pencairan ke rekening bank (pengganti Iris)
 *   - Transfer ke akun DANA
 *   - Bank Account Inquiry → verifikasi rekening sebelum disbursement
 *     (pengganti Flash Transfer [001] Account Inquiry)
 *
 * Endpoint (SDK resmi dana-python):
 *   Transfer to bank:        POST /v1.0/emoney/transfer-bank.htm
 *   Transfer bank status:     POST /v1.0/emoney/transfer-bank-status.htm
 *   Transfer to DANA:         POST /rest/v1.0/emoney/topup
 *   Transfer to DANA status:  POST /rest/v1.0/emoney/topup-status
 *   Bank account inquiry:     POST /v1.0/emoney/bank-account-inquiry.htm
 *   DANA account inquiry:     POST /rest/v1.0/emoney/account-inquiry
 */

const PATH_TRANSFER_BANK = '/v1.0/emoney/transfer-bank.htm';
const PATH_TRANSFER_BANK_STATUS = '/v1.0/emoney/transfer-bank-status.htm';
const PATH_TOPUP_DANA = '/rest/v1.0/emoney/topup';
const PATH_TOPUP_DANA_STATUS = '/rest/v1.0/emoney/topup-status';
const PATH_BANK_ACCOUNT_INQUIRY = '/v1.0/emoney/bank-account-inquiry.htm';
const PATH_DANA_ACCOUNT_INQUIRY = '/rest/v1.0/emoney/account-inquiry';

function mapDisbursementStatus(code: string | undefined | null): DanaOrderStatus {
  const s = (code ?? '').trim();
  // Response code disbursement: 200xxxx = sukses.
  if (s.startsWith('200')) return 'SUCCESS';
  if (s.startsWith('202') || s === '01' || s === '02') return 'PENDING';
  return mapDanaTxStatus(s);
}

@Injectable()
export class DanaDisbursementService {
  private readonly logger = new Logger(DanaDisbursementService.name);

  constructor(private readonly config: ConfigService) {}

  private cfg() {
    return {
      baseUrl: this.config.get<string>('dana.baseUrl') ?? '',
      partnerId: this.config.get<string>('dana.partnerId') ?? '',
      privateKey: this.config.get<string>('dana.privateKey') ?? '',
      origin: this.config.get<string>('dana.origin') ?? '',
      channelId: this.config.get<string>('dana.channelId') ?? '95221',
      debug: this.config.get<boolean>('dana.debug') ?? false,
    };
  }

  get enabled(): boolean {
    const c = this.cfg();
    return Boolean(c.baseUrl && c.partnerId && c.privateKey);
  }

  private assertEnabled(): void {
    if (!this.enabled) {
      throw new ServiceUnavailableException({
        code: 'DANA_NOT_CONFIGURED',
        message: 'DANA credentials are not configured',
      });
    }
  }

  private async post<T>(resourcePath: string, body: Record<string, unknown>): Promise<T> {
    const c = this.cfg();
    const bodyStr = JSON.stringify(body);
    const signed = signSnapRequest({
      method: 'POST',
      resourcePath,
      body: bodyStr,
      privateKeyPem: c.privateKey,
    });
    const headers = buildDanaHeaders({
      partnerId: c.partnerId,
      origin: c.origin,
      channelId: c.channelId,
      debug: c.debug,
      signed,
    });
    try {
      const res = await axios.post<T>(`${c.baseUrl}${resourcePath}`, bodyStr, {
        headers,
        timeout: 20000,
      });
      return res.data;
    } catch (e) {
      const err = e as AxiosError<{ responseMessage?: string }>;
      const detail = err.response?.data?.responseMessage ?? err.message;
      // SYS-B-503: detail mentah provider (kerap meng-echo nomor rekening
      // beneficiary) hanya ke log internal teredaksi; yang dilempar ke
      // pemanggil hanya kode generik (pola SEC-204).
      const sanitized = sanitizeProviderError(detail);
      this.logger.error(
        `DANA Disbursement POST ${resourcePath} gagal [${sanitized.code}]: ${sanitized.detailForLog}`,
      );
      throw new ServiceUnavailableException({
        code: 'DANA_API_ERROR',
        message: `DANA API error: ${sanitized.code}`,
      });
    }
  }

  /** Transfer ke rekening bank (withdrawal/pencairan). */
  async transferToBank(params: DanaTransferToBankParams): Promise<DanaTransferResult> {
    this.assertEnabled();
    const amount = toDanaAmount(params.amountIdr);
    const res = (await this.post<Record<string, unknown>>(PATH_TRANSFER_BANK, {
      partnerReferenceNo: params.partnerReferenceNo,
      beneficiaryAccountNumber: params.beneficiaryAccountNumber,
      beneficiaryBankCode: params.beneficiaryBankCode,
      amount: { value: amount, currency: 'IDR' },
      additionalInfo: {
        fundType: 'MERCHANT_WITHDRAW_FOR_CORPORATE',
        ...(params.beneficiaryAccountName
          ? { beneficiaryAccountName: params.beneficiaryAccountName }
          : {}),
      },
    })) as Record<string, any>;
    const responseCode = String(res.responseCode ?? '');
    if (!responseCode.startsWith('200') && !responseCode.startsWith('202')) {
      // SYS-B-503: responseMessage mentah provider tidak di-interpolasi ke
      // pesan error (bisa meng-echo PII) — hanya kode generik + responseCode.
      const providerErr = sanitizeProviderError(res.responseMessage ?? '');
      this.logger.warn(
        `DANA transfer bank ditolak provider [${providerErr.code}] responseCode=${responseCode}: ${providerErr.detailForLog}`,
      );
      throw new ServiceUnavailableException({
        code: 'DANA_TRANSFER_BANK_FAILED',
        message: `DANA transfer bank gagal: ${providerErr.code} (responseCode ${responseCode})`,
      });
    }
    return {
      partnerReferenceNo: params.partnerReferenceNo,
      referenceNo: String(res.referenceNo ?? ''),
      status: mapDisbursementStatus(responseCode),
    };
  }

  /** Status transfer ke bank — untuk rekonsiliasi/polling. */
  async transferToBankStatus(partnerReferenceNo: string): Promise<DanaTransferResult> {
    this.assertEnabled();
    const res = (await this.post<Record<string, unknown>>(PATH_TRANSFER_BANK_STATUS, {
      originalPartnerReferenceNo: partnerReferenceNo,
      originalReferenceNo: null,
      originalExternalId: null,
      serviceCode: '00',
      additionalInfo: null,
    })) as Record<string, any>;
    return {
      partnerReferenceNo,
      referenceNo: String(res.originalReferenceNo ?? res.referenceNo ?? ''),
      status: mapDisbursementStatus(
        String(res.latestTransactionStatus ?? res.responseCode ?? ''),
      ),
    };
  }

  /** Transfer ke akun DANA (e-money) berdasarkan nomor HP. */
  async transferToDana(params: DanaTransferToDanaParams): Promise<DanaTransferResult> {
    this.assertEnabled();
    const amount = toDanaAmount(params.amountIdr);
    const res = (await this.post<Record<string, unknown>>(PATH_TOPUP_DANA, {
      partnerReferenceNo: params.partnerReferenceNo,
      customerNumber: params.customerNumber,
      amount: { value: amount, currency: 'IDR' },
      transactionDate: jakartaTimestamp(),
      additionalInfo: { fundType: 'AGENT_TOPUP_FOR_USER_SETTLE' },
    })) as Record<string, any>;
    const responseCode = String(res.responseCode ?? '');
    if (!responseCode.startsWith('200') && !responseCode.startsWith('202')) {
      // SYS-B-503: responseMessage mentah provider tidak di-interpolasi ke
      // pesan error (bisa meng-echo PII) — hanya kode generik + responseCode.
      const providerErr = sanitizeProviderError(res.responseMessage ?? '');
      this.logger.warn(
        `DANA transfer to DANA ditolak provider [${providerErr.code}] responseCode=${responseCode}: ${providerErr.detailForLog}`,
      );
      throw new ServiceUnavailableException({
        code: 'DANA_TRANSFER_DANA_FAILED',
        message: `DANA transfer to DANA gagal: ${providerErr.code} (responseCode ${responseCode})`,
      });
    }
    return {
      partnerReferenceNo: params.partnerReferenceNo,
      referenceNo: String(res.referenceNo ?? ''),
      status: mapDisbursementStatus(responseCode),
    };
  }

  /** Status transfer ke akun DANA. */
  async transferToDanaStatus(partnerReferenceNo: string): Promise<DanaTransferResult> {
    this.assertEnabled();
    const res = (await this.post<Record<string, unknown>>(PATH_TOPUP_DANA_STATUS, {
      originalPartnerReferenceNo: partnerReferenceNo,
      originalReferenceNo: null,
      originalExternalId: null,
      serviceCode: '00',
      additionalInfo: null,
    })) as Record<string, any>;
    return {
      partnerReferenceNo,
      referenceNo: String(res.originalReferenceNo ?? res.referenceNo ?? ''),
      status: mapDisbursementStatus(
        String(res.latestTransactionStatus ?? res.responseCode ?? ''),
      ),
    };
  }

  /**
   * Disbursement ke saldo DANA (produk "Disburse to Balance" DANA Enterprise).
   * Endpoint SAMA dengan transferToDana (/rest/v1.0/emoney/topup) — method
   * terpisah untuk kejelasan semantik produk; body mengikuti fixture resmi
   * DANA (TopUpCustomerValid: feeAmount + field null eksplisit).
   */
  async topupToBalance(params: DanaTopupToBalanceParams): Promise<DanaTransferResult> {
    this.assertEnabled();
    const amount = toDanaAmount(params.amountIdr);
    const res = (await this.post<Record<string, unknown>>(PATH_TOPUP_DANA, {
      partnerReferenceNo: params.partnerReferenceNo,
      customerNumber: params.customerNumber,
      amount: { value: amount, currency: 'IDR' },
      feeAmount: { value: toDanaAmount(params.feeAmountIdr ?? 0), currency: 'IDR' },
      transactionDate: jakartaTimestamp(),
      sessionId: null,
      categoryId: null,
      notes: null,
      additionalInfo: {
        extendInfo: null,
        accountType: null,
        fundType: 'AGENT_TOPUP_FOR_USER_SETTLE',
        externalDivisionId: null,
        chargeTarget: null,
        accessToken: null,
        customerId: null,
      },
    })) as Record<string, any>;
    const responseCode = String(res.responseCode ?? '');
    if (!responseCode.startsWith('200') && !responseCode.startsWith('202')) {
      // SYS-B-503: responseMessage mentah provider tidak di-interpolasi ke
      // pesan error (bisa meng-echo PII) — hanya kode generik + responseCode.
      const providerErr = sanitizeProviderError(res.responseMessage ?? '');
      this.logger.warn(
        `DANA topup balance ditolak provider [${providerErr.code}] responseCode=${responseCode}: ${providerErr.detailForLog}`,
      );
      throw new ServiceUnavailableException({
        code: 'DANA_TOPUP_BALANCE_FAILED',
        message: `DANA topup balance gagal: ${providerErr.code} (responseCode ${responseCode})`,
      });
    }
    return {
      partnerReferenceNo: params.partnerReferenceNo,
      referenceNo: String(res.referenceNo ?? ''),
      status: mapDisbursementStatus(responseCode),
    };
  }

  /**
   * Verifikasi rekening bank sebelum disbursement.
   * Pengganti Flash Transfer [001] Account Inquiry (keputusan 2026-09-29).
   */
  async bankAccountInquiry(
    params: DanaBankAccountInquiryParams,
  ): Promise<DanaBankAccountInquiryResult> {
    this.assertEnabled();
    const res = (await this.post<Record<string, unknown>>(PATH_BANK_ACCOUNT_INQUIRY, {
      partnerReferenceNo: params.partnerReferenceNo,
      beneficiaryAccountNumber: params.beneficiaryAccountNumber,
      amount: { value: toDanaAmount(params.amountIdr ?? 0), currency: 'IDR' },
      additionalInfo: {
        fundType: 'MERCHANT_WITHDRAW_FOR_CORPORATE',
        beneficiaryBankCode: params.beneficiaryBankCode,
      },
    })) as Record<string, any>;
    const responseCode = String(res.responseCode ?? '');
    const accountName =
      res.beneficiaryAccountName ?? res.additionalInfo?.beneficiaryAccountName ?? null;
    return {
      accountNumber: params.beneficiaryAccountNumber,
      accountName: accountName ? String(accountName) : null,
      bankCode: params.beneficiaryBankCode,
      verified: responseCode.startsWith('200') && Boolean(accountName),
    };
  }

  /** Inquiry akun DANA berdasarkan nomor HP. */
  async danaAccountInquiry(
    partnerReferenceNo: string,
    customerNumber: string,
  ): Promise<{ customerNumber: string; accountName: string | null; verified: boolean }> {
    this.assertEnabled();
    const res = (await this.post<Record<string, unknown>>(PATH_DANA_ACCOUNT_INQUIRY, {
      partnerReferenceNo,
      customerNumber,
      amount: { value: toDanaAmount(0), currency: 'IDR' },
      transactionDate: jakartaTimestamp(),
      additionalInfo: { fundType: 'AGENT_TOPUP_FOR_USER_SETTLE' },
    })) as Record<string, any>;
    const responseCode = String(res.responseCode ?? '');
    const accountName = res.customerName ?? res.accountName ?? null;
    return {
      customerNumber,
      accountName: accountName ? String(accountName) : null,
      verified: responseCode.startsWith('200') && Boolean(accountName),
    };
  }

  /** Amount parser — re-export untuk kemudahan test. */
  parseAmount = parseDanaAmount;
}
