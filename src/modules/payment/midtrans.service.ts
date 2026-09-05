import {
  Injectable,
  Logger,
  OnModuleInit,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentMethod } from '@prisma/client';
import * as midtransClient from 'midtrans-client';
import { CircuitBreaker } from '../../common/utils/circuit-breaker';

/**
 * Narrow check for the circuit-breaker's `SERVICE_CIRCUIT_OPEN` rejection.
 * Replaces three sites that were doing `(error as any)?.response?.code` —
 * `as any` defeats `noImplicitAny` and `strictNullChecks` for the rest of
 * the catch block.
 */
function isCircuitOpenError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const response = (error as { response?: unknown }).response;
  if (!response || typeof response !== 'object') return false;
  return (response as { code?: unknown }).code === 'SERVICE_CIRCUIT_OPEN';
}

type MidtransRefundTransactionApi = {
  refund(
    orderId: string,
    parameter: { amount: number; refund_key: string; reason: string },
  ): Promise<Record<string, unknown>>;
};

export interface IrisBankAccountInquiry {
  accountName: string;
  accountNo: string;
  bankCode: string;
}

export interface MidtransChargeResult {
  statusCode: string;
  transactionId: string;
  orderId: string;
  paymentType: string;
  transactionStatus: string;
  grossAmount: string;
  vaNumber?: string;
  bankName?: string;
  qrString?: string;
  qrCodeUrl?: string;
  billKey?: string;
  billerCode?: string;
  paymentCode?: string;
  store?: string;
  actions?: Array<{ name: string; method: string; url: string }>;
  redirectUrl?: string;
  expiryTime?: string;
}

export interface ChargeParams {
  orderId: string;
  grossAmount: number;
  paymentMethod: PaymentMethod;
  userEmail: string;
  fullName: string;
  cardToken?: string;
}

@Injectable()
export class MidtransService implements OnModuleInit {
  private readonly logger = new Logger(MidtransService.name);
  private coreApi: midtransClient.CoreApi | undefined;
  private readonly circuitBreaker: CircuitBreaker;

  private readonly irisCircuitBreaker: CircuitBreaker;

  constructor(private configService: ConfigService) {
    this.circuitBreaker = new CircuitBreaker({
      name: 'MidtransCoreCircuitBreaker',
      failureThreshold: parseInt(process.env.MIDTRANS_CB_FAILURE_THRESHOLD || '5', 10),
      recoveryTimeMs: parseInt(process.env.MIDTRANS_CB_RECOVERY_MS || '30000', 10),
      halfOpenMaxAttempts: 1,
    });
    this.irisCircuitBreaker = new CircuitBreaker({
      name: 'MidtransIrisCircuitBreaker',
      failureThreshold: parseInt(process.env.MIDTRANS_IRIS_CB_FAILURE_THRESHOLD || '5', 10),
      recoveryTimeMs: parseInt(process.env.MIDTRANS_IRIS_CB_RECOVERY_MS || '30000', 10),
      halfOpenMaxAttempts: 1,
    });
  }

  async onModuleInit(): Promise<void> {
    this.initializeClients();
  }

  private initializeClients(): void {
    try {
      const serverKey = this.configService.get<string>('midtrans.serverKey') ?? '';
      const isProduction = this.configService.get<boolean>('midtrans.isProduction') ?? false;

      if (!serverKey) {
        throw new Error('MIDTRANS_SERVER_KEY is not configured');
      }

      this.coreApi = new midtransClient.CoreApi({
        isProduction,
        serverKey,
        clientKey: this.configService.get<string>('midtrans.clientKey'),
      });

      this.logger.log(`MidtransService initialized [${isProduction ? 'PRODUCTION' : 'SANDBOX'}]`);
    } catch (err) {
      this.logger.error(
        'Failed to initialize Midtrans client — service will operate in degraded mode. Payment operations will be unavailable until configuration is fixed.',
        err,
      );
      this.coreApi = undefined;
    }
  }

  async chargeTransaction(params: ChargeParams): Promise<MidtransChargeResult> {
    if (!this.coreApi) {
      throw new ServiceUnavailableException('Midtrans Core API client not initialized');
    }

    const parameter = this.buildChargeParameter(params);

    this.logger.log(
      `Core API charge: orderId=${params.orderId} method=${params.paymentMethod} amount=${params.grossAmount}`,
    );

    try {
      const raw = await this.circuitBreaker.execute(() => this.coreApi!.charge(parameter));
      return this.mapChargeResponse(raw, params.paymentMethod);
    } catch (error) {
      if (isCircuitOpenError(error)) {
        throw error;
      }
      this.logger.error(
        `Core API charge failed: orderId=${params.orderId}`,
        error instanceof Error ? error.stack : error,
      );
      throw new ServiceUnavailableException({
        code: 'PAYMENT_CHARGE_FAILED',
        message: 'Payment processing failed. Please try again later.',
      });
    }
  }

