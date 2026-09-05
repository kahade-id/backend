import { OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentMethod } from '@prisma/client';
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
    actions?: Array<{
        name: string;
        method: string;
        url: string;
    }>;
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
export declare class MidtransService implements OnModuleInit {
    private configService;
    private readonly logger;
    private coreApi;
    private readonly circuitBreaker;
    private readonly irisCircuitBreaker;
    constructor(configService: ConfigService);
    onModuleInit(): Promise<void>;
    private initializeClients;
    chargeTransaction(params: ChargeParams): Promise<MidtransChargeResult>;
    private buildChargeParameter;
    private mapChargeResponse;
    getTransactionStatus(orderId: string): Promise<Record<string, unknown>>;
    cancelTransaction(orderId: string): Promise<Record<string, unknown>>;
    refundTransaction(orderId: string, amount: number, refundKey: string, reason: string): Promise<Record<string, unknown>>;
    private getIrisBaseUrl;
    private getIrisAuthorization;
    inquireBankAccount(bankCode: string, accountNumber: string): Promise<IrisBankAccountInquiry>;
    createIrisPayout(params: {
        referenceNo: string;
        beneficiaryName: string;
        beneficiaryAccount: string;
        beneficiaryBank: string;
        beneficiaryEmail?: string;
        amount: number;
    }): Promise<void>;
    getIrisPayoutStatus(referenceNo: string): Promise<{
        status: string;
        referenceNo: string;
    }>;
}
