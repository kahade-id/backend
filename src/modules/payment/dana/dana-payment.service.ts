import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError } from 'axios';
import {
  DANA_PAY_METHOD,
  DANA_PAY_OPTION_QRIS,
  DanaCreateOrderParams,
  DanaCreatedOrder,
  DanaOrderDetail,
  DanaOrderStatus,
  DanaRefundParams,
  DanaRefundResult,
} from './dana.types';
import {
  buildDanaHeaders,
  jakartaTimestamp,
  signSnapRequest,
} from './dana-snap.util';

/**
 * DANA Enterprise — Gapura Payment Gateway (Create Order dkk).
 *
 * Provider UTAMA uang masuk Kahade (keputusan produk 2026-09-29):
 * QRIS untuk bayar escrow + top-up, Virtual Account untuk top-up,
 * BALANCE sebagai kanal bayar pakai saldo DANA.
 *
 * Kontrak API (docs https://dashboard.dana.id/api-docs-v2/):
 *   Create Order: POST /payment-gateway/v1.0/debit/payment-host-to-host.htm (SNAP 54)
 *   Query:        POST /payment-gateway/v1.0/debit/status.htm
 *   Refund:       POST /payment-gateway/v1.0/debit/refund.htm
 *   Cancel:       POST /payment-gateway/v1.0/debit/cancel.htm
 *
 * Untuk QRIS/VA, respons berisi payment code / QR string
 * (additionalInfo.paymentCode) — BUKAN checkout URL.
 * Idempotency di sisi DANA: merchantId + partnerReferenceNo.
 *
 * SANDBOX DULU: base URL + kredensial dari config 'dana'.
 * Fail-closed: bila kredensial belum di-set, semua operasi melempar
 * ServiceUnavailableException (tidak ada degradasi diam-diam).
 */

const PATH_CREATE_ORDER = '/payment-gateway/v1.0/debit/payment-host-to-host.htm';
const PATH_QUERY = '/payment-gateway/v1.0/debit/status.htm';
const PATH_REFUND = '/payment-gateway/v1.0/debit/refund.htm';
const PATH_CANCEL = '/payment-gateway/v1.0/debit/cancel.htm';

/** latestTransactionStatus → status internal. */
export function mapDanaTxStatus(code: string | undefined | null): DanaOrderStatus {
  switch ((code ?? '').trim()) {
    case '00':
      return 'SUCCESS';
    case '01':
    case '02':
      return 'PENDING';
    case '05':
      return 'EXPIRED';
    case '07':
      return 'UNKNOWN';
    default:
      return 'UNKNOWN';
  }
}

/** "15000.00" — format amount DANA (2 desimal). */
export function toDanaAmount(idr: number): string {
  if (!Number.isFinite(idr) || idr < 0) {
    throw new BadRequestException({ code: 'DANA_INVALID_AMOUNT', message: 'Invalid amount' });
  }
  return `${Math.round(idr)}.00`;
}

/** Parse "15000.00" → 15000 (null bila tak terparse). */
export function parseDanaAmount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.round(n);
  }
  return null;
}

@Injectable()
export class DanaPaymentService {
  private readonly logger = new Logger(DanaPaymentService.name);

  constructor(private readonly config: ConfigService) {}

  private cfg() {
    return {
      baseUrl: this.config.get<string>('dana.baseUrl') ?? '',
      partnerId: this.config.get<string>('dana.partnerId') ?? '',
      privateKey: this.config.get<string>('dana.privateKey') ?? '',
      merchantId: this.config.get<string>('dana.merchantId') ?? '',
      origin: this.config.get<string>('dana.origin') ?? '',
      channelId: this.config.get<string>('dana.channelId') ?? '95221',
      externalStoreId: this.config.get<string>('dana.externalStoreId') ?? '',
      webhookUrl: this.config.get<string>('dana.webhookUrl') ?? '',
      debug: this.config.get<boolean>('dana.debug') ?? false,
      orderExpiryMinutes: this.config.get<number>('dana.orderExpiryMinutes') ?? 30,
    };
  }