  private buildChargeParameter(params: ChargeParams): Record<string, unknown> {
    const { orderId, grossAmount, paymentMethod, userEmail, fullName } = params;
    const notificationUrl = this.configService.get<string>('midtrans.notificationUrl');
    const expiryDuration = this.configService.get<number>('app.topupExpiryHours') ?? 24;

    const base: Record<string, unknown> = {
      transaction_details: {
        order_id: orderId,
        gross_amount: grossAmount,
      },
      customer_details: {
        email: userEmail,
        first_name: fullName,
      },
      custom_expiry: {
        expiry_duration: expiryDuration * 60,
        unit: 'minute',
      },
    };

    if (notificationUrl) {
      (base as Record<string, unknown>)['notification_url'] = notificationUrl;
    }

    switch (paymentMethod) {
      case PaymentMethod.VIRTUAL_ACCOUNT_BCA:
        return { ...base, payment_type: 'bank_transfer', bank_transfer: { bank: 'bca' } };

      case PaymentMethod.VIRTUAL_ACCOUNT_BNI:
        return { ...base, payment_type: 'bank_transfer', bank_transfer: { bank: 'bni' } };

      case PaymentMethod.VIRTUAL_ACCOUNT_BRI:
        return { ...base, payment_type: 'bank_transfer', bank_transfer: { bank: 'bri' } };

      case PaymentMethod.VIRTUAL_ACCOUNT_CIMB:
        return { ...base, payment_type: 'bank_transfer', bank_transfer: { bank: 'cimb' } };

      case PaymentMethod.VIRTUAL_ACCOUNT_PERMATA:
        return { ...base, payment_type: 'bank_transfer', bank_transfer: { bank: 'permata' } };

      case PaymentMethod.VIRTUAL_ACCOUNT_MANDIRI:
        return {
          ...base,
          payment_type: 'echannel',
          echannel: {
            bill_info1: 'Payment:',
            bill_info2: `Topup ${orderId}`,
          },
        };

      case PaymentMethod.QRIS:
        return { ...base, payment_type: 'qris' };

      case PaymentMethod.GOPAY:
        return {
          ...base,
          payment_type: 'gopay',
          gopay: {
            enable_callback: true,
            callback_url:
              this.configService.get<string>('midtrans.callbackUrl') ?? 'https://kahade.id',
          },
        };

      case PaymentMethod.SHOPEEPAY:
        return {
          ...base,
          payment_type: 'shopeepay',
          shopeepay: {
            callback_url:
              this.configService.get<string>('midtrans.callbackUrl') ?? 'https://kahade.id',
          },
        };

      case PaymentMethod.CREDIT_CARD:
        if (!params.cardToken) {
          throw new BadRequestException({
            code: 'CARD_TOKEN_REQUIRED',
            message: 'Card token is required for credit card payment',
          });
        }
        return {
          ...base,
          payment_type: 'credit_card',
          credit_card: {
            token_id: params.cardToken,
            authentication: true,
          },
        };

      case PaymentMethod.ALFAMART:
        return { ...base, payment_type: 'cstore', cstore: { store: 'alfamart' } };

      case PaymentMethod.INDOMARET:
        return { ...base, payment_type: 'cstore', cstore: { store: 'indomaret' } };

      case PaymentMethod.AKULAKU:
        return { ...base, payment_type: 'akulaku' };

      case PaymentMethod.KREDIVO:
        return {
          ...base,
          payment_type: 'kredivo',
          kredivo: {
            payment_type: '30_days',
            items: [
              {
                id: orderId,
                name: 'Wallet Top-up',
                price: grossAmount,
                quantity: 1,
              },
            ],
          },
        };

      default:
        throw new BadRequestException('Unsupported payment method');
    }
  }

