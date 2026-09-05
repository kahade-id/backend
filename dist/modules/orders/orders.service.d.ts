import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { RealtimeService } from '../realtime/realtime.service';
import { FeeCalculatorService } from './fee-calculator.service';
import { OrderStatus, FeeResponsibility, OrderType } from '@prisma/client';
import { NotificationQueueService } from '../queue/notification-queue.service';
export declare class OrdersService {
    private prisma;
    private redis;
    private realtime;
    private feeCalculator;
    private configService;
    private notificationQueue;
    private readonly logger;
    private readonly configuredMinOrderValue;
    private readonly configuredMaxOrderValue;
    constructor(prisma: PrismaService, redis: RedisService, realtime: RealtimeService, feeCalculator: FeeCalculatorService, configService: ConfigService, notificationQueue: NotificationQueueService);
    private isRetryableDbError;
    private withSerializableRetry;
    private enqueueOrderNotificationBestEffort;
    private runRealtimeBestEffort;
    createOrder(userId: string, dto: {
        role: 'BUYER' | 'SELLER';
        counterpartUsername: string;
        title: string;
        description: string;
        orderType: OrderType;
        orderValue: number;
        deliveryDeadlineDays: number;
        feeResponsibility: FeeResponsibility;
        voucherCode?: string;
    }): Promise<{
        orderId: string;
        status: OrderStatus;
        feeCalculation: {
            feeRate: number;
            feeAmount: number;
            buyerFeeAmount: number;
            sellerFeeAmount: number;
            buyerPayAmount: number;
            sellerReceiveAmount: number;
            voucherDiscount: number;
        };
        confirmationDeadlineAt: Date | null;
    }>;
    private isOrderNotificationEnabled;
    private escapePushBody;
    private static readonly ACTIVE_STATUSES;
    getOrders(userId: string, page: number, limit: number, status?: OrderStatus, role?: 'BUYER' | 'SELLER' | 'ALL', search?: string): Promise<{
        orders: {
            orderId: string;
            orderNumber: string;
            title: string;
            description: string;
            status: OrderStatus;
            orderType: OrderType;
            orderValue: number;
            buyerPayAmount: number;
            sellerReceiveAmount: number;
            buyer: {
                userId: string;
                username: string | null;
                fullName: string | null;
                avatarUrl: string | null;
            };
            seller: {
                userId: string;
                username: string | null;
                fullName: string | null;
                avatarUrl: string | null;
            };
            role: 'BUYER' | 'SELLER';
            createdAt: Date;
        }[];
        total: number;
        page: number;
        limit: number;
    }>;
    getOrderDetail(userId: string, orderId: string): Promise<{
        order: object;
    }>;
    getOrderSummary(userId: string): Promise<{
        asBuyer: {
            count: number;
            totalValue: number;
        };
        asSeller: {
            count: number;
            totalValue: number;
        };
        inDispute: number;
        pendingExtensions: number;
    }>;
    calculateFee(dto: {
        orderValue: number;
        feeResponsibility: FeeResponsibility;
        voucherCode?: string;
        role?: 'BUYER' | 'SELLER';
    }, userId: string): Promise<{
        feeRate: number;
        feeAmount: number;
        buyerFeeAmount: number;
        sellerFeeAmount: number;
        buyerPayAmount: number;
        sellerReceiveAmount: number;
        voucherDiscount: number;
        isKahadePlusApplied: boolean;
    }>;
    private getNextOrderSerial;
    validateCounterpart(userId: string, counterpartUsername: string): Promise<{
        user: {
            username: string | null;
            fullName: string | null;
            avatarUrl: string | null;
            isKycVerified: boolean;
            membershipRank: string;
            avgRating: unknown;
        } | null;
        isBlocked: boolean;
        canCreateOrder: boolean;
        reason?: string;
    }>;
    processOrder(orderId: string, sellerId: string): Promise<{
        orderId: string;
        status: string;
    }>;
    updateShipping(orderId: string, sellerId: string, dto: {
        trackingNumber?: string;
        courierName?: string;
        trackingNotes?: string;
    }): Promise<{
        orderId: string;
        trackingNumber: string | null;
        courierName: string | null;
    }>;
    getOrderHistory(orderId: string, userId: string, page?: number, limit?: number): Promise<{
        data: object[];
        total: number;
        page: number;
        limit: number;
        totalPages: number;
    }>;
    getAverageDurations(): Promise<Record<string, number>>;
}
