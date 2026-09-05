import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { WalletService } from '../wallet/wallet.service';
import { ReferralService } from '../referral/referral.service';
import { RealtimeService } from '../realtime/realtime.service';
import { MembershipRankService } from './membership-rank.service';
import { WalletTxSerialService } from '../../common/services/wallet-tx-serial.service';
import { FeeCalculatorService } from './fee-calculator.service';
import { NotificationQueueService } from '../queue/notification-queue.service';
import { OrderQrisPaymentService } from '../payment/order-qris-payment.service';
export interface ConfirmOrderResult {
    orderId: string;
    status: 'WAITING_PAYMENT' | 'CANCELLED';
}
export interface PayOrderResult {
    orderId: string;
    status: 'PROCESSING';
    walletTxId: string;
}
export interface CancelOrderResult {
    orderId: string;
    status: 'CANCELLED';
}
export interface CompleteOrderResult {
    orderId: string;
    status: 'COMPLETED';
}
export declare class OrderStateService {
    private prisma;
    private redis;
    private walletService;
    private orderQrisPaymentService;
    private walletTxSerialService;
    private referralService;
    private feeCalculator;
    private realtime;
    private membershipRankService;
    private notificationQueue;
    private readonly logger;
    constructor(prisma: PrismaService, redis: RedisService, walletService: WalletService, orderQrisPaymentService: OrderQrisPaymentService, walletTxSerialService: WalletTxSerialService, referralService: ReferralService, feeCalculator: FeeCalculatorService, realtime: RealtimeService, membershipRankService: MembershipRankService, notificationQueue: NotificationQueueService);
    private validateTransition;
    private runPostCommitBestEffort;
    private runRealtimeBestEffort;
    private withSerializableRetry;
    handleConfirmAction(orderId: string, userId: string, action: 'ACCEPT' | 'REJECT', reason?: string): Promise<ConfirmOrderResult>;
    handlePayOrder(orderId: string, userId: string, pin?: string, ip?: string): Promise<PayOrderResult>;
    handleCompleteOrder(orderId: string, userId: string): Promise<CompleteOrderResult>;
    handleCancelOrder(orderId: string, userId: string, reason: string, note?: string): Promise<CancelOrderResult>;
    confirmOrder(orderId: string, userId: string): Promise<void>;
    rejectOrder(orderId: string, userId: string, reason?: string): Promise<void>;
    payOrder(orderId: string, buyerId: string): Promise<{
        walletTxId: string;
    }>;
    completeOrder(orderId: string, buyerId: string, deliveryProofId?: string): Promise<void>;
    private isRetryableDbError;
    cancelOrder(orderId: string, userId: string, reason: string, note?: string): Promise<void>;
    adminCancelOrder(orderId: string, adminId: string, reason: string): Promise<void>;
    private getNextWalletTxSerial;
}