  private mapChargeResponse(
    raw: Record<string, unknown>,
    method: PaymentMethod,
  ): MidtransChargeResult {
    const result: MidtransChargeResult = {
      statusCode: String(raw['status_code'] ?? ''),
      transactionId: String(raw['transaction_id'] ?? ''),
      orderId: String(raw['order_id'] ?? ''),
      paymentType: String(raw['payment_type'] ?? ''),
      transactionStatus: String(raw['transaction_status'] ?? ''),
      grossAmount: String(raw['gross_amount'] ?? ''),
      expiryTime: raw['expiry_time'] ? String(raw['expiry_time']) : undefined,
    };

    const vaNumbers = raw['va_numbers'] as Array<{ va_number: string; bank: string }> | undefined;
    if (vaNumbers && vaNumbers.length > 0) {
      result.vaNumber = vaNumbers[0].va_number;
      result.bankName = vaNumbers[0].bank;
    }

    if (raw['permata_va_number']) {
      result.vaNumber = String(raw['permata_va_number']);
      result.bankName = 'permata';
    }

    if (raw['bill_key']) {
      result.billKey = String(raw['bill_key']);
      result.billerCode = String(raw['biller_code'] ?? '');
    }

    const actions = raw['actions'] as
      | Array<{ name: string; method: string; url: string }>
      | undefined;
    if (actions && actions.length > 0) {
      result.actions = actions;

      if (method === PaymentMethod.QRIS) {
        const generateQr = actions.find(a => a.name === 'generate-qr-code');
        if (generateQr) {
          result.qrCodeUrl = generateQr.url;
          result.qrString = generateQr.url;
        }
      }
    }

    if (raw['redirect_url']) {
      result.redirectUrl = String(raw['redirect_url']);
    }

    const paymentCode = raw['payment_code'] as string | undefined;
    if (paymentCode) {
      result.paymentCode = paymentCode;
      result.store = raw['store'] as string | undefined;
    }

    return result;
  }

  async getTransactionStatus(orderId: string): Promise<Record<string, unknown>> {
    if (!this.coreApi) {
      throw new ServiceUnavailableException('Midtrans Core API client not initialized');
    }
    try {
      return await this.circuitBreaker.execute(() => this.coreApi!.transaction.status(orderId));
    } catch (error) {
      if (isCircuitOpenError(error)) {
        throw error;
      }
      this.logger.error(
        `Failed to get transaction status: orderId=${orderId}`,
        error instanceof Error ? error.stack : error,
      );
      throw new ServiceUnavailableException({
        code: 'PAYMENT_STATUS_UNAVAILABLE',
        message: 'Unable to retrieve payment status. Please try again later.',
      });
    }
  }

  async cancelTransaction(orderId: string): Promise<Record<string, unknown>> {
    if (!this.coreApi) {
      throw new Error('Midtrans Core API client not initialized');
    }
    try {
      const result = await this.circuitBreaker.execute(() =>
        this.coreApi!.cancelTransaction(orderId),
      );
      this.logger.log(`Transaction cancelled via Midtrans: orderId=${orderId}`);
      return result as Record<string, unknown>;
    } catch (error) {
      if (isCircuitOpenError(error)) {
        throw error;
      }
      this.logger.error(
        `Failed to cancel transaction: orderId=${orderId}`,
        error instanceof Error ? error.stack : error,
      );
      throw error;
    }
  }

  async refundTransaction(
    orderId: string,
    amount: number,
    refundKey: string,
    reason: string,
  ): Promise<Record<string, unknown>> {
    if (!this.coreApi) {
      throw new Error('Midtrans Core API client not initialized');
    }

    try {
      const transactionApi = this.coreApi!.transaction as typeof this.coreApi.transaction &
        MidtransRefundTransactionApi;
      const result = await this.circuitBreaker.execute(() =>
        transactionApi.refund(orderId, {
          amount,
          refund_key: refundKey,
          reason,
        }),
      );
      this.logger.log(
        `Transaction refund requested via Midtrans: orderId=${orderId}, refundKey=${refundKey}`,
      );
      return result as Record<string, unknown>;
    } catch (error) {
      if (isCircuitOpenError(error)) {
        throw error;
      }
      this.logger.error(
        `Failed to request transaction refund: orderId=${orderId}`,
        error instanceof Error ? error.stack : error,
      );
      throw error;
    }
  }

  private getIrisBaseUrl(): string {
    return this.configService.get<boolean>('midtrans.irisIsProduction')
      ? 'https://app.midtrans.com/iris'
      : 'https://app.sandbox.midtrans.com/iris';
  }

  /**
   * [CRY-023] Iris API key is transmitted as HTTP Basic Auth (Base64-encoded).
   * All Iris API URLs use HTTPS (enforced by getIrisBaseUrl), ensuring the
   * key is protected by TLS in transit.
   */
  private getIrisAuthorization(): string {
    const irisKey = this.configService.get<string>('midtrans.irisKey');
    if (!irisKey) {
      throw new Error('MIDTRANS_IRIS_KEY is not configured');
    }
    return Buffer.from(`${irisKey}:`).toString('base64');
  }

