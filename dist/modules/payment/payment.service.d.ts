import { ConfigService } from '@nestjs/config';
import { WalletService } from '../wallet/wallet.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { MidtransNotificationDto } from './dto/midtrans-notification.dto';
import { OrderQrisPaymentService } from './order-qris-payment.service';
export interface WebhookResult {
    message: string;
}
export declare class PaymentService {
    private configService;
    private walletService;
    private orderQrisPaymentService;
    private prismaService;
    private redisService;
    private readonly logger;
    constructor(configService: ConfigService, walletService: WalletService, orderQrisPaymentService: OrderQrisPaymentService, prismaService: PrismaService, redisService: RedisService);
    handleMidtransWebhook(notification: MidtransNotificationDto, sourceIp: string): Promise<WebhookResult>;
    verifyMidtransSignature(orderId: string, statusCode: string, grossAmount: string, incomingSignatureKey: string): boolean;
    isValidMidtransSourceIp(ip: string): boolean;
    private expandIPv6;
    private ipv6ToBits;
}
