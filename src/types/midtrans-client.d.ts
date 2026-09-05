declare module 'midtrans-client' {
  interface SnapOptions {
    isProduction: boolean;
    serverKey: string;
    clientKey?: string;
  }

  interface CoreApiOptions {
    isProduction: boolean;
    serverKey: string;
    clientKey?: string;
  }

  interface IrisOptions {
    isProduction: boolean;
    serverKey: string;
  }

  interface TransactionDetail {
    order_id: string;
    gross_amount: number;
  }

  interface CustomerDetail {
    email?: string;
    first_name?: string;
    last_name?: string;
  }

  interface SnapParameter {
    transaction_details: TransactionDetail;
    customer_details?: CustomerDetail;
    [key: string]: unknown;
  }

  interface SnapResponse {
    token: string;
    redirect_url: string;
  }

  interface IrisPayoutBeneficiary {
    name: string;
    account: string;
    bank: string;
    alias_name: string;
    amount: string;
    notes?: string;
  }

  interface IrisCreatePayoutRequest {
    payouts: IrisPayoutBeneficiary[];
  }

  interface IrisApprovePayoutRequest {
    id: string;
    otp: string;
  }

  class Snap {
    constructor(options: SnapOptions);
    createTransaction(parameter: SnapParameter): Promise<SnapResponse>;
    createTransactionToken(parameter: SnapParameter): Promise<string>;
    createTransactionRedirectUrl(parameter: SnapParameter): Promise<string>;
  }

  class CoreApi {
    constructor(options: CoreApiOptions);
    charge(parameter: Record<string, unknown>): Promise<Record<string, unknown>>;
    capture(parameter: Record<string, unknown>): Promise<Record<string, unknown>>;
    refund(orderId: string, parameter?: Record<string, unknown>): Promise<Record<string, unknown>>;
    cancelTransaction(orderId: string): Promise<Record<string, unknown>>;
    getTransactionStatus(orderId: string): Promise<Record<string, unknown>>;
    getTransactionStatusB2b(orderId: string, parameter?: Record<string, unknown>): Promise<Record<string, unknown>>;
    transaction: {
      status(orderId: string): Promise<Record<string, unknown>>;
    };
  }

  class Iris {
    constructor(options: IrisOptions);
    createPayouts(parameter: IrisCreatePayoutRequest): Promise<Record<string, unknown>>;
    approvePayouts(parameter: IrisApprovePayoutRequest): Promise<Record<string, unknown>>;
    getPayoutDetails(referenceNo: string): Promise<Record<string, unknown>>;
    validateBankAccount(bank: string, account: string): Promise<Record<string, unknown>>;
    ping(): Promise<string>;
  }
}