  async inquireBankAccount(
    bankCode: string,
    accountNumber: string,
  ): Promise<IrisBankAccountInquiry> {
    return this.irisCircuitBreaker.execute(async () => {
      const irisBaseUrl = this.getIrisBaseUrl();
      const authorization = this.getIrisAuthorization();

      const params = new URLSearchParams({ bank: bankCode, account: accountNumber });
      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort(), 15000);

      let response: Response;
      try {
        response = await fetch(`${irisBaseUrl}/api/v1/account_validation?${params.toString()}`, {
          method: 'GET',
          headers: { Authorization: `Basic ${authorization}` },
          signal: abortController.signal,
        });
      } catch (err) {
        clearTimeout(timeout);
        this.logger.error(`Iris account inquiry network error: ${(err as Error).message}`);
        throw new ServiceUnavailableException({
          code: 'BANK_VERIFICATION_UNAVAILABLE',
          message: 'Bank account verification service is temporarily unavailable',
        });
      } finally {
        clearTimeout(timeout);
      }

      if (response.status === 404 || response.status === 400) {
        throw new BadRequestException({
          code: 'BANK_ACCOUNT_NOT_FOUND',
          message: 'Bank account not found or invalid',
        });
      }

      if (!response.ok) {
        this.logger.error(`Iris account inquiry failed [${response.status}] for bank=${bankCode}`);
        throw new ServiceUnavailableException({
          code: 'BANK_VERIFICATION_UNAVAILABLE',
          message: 'Bank account verification service is temporarily unavailable',
        });
      }

      const body = (await response.json()) as Record<string, unknown>;
      const accountName = body['account_name'] as string | undefined;
      const accountNo = body['account_no'] as string | undefined;

      if (!accountName || !accountNo) {
        throw new BadRequestException({
          code: 'BANK_ACCOUNT_NOT_FOUND',
          message: 'Bank account not found or invalid',
        });
      }

      return {
        accountName,
        accountNo,
        bankCode,
      };
    });
  }

  async createIrisPayout(params: {
    referenceNo: string;
    beneficiaryName: string;
    beneficiaryAccount: string;
    beneficiaryBank: string;
    beneficiaryEmail?: string;
    amount: number;
  }): Promise<void> {
    return this.irisCircuitBreaker.execute(async () => {
      const irisBaseUrl = this.getIrisBaseUrl();
      const authorization = this.getIrisAuthorization();

      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort(), 30000);

      let response: Response;
      try {
        response = await fetch(`${irisBaseUrl}/api/v1/payouts`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Basic ${authorization}`,
            'X-Idempotency-Key': params.referenceNo,
          },
          body: JSON.stringify({
            payouts: [
              {
                beneficiary_name: params.beneficiaryName,
                beneficiary_account: params.beneficiaryAccount,
                beneficiary_bank: params.beneficiaryBank,
                beneficiary_email: params.beneficiaryEmail || undefined,
                amount: String(params.amount),
                notes: `Withdrawal ${params.referenceNo}`,
              },
            ],
          }),
          signal: abortController.signal,
        });
      } catch (err) {
        clearTimeout(timeout);
        if ((err as Error).name === 'AbortError') {
          this.logger.warn(
            `Iris payout timed out for reference: ${params.referenceNo} — checking status before marking failed`,
          );
          try {
            const statusResult = await this.getIrisPayoutStatus(params.referenceNo);
            const acceptableStatuses = ['queued', 'processed', 'completed', 'processing'];
            if (acceptableStatuses.includes(statusResult.status)) {
              this.logger.log(
                `Iris payout confirmed via status check: referenceNo=${params.referenceNo} status=${statusResult.status}`,
              );
              return;
            }
          } catch (statusErr) {
            this.logger.error(
              `Iris payout status check also failed for reference: ${params.referenceNo}: ${(statusErr as Error).message}`,
            );
          }
          throw new ServiceUnavailableException({
            code: 'IRIS_PAYOUT_TIMEOUT',
            message: 'Payout request timed out. Please check the status later.',
          });
        }
        this.logger.error(
          `Iris payout network error for reference: ${params.referenceNo}: ${(err as Error).message}`,
        );
        throw new ServiceUnavailableException({
          code: 'IRIS_PAYOUT_NETWORK_ERROR',
          message: 'Payout service is temporarily unavailable. Please try again later.',
        });
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        await response.text().catch(() => undefined);
        this.logger.error(
          `Iris payout failed [${response.status}]. Reference: ${params.referenceNo}. Provider response body omitted to protect beneficiary data.`,
        );
        throw new ServiceUnavailableException({
          code: 'IRIS_PAYOUT_FAILED',
          message: 'Payout processing failed. Please try again later.',
        });
      }

      let responseBody: Record<string, unknown>;
      try {
        responseBody = (await response.json()) as Record<string, unknown>;
      } catch {
        this.logger.error(`Iris payout response not valid JSON. Reference: ${params.referenceNo}`);
        throw new ServiceUnavailableException({
          code: 'IRIS_PAYOUT_INVALID_RESPONSE',
          message: 'Payout service returned an invalid response. Please try again later.',
        });
      }

      const payouts = responseBody['payouts'] as Array<Record<string, unknown>> | undefined;
      if (!payouts || payouts.length === 0) {
        this.logger.error(
          `Iris payout response missing payouts array. Reference: ${params.referenceNo}. Provider response body omitted to protect beneficiary data.`,
        );
        throw new ServiceUnavailableException({
          code: 'IRIS_PAYOUT_EMPTY_RESPONSE',
          message: 'Payout service returned an incomplete response. Please try again later.',
        });
      }

      const returnedReference = String(
        payouts[0]['reference_no'] ?? payouts[0]['referenceNo'] ?? '',
      );
      if (returnedReference !== params.referenceNo) {
        this.logger.error(
          `Iris payout response reference mismatch. Reference: ${params.referenceNo}`,
        );
        throw new ServiceUnavailableException({
          code: 'IRIS_PAYOUT_REFERENCE_MISMATCH',
          message:
            'Payout provider returned an unexpected reference. Please check the status later.',
        });
      }
      const payoutStatus = String(payouts[0]['status'] ?? '').toLowerCase();
      const acceptableStatuses = ['queued', 'processed', 'completed', 'processing'];
      if (!acceptableStatuses.includes(payoutStatus)) {
        this.logger.error(
          `Iris payout unexpected status. Reference: ${params.referenceNo}. Status: ${payoutStatus}. Provider response body omitted to protect beneficiary data.`,
        );
        throw new ServiceUnavailableException({
          code: 'IRIS_PAYOUT_UNEXPECTED_STATUS',
          message: 'Payout returned an unexpected status. Please contact support.',
        });
      }

      this.logger.log(
        `Iris payout initiated: referenceNo=${params.referenceNo} amount=${params.amount} status=${payoutStatus}`,
      );
    });
  }

  async getIrisPayoutStatus(referenceNo: string): Promise<{ status: string; referenceNo: string }> {
    return this.irisCircuitBreaker.execute(async () => {
      const irisBaseUrl = this.getIrisBaseUrl();
      const authorization = this.getIrisAuthorization();

      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort(), 15000);

      let response: Response;
      try {
        response = await fetch(
          `${irisBaseUrl}/api/v1/payouts?reference_no=${encodeURIComponent(referenceNo)}`,
          {
            method: 'GET',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Basic ${authorization}`,
            },
            signal: abortController.signal,
          },
        );
      } catch (err) {
        clearTimeout(timeout);
        this.logger.error(
          `Iris payout status check network error for reference: ${referenceNo}: ${(err as Error).message}`,
        );
        throw new ServiceUnavailableException({
          code: 'IRIS_PAYOUT_STATUS_UNAVAILABLE',
          message: 'Unable to retrieve payout status. Please try again later.',
        });
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        this.logger.error(
          `Iris payout status check failed [${response.status}] for reference: ${referenceNo}`,
        );
        throw new ServiceUnavailableException({
          code: 'IRIS_PAYOUT_STATUS_UNAVAILABLE',
          message: 'Unable to retrieve payout status. Please try again later.',
        });
      }

      let body: Record<string, unknown>;
      try {
        body = (await response.json()) as Record<string, unknown>;
      } catch {
        this.logger.error(
          `Iris payout status response not valid JSON for reference: ${referenceNo}`,
        );
        throw new ServiceUnavailableException({
          code: 'IRIS_PAYOUT_STATUS_INVALID',
          message: 'Unable to parse payout status response. Please try again later.',
        });
      }

      const payouts = body['payouts'] as Array<Record<string, unknown>> | undefined;
      const payout = payouts?.find(
        candidate =>
          String(candidate['reference_no'] ?? candidate['referenceNo'] ?? '') === referenceNo,
      );
      if (!payout) {
        return { status: 'not_found', referenceNo };
      }

      return {
        status: String(payout['status'] ?? 'unknown').toLowerCase(),
        referenceNo,
      };
    });
  }
}