  /** true bila kredensial lengkap — semua operasi fail-closed bila false. */
  get enabled(): boolean {
    const c = this.cfg();
    return Boolean(c.baseUrl && c.partnerId && c.privateKey && c.merchantId);
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
        timeout: 15000,
      });
      return res.data;
    } catch (e) {
      const err = e as AxiosError<{ responseMessage?: string }>;
      const detail = err.response?.data?.responseMessage ?? err.message;
      this.logger.error(`DANA POST ${resourcePath} gagal: ${detail}`);
      throw new ServiceUnavailableException({
        code: 'DANA_API_ERROR',
        message: `DANA API error: ${detail}`,
      });
    }
  }

  /**
   * Buat order pembayaran.
   *
   * QRIS: payMethod NETWORK_PAY + payOption NETWORK_PAY_PG_QRIS,
   *   externalStoreId WAJIB, partnerReferenceNo maks 25 char.
   * VA: payMethod VIRTUAL_ACCOUNT + payOption VIRTUAL_ACCOUNT_<BANK>
   *   (DANA auto-generate payment code).
   * BALANCE: payMethod BALANCE.
   */
  async createOrder(params: DanaCreateOrderParams): Promise<DanaCreatedOrder> {
    this.assertEnabled();
    const c = this.cfg();
    const amount = toDanaAmount(params.amountIdr);
    const expiryMinutes = Math.min(params.expiryMinutes ?? c.orderExpiryMinutes, 30);
    const validUpTo = jakartaTimestamp(new Date(Date.now() + expiryMinutes * 60_000));

    let payMethod: string;
    let payOption: string;
    let externalStoreId: string | undefined;
    if (params.kind === 'QRIS') {
      if (params.partnerReferenceNo.length > 25) {
        throw new BadRequestException({
          code: 'DANA_QRIS_REF_TOO_LONG',
          message: 'partnerReferenceNo untuk QRIS maksimal 25 karakter',
        });
      }
      if (!c.externalStoreId) {
        throw new ServiceUnavailableException({
          code: 'DANA_STORE_ID_REQUIRED',
          message: 'DANA_EXTERNAL_STORE_ID belum di-set (wajib untuk QRIS)',
        });
      }
      payMethod = DANA_PAY_METHOD.QRIS;
      payOption = DANA_PAY_OPTION_QRIS;
      externalStoreId = c.externalStoreId;
    } else if (params.kind === 'VA') {
      const bank = (params.bankCode ?? '').toUpperCase().replace(/[^A-Z]/g, '');
      if (!bank) {
        throw new BadRequestException({
          code: 'DANA_VA_BANK_REQUIRED',
          message: 'bankCode wajib untuk Virtual Account',
        });
      }
      payMethod = DANA_PAY_METHOD.VA;
      payOption = `VIRTUAL_ACCOUNT_${bank}`;
    } else {
      payMethod = DANA_PAY_METHOD.BALANCE;
      payOption = '';
    }

    const body: Record<string, unknown> = {
      partnerReferenceNo: params.partnerReferenceNo,
      merchantId: c.merchantId,
      amount: { value: amount, currency: 'IDR' },
      ...(externalStoreId ? { externalStoreId } : {}),
      validUpTo,
      urlParams: [
        { url: c.webhookUrl, type: 'NOTIFICATION', isDeeplink: 'Y' },
        { url: c.webhookUrl, type: 'PAY_RETURN', isDeeplink: 'Y' },
      ],
      payOptionDetails: [
        {
          payMethod,
          payOption,
          transAmount: { value: amount, currency: 'IDR' },
        },
      ],
      additionalInfo: {
        order: {
          orderTitle: params.orderTitle ?? 'Kahade Payment',
          scenario: 'API',
          // DANA menandai buyer sebagai Required — object kosong {} bila tidak ada.
          buyer: params.buyerExternalUserId ? { externalUserId: params.buyerExternalUserId } : {},
        },
        // Wajib menurut fixture resmi DANA — create order kena 4005401
        // Invalid Field Format tanpa field-field ini (terbukti di E2E sandbox 2026-09-29).
        mcc: '5732',
        envInfo: { sourcePlatform: 'IPG', terminalType: 'SYSTEM', orderTerminalType: 'WEB' },
      },
    };

    const res = (await this.post<Record<string, unknown>>(PATH_CREATE_ORDER, body)) as Record<string, any>;
    const responseCode = String(res.responseCode ?? '');
    if (!responseCode.startsWith('200')) {
      throw new ServiceUnavailableException({
        code: 'DANA_CREATE_ORDER_FAILED',
        message: `DANA create order gagal: ${res.responseMessage ?? responseCode}`,
      });
    }
    const additionalInfo = (res.additionalInfo ?? {}) as Record<string, any>;
    return {
      partnerReferenceNo: params.partnerReferenceNo,
      referenceNo: String(res.referenceNo ?? ''),
      paymentCode: String(additionalInfo.paymentCode ?? ''),
      webRedirectUrl: res.webRedirectUrl ? String(res.webRedirectUrl) : undefined,
      amountIdr: params.amountIdr,
      expiresAt: new Date(Date.now() + expiryMinutes * 60_000),
    };
  }

  /** Detail + status order — dipakai verify-via-API sebelum settlement. */
  async getPaymentDetail(partnerReferenceNo: string): Promise<DanaOrderDetail> {
    this.assertEnabled();
    const c = this.cfg();
    const res = (await this.post<Record<string, unknown>>(PATH_QUERY, {
      originalPartnerReferenceNo: partnerReferenceNo,
      originalReferenceNo: null,
      serviceCode: '54',
      merchantId: c.merchantId,
    })) as Record<string, any>;
    const responseCode = String(res.responseCode ?? '');
    if (!responseCode.startsWith('200')) {
      return {
        status: 'UNKNOWN',
        amountIdr: null,
        referenceNo: '',
        partnerReferenceNo,
      };
    }
    const amountObj = (res.transAmount ?? res.amount ?? {}) as Record<string, unknown>;
    return {
      status: mapDanaTxStatus(res.latestTransactionStatus),
      amountIdr: parseDanaAmount(amountObj.value),
      referenceNo: String(res.originalReferenceNo ?? ''),
      partnerReferenceNo: String(res.originalPartnerReferenceNo ?? partnerReferenceNo),
    };
  }

  /** Refund order yang sudah sukses (masuk ke saldo DANA pembayar / VA). */
  async refundOrder(params: DanaRefundParams): Promise<DanaRefundResult> {
    this.assertEnabled();
    const c = this.cfg();
    const res = (await this.post<Record<string, unknown>>(PATH_REFUND, {
      merchantId: c.merchantId,
      subMerchantId: '',
      originalPartnerReferenceNo: params.partnerReferenceNo,
      originalReferenceNo: '',
      originalExternalId: '',
      partnerRefundNo: params.partnerRefundNo,
      refundAmount: { value: toDanaAmount(params.amountIdr), currency: 'IDR' },
      externalStoreId: '',
      reason: params.reason ?? 'Customer request',
      additionalInfo: {},
    })) as Record<string, any>;
    const responseCode = String(res.responseCode ?? '');
    if (!responseCode.startsWith('200')) {
      throw new ServiceUnavailableException({
        code: 'DANA_REFUND_FAILED',
        message: `DANA refund gagal: ${res.responseMessage ?? responseCode}`,
      });
    }
    return {
      partnerRefundNo: params.partnerRefundNo,
      referenceNo: String(res.refundNo ?? res.originalReferenceNo ?? ''),
      status: mapDanaTxStatus('00'),
    };
  }

  /** Batalkan order yang belum dibayar. */
  async cancelOrder(partnerReferenceNo: string, reason = 'Cancelled by merchant'): Promise<void> {
    this.assertEnabled();
    const c = this.cfg();
    const res = (await this.post<Record<string, unknown>>(PATH_CANCEL, {
      originalPartnerReferenceNo: partnerReferenceNo,
      originalReferenceNo: '',
      originalExternalId: '',
      merchantId: c.merchantId,
      subMerchantId: '',
      reason,
      externalStoreId: '',
      additionalInfo: {},
    })) as Record<string, any>;
    const responseCode = String(res.responseCode ?? '');
    if (!responseCode.startsWith('200')) {
      throw new ServiceUnavailableException({
        code: 'DANA_CANCEL_FAILED',
        message: `DANA cancel gagal: ${res.responseMessage ?? responseCode}`,
      });
    }
  }
}
