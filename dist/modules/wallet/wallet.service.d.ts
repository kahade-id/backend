import { OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { RealtimeService } from '../realtime/realtime.service';
import { PaymentMethod, PaymentStatus } from '@prisma/client';
import { WalletTxSerialService } from '../../common/services/wallet-tx-serial.service';
import { AuditLogService } from '../../common/services/audit-log.service';
import { PaginatedResponse } from '../../common/dto/pagination.dto';
import { MidtransService } from '../payment/midtrans.service';
import { OtpService } from '../auth/otp.service';
import { Queue } from 'bull';
import { EmailJobData } from '../queue/processors/email.processor';
interface WalletSummary {
    availableBalance: number;
    escrowBalance: number;
    totalBalance: number;
    todayTopupAmount: number;
    todayWithdrawAmount: number;
    todayTransferAmount: number;
    dailyTopupLimit: number;
    dailyWithdrawLimit: number;
    dailyTransferLimit: number;
    kycFreeLimit: number;
    hasPin: boolean;
    isLocked: boolean;
    lockReason: string | null;
}
interface TransactionSummary {
    id: string;
    txId: string;
    type: string;
    status: string;
    amount: number;
    description: string | null;
    balanceBefore: number;
    balanceAfter: number;
    createdAt: Date;
    order: {
        orderId: string;
        title: string;
    } | null;
}
export declare class WalletService implements OnModuleInit {
    private prisma;
    private redis;
    private configService;
    private walletTxSerialService;
    private auditLog;
    private midtransService;
    private otpService;
    private realtime;
    private readonly emailQueue;
    private readonly logger;
    private readonly dailyTopupLimit;
    private readonly dailyWithdrawLimit;
    private readonly minWithdraw;
    private readonly maxWithdrawPerTx;
    private readonly topupExpiryHours;
    private readonly walletPinPepper;
    private dummyPinHash;
    private readonly paymentFees;
    constructor(prisma: PrismaService, redis: RedisService, configService: ConfigService, walletTxSerialService: WalletTxSerialService, auditLog: AuditLogService, midtransService: MidtransService, otpService: OtpService, realtime: RealtimeService, emailQueue: Queue<EmailJobData>);
    onModuleInit(): Promise<void>;
    getWallet(userId: string): Promise<WalletSummary>;
    getTransactions(userId: string, page: number, limit: number, type?: string, from?: string, to?: string): Promise<PaginatedResponse<TransactionSummary>>;
    getTransactionDetail(userId: string, txId: string): Promise<Record<string, unknown>>;
    private static percentToBps;
    private static feeFromBps;
    private calculatePaymentFee;
    getTopupStatus(userId: string, paymentTxId: string): Promise<{
        status: PaymentStatus;
        txId: string;
        amount: number;
    }>;
    topup(userId: string, amount: number, method: PaymentMethod, cardToken?: string): Promise<Record<string, unknown>>;
    private checkPinIpRateLimit;
    private incrementPinIpAttempts;
    private getDummyPinHash;
    private verifyWalletPin;
    withdraw(userId: string, amount: number, bankAccountId: string, pin: string, ip?: string): Promise<Record<string, unknown>>;
    cancelPendingWithdrawal(userId: string, txId: string): Promise<{
        message: string;
    }>;
    transfer(senderId: string, recipientId: string, amount: number, pin: string, note?: string, ip?: string): Promise<Record<string, unknown>>;
    lookupTransferRecipient(query: string, senderId: string): Promise<Record<string, unknown> | null>;
    lockEscrowForOrder(walletId: string, amount: bigint, orderId: string): Promise<string>;
    releaseEscrow(fromWalletId: string, toWalletId: string, amount: bigint, orderId: string): Promise<void>;
    handleTopupSuccess(midtransOrderId: string, webhookGrossAmount?: string): Promise<void>;
    private reconcileDailyTopups;
    private parseProviderAmountToSen;
    handleTopupFailure(midtransOrderId: string, _reason?: string, reversal?: {
        refundAmount?: string;
        refundReference?: string;
    }): Promise<void>;
    confirmWithdrawOtp(userId: string, txId: string, otpCode: string): Promise<Record<string, unknown>>;
    resendWithdrawOtp(userId: string, txId: string, ipAddress?: string): Promise<Record<string, unknown>>;
    private validatePinPolicy;
    setPin(userId: string, pin: string, currentPin?: string, password?: string, ip?: string): Promise<{
        message: string;
    }>;
    verifyPin(userId: string, pin: string, ip?: string): Promise<{
        valid: boolean;
    }>;
    private paymentMethodsCache;
    private readonly PAYMENT_METHODS_CACHE_TTL;
    getPaymentMethods(): Record<string, unknown>;
    private getHeldEscrowReleaseAmount;
    private runRealtimeBestEffort;
    private withWalletSerializableRetry;
    private isRetryableDbError;
    private getNextWalletTxSerial;
    private getNextPaymentSerial;
}
export {};
